import { useCallback, useEffect, useState } from 'react';
import { getBackend } from '../lib/backend';
import {
  ADAPTER_LABELS,
  EFFORT_LEVELS,
  MODEL_PRESETS,
  mergeModelSuggestions,
  WELL_KNOWN_ROLES,
  createDefaultProfile,
  effectiveExecutable,
  effortLabel,
  hasFullAccess,
  permissionDefaultLabel,
  permissionLevelLabel,
  permissionLevels,
  validateProfile,
  withAppDefault,
  type AdapterKind,
  type AgentProfile,
  type AgentSkillInfo,
  type AppPermissionDefault,
  type PermissionLevel,
  type WorkingDirMode,
} from '../lib/agents';
import { DirPicker } from './DirPicker';
import { ToolRulesField } from './ToolRulesField';
import { confirmDialog } from './ConfirmDialog';
import { useAppStore } from '../store';
import { CloseButton } from './CloseButton';
import { Modal } from './Modal';
import { Notice, useNoticeMessage } from './Notice';
import { FormError, useSubmitValidation } from './FormValidation';
import { errorMessage } from '../lib/errors';
import { LinesTextarea } from './DraftText';

function emptyForm(adapter: AdapterKind): AgentProfile {
  return createDefaultProfile(adapter);
}

export function AgentsView(): React.JSX.Element {
  const profiles = useAppStore((s) => s.profiles);
  const appDefault = useAppStore((s) => s.agentPermissionDefault);
  const adapters = useAppStore((s) => s.adapters);
  const tools = useAppStore((s) => s.tools);
  const knownFolders = useAppStore((s) => s.knownFolders);
  const refreshProfiles = useAppStore((s) => s.refreshProfiles);
  const refreshTools = useAppStore((s) => s.refreshTools);

  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [message, setMessage, messageVariant, messageEvent] = useNoticeMessage();
  const [testResult, setTestResult, testVariant, testEvent] = useNoticeMessage();
  const [newAdapter, setNewAdapter] = useState<AdapterKind>('claude');
  const [customModels, setCustomModels] = useState<Record<AdapterKind, string[]>>({
    claude: [],
    codex: [],
    custom: [],
  });

  const reloadCustomModels = useCallback((): void => {
    for (const adapter of ['claude', 'codex', 'custom'] as AdapterKind[]) {
      void getBackend()
        .listCustomModels(adapter)
        .then((models) => {
          setCustomModels((prev) => ({ ...prev, [adapter]: models }));
        })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    reloadCustomModels();
  }, [reloadCustomModels]);

  const toolById = (id: string): boolean => tools.some((t) => t.id === id && t.installed);

  const save = (profile: AgentProfile): void => {
    const errors = validateProfile(profile);
    if (errors.length > 0) {
      setMessage(errors[0] ?? 'Invalid profile.', 'error');
      return;
    }
    const before = profiles.find((p) => p.id === profile.id);
    if (
      profile.permissionLevel === 'fullAccess' &&
      before?.permissionLevel !== 'fullAccess'
    ) {
      void confirmDialog({
        title: `Give '${profile.name}' full access?`,
        message: `${ADAPTER_LABELS[profile.adapter]} will skip every permission check for runs with this profile: it can run any command, change any file and call any MCP tool without asking. Schedules that use it need the trusted opt-in.`,
        confirmLabel: 'Allow full access',
        danger: true,
      }).then((ok) => {
        if (ok) persist(profile);
      });
      return;
    }
    persist(profile);
  };

  const persist = (profile: AgentProfile): void => {
    // Observe role-default changes for memory suggestions: if this profile
    // takes over a role from another profile, that is a repeated-edit signal.
    const previous = profiles.find((p) => p.role === profile.role && p.id !== profile.id);
    const initialRole = editing?.role;
    void getBackend()
      .saveAgentProfile(profile)
      .then(() => refreshProfiles())
      .then(() => {
        setEditing(null);
        setMessage(`Saved profile '${profile.name}'.`);
        if (
          profile.role !== undefined &&
          profile.role !== '' &&
          profile.role !== initialRole
        ) {
          void getBackend()
            .observeEdits([
              {
                scope: '*',
                field: `${profile.role}Profile`,
                from: previous?.id ?? initialRole ?? '',
                to: profile.id,
              },
            ])
            .then((suggestions) => {
              if (suggestions.length > 0) {
                setMessage(
                  `Saved. Orchevia suggests a new preference — see Memory (${suggestions[0]?.key ?? ''}).`,
                );
              }
            })
            .catch(() => {});
        }
      })
      .catch((err: unknown) => {
        setMessage(errorMessage(err), 'error');
      });
  };

  const remove = (id: string, name: string): void => {
    void confirmDialog({
      title: `Delete Agent Profile '${name}'?`,
      message: 'Workflows referencing it will fail validation until remapped.',
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      return getBackend()
        .deleteAgentProfile(id)
        .then(() => refreshProfiles())
        .then(() => {
          setMessage(`Deleted profile '${name}'.`);
        })
        .catch((err: unknown) => {
          setMessage(errorMessage(err), 'error');
        });
    });
  };

  const addCustomModel = (adapter: AdapterKind, name: string): void => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    const current = customModels[adapter];
    if (current.some((m) => m.toLowerCase() === trimmed.toLowerCase())) return;
    void getBackend()
      .saveCustomModels(adapter, [...current, trimmed])
      .then((models) => {
        setCustomModels((prev) => ({ ...prev, [adapter]: models }));
      })
      .catch((err: unknown) => {
        setMessage(errorMessage(err), 'error');
      });
  };

  const removeCustomModel = (adapter: AdapterKind, name: string): void => {
    void getBackend()
      .saveCustomModels(
        adapter,
        customModels[adapter].filter((m) => m !== name),
      )
      .then((models) => {
        setCustomModels((prev) => ({ ...prev, [adapter]: models }));
      })
      .catch((err: unknown) => {
        setMessage(errorMessage(err), 'error');
      });
  };

  const test = (id: string): void => {
    setTestResult('Testing…');
    void getBackend()
      .testAgentProfile(id)
      .then((status) => {
        setTestResult(
          status.installed
            ? `Found ${status.path ?? ''} ${status.version ?? ''}`.trim()
            : 'CLI not found in your login shell PATH or common install locations. Install/authenticate it yourself or set its full path; the profile is kept and shows unavailable.',
          status.installed ? 'info' : 'warn',
        );
      })
      .catch((err: unknown) => {
        setTestResult(errorMessage(err), 'error');
      });
  };

  return (
    <>
      <div className="topbar">
        <h1>Agents</h1>
        <span className="topbar-sub">
          Local AI CLIs via Agent Profiles — no provider API keys in Orchevia.
        </span>
        <div className="topbar-actions">
          <select
            className="input"
            aria-label="Adapter for new profile"
            value={newAdapter}
            onChange={(e) => {
              setNewAdapter(e.target.value as AdapterKind);
            }}
            style={{ width: 'auto' }}
          >
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="custom">Custom CLI</option>
          </select>
          <button
            className="btn btn-primary"
            onClick={() => {
              setEditing(emptyForm(newAdapter));
              setMessage(null);
            }}
          >
            + New profile
          </button>
          <button
            className="btn"
            onClick={() => {
              void Promise.all([refreshProfiles(), refreshTools()]);
              reloadCustomModels();
            }}
          >
            Refresh
          </button>
        </div>
      </div>
      <div className="view">
        {message !== null && (
          <Notice
            variant={messageVariant}
            eventId={messageEvent}
            style={{ marginBottom: 12 }}
            onDismiss={() => {
              setMessage(null);
            }}
          >
            <span>{message}</span>{' '}
          </Notice>
        )}
        <Notice inline style={{ marginBottom: 16 }}>
          Orchevia delegates AI work to CLIs you installed and authenticated yourself (
          {adapters.length > 0
            ? adapters
                .map((a) => a.defaultExecutable)
                .filter((e) => e !== '')
                .join(', ')
            : 'claude, codex'}
          ). Those tools may contact their own providers with prompt and repository
          content. Orchevia itself stores only profile configuration — never credentials —
          and never runs an agent until you press ▶ Run.
        </Notice>

        {adapters.length > 0 && (
          <section aria-label="Detected adapters" style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 14 }}>Detected AI CLIs</h2>
            <div className="tool-grid">
              {adapters.map((a) => {
                const installed = toolById(a.id);
                return (
                  <div key={a.id} className="tool-card">
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                      }}
                    >
                      <h3 style={{ margin: 0 }}>{a.displayName}</h3>
                      <span
                        className={`status-pill ${installed ? 'status-succeeded' : 'status-cancelled'}`}
                      >
                        {installed ? 'Installed' : 'Not found'}
                      </span>
                    </div>
                    <p className="field-hint" style={{ marginBottom: 0 }}>
                      {a.notes}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <ModelCatalog
          customModels={customModels}
          onAdd={addCustomModel}
          onRemove={removeCustomModel}
        />

        {profiles.length === 0 && editing === null && (
          <div className="empty-state">
            <h2>No Agent Profiles yet</h2>
            <p>
              Create one for Claude Code and one for Codex — e.g. “Claude —
              Implementation” and “Codex — Deep Review” — then reference them from AI
              Agent nodes. Using another coding CLI? Choose “Custom CLI” and point it at
              the binary.
            </p>
          </div>
        )}

        <div className="tool-grid">
          {profiles.map((p) => {
            // Custom CLIs have no PATH entry to check: availability is proven
            // with Test (which resolves the explicit path + fallbacks).
            const installed = p.adapter === 'custom' ? null : toolById(p.adapter);
            const statusClass =
              installed === null
                ? 'status-paused'
                : installed
                  ? 'status-succeeded'
                  : 'status-cancelled';
            const statusText =
              installed === null
                ? 'Manual path — press Test'
                : installed
                  ? 'Available'
                  : 'Unavailable';
            return (
              <div key={p.id} className="tool-card profile-card">
                <div className="profile-head">
                  <div>
                    <h3 style={{ margin: 0 }}>{p.name}</h3>
                    <div className="profile-sub">
                      {ADAPTER_LABELS[p.adapter]}
                      {p.role !== undefined && p.role !== '' && ` · ${p.role} role`}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span
                      className={`status-pill ${statusClass}`}
                      title={effectiveExecutable(p)}
                    >
                      {statusText}
                    </span>
                    <button
                      className="btn btn-ghost"
                      style={{ padding: '4px 10px' }}
                      title={`Delete profile '${p.name}'`}
                      aria-label={`Delete profile '${p.name}'`}
                      onClick={() => void remove(p.id, p.name)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <dl className="profile-facts">
                  <div>
                    <dt>Model</dt>
                    <dd>{(p.model ?? '').trim() !== '' ? (p.model as string) : '—'}</dd>
                  </div>
                  <div>
                    <dt>Effort</dt>
                    <dd>{effortLabel(p)}</dd>
                  </div>
                  <div>
                    <dt>Skills</dt>
                    <dd>
                      {(p.skills ?? []).length > 0 ? p.skills?.join(', ') : 'CLI chooses'}
                    </dd>
                  </div>
                  <div>
                    <dt>Directory</dt>
                    <dd>
                      {p.workingDirMode === 'profile' &&
                      (p.workingDir ?? '').trim() !== ''
                        ? (p.workingDir as string)
                        : p.workingDirMode === 'profile'
                          ? '—'
                          : p.workingDirMode === 'node'
                            ? 'Per workflow node'
                            : 'App directory'}
                    </dd>
                  </div>
                  <div>
                    <dt>Timeout</dt>
                    <dd>{p.defaultTimeoutSecs}s</dd>
                  </div>
                  {p.adapter !== 'custom' && (
                    <div>
                      <dt>Permissions</dt>
                      <dd
                        className={
                          hasFullAccess(withAppDefault(p, appDefault))
                            ? 'profile-fact-risk'
                            : undefined
                        }
                        title={
                          p.permissionLevel === 'allowedTools'
                            ? (p.allowedTools ?? []).join('\n')
                            : permissionLevelLabel(
                                p.adapter,
                                p.permissionLevel,
                                appDefault,
                              )
                        }
                      >
                        {p.permissionLevel === 'allowedTools'
                          ? `Allowed tools (${String((p.allowedTools ?? []).length)})`
                          : p.permissionLevel === 'fullAccess'
                            ? 'Full access'
                            : p.permissionLevel === 'cliSettings'
                              ? 'CLI settings'
                              : `App default · ${withAppDefault(p, appDefault).permissionLevel === 'fullAccess' ? 'Full access' : 'CLI settings'}`}
                      </dd>
                    </div>
                  )}
                </dl>
                <div className="profile-actions">
                  <button
                    className="btn"
                    onClick={() =>
                      setEditing({
                        ...p,
                        extraArgs: [...p.extraArgs],
                        skills: [...(p.skills ?? [])],
                        ...(p.allowedTools === undefined
                          ? {}
                          : { allowedTools: [...p.allowedTools] }),
                      })
                    }
                  >
                    Edit
                  </button>
                  <button className="btn btn-ghost" onClick={() => void test(p.id)}>
                    Test
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {testResult !== null && (
          <Notice
            variant={testVariant}
            eventId={testEvent}
            onDismiss={() => setTestResult(null)}
          >
            {testResult}
          </Notice>
        )}

        {knownFolders.length > 0 && (
          <section aria-label="Recent project folders" style={{ marginTop: 20 }}>
            <h2 style={{ fontSize: 14 }}>Recent project folders (local only)</h2>
            <ul>
              {knownFolders.map((f) => (
                <li key={f} className="tool-version">
                  {f}
                </li>
              ))}
            </ul>
          </section>
        )}

        {editing !== null && (
          <Modal
            label={editing.name === '' ? 'New agent profile' : 'Edit agent profile'}
            onClose={() => {
              setEditing(null);
            }}
            closeLabel="Close profile editor"
            onBackdrop={() => {
              setEditing(null);
            }}
          >
            <div>
              <ProfileEditor
                initial={editing}
                customModels={customModels}
                onCancel={() => {
                  setEditing(null);
                }}
                onSave={(p) => void save(p)}
              />
            </div>
          </Modal>
        )}
      </div>
    </>
  );
}

function ModelCatalog({
  customModels,
  onAdd,
  onRemove,
}: {
  customModels: Record<AdapterKind, string[]>;
  onAdd: (adapter: AdapterKind, name: string) => void;
  onRemove: (adapter: AdapterKind, name: string) => void;
}): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<AdapterKind, string>>({
    claude: '',
    codex: '',
    custom: '',
  });
  const submit = (adapter: AdapterKind): void => {
    onAdd(adapter, drafts[adapter]);
    setDrafts((prev) => ({ ...prev, [adapter]: '' }));
  };
  return (
    <section aria-label="Known models" style={{ marginBottom: 20 }}>
      <h2 style={{ fontSize: 14 }}>Known models</h2>
      <p className="field-hint" style={{ maxWidth: 720 }}>
        Add any model name your CLI supports. Saved names appear as suggestions in every
        profile editor; availability depends on your CLI and account.
      </p>
      <div className="tool-grid">
        {(['claude', 'codex', 'custom'] as AdapterKind[]).map((adapter) => (
          <div key={adapter} className="tool-card">
            <h3 style={{ margin: 0 }}>{ADAPTER_LABELS[adapter]}</h3>
            <div
              style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}
              aria-label={`Known ${ADAPTER_LABELS[adapter]} models`}
            >
              {MODEL_PRESETS[adapter].map((m) => (
                <span
                  key={m}
                  className="status-pill status-cancelled"
                  title="Built-in suggestion"
                >
                  {m}
                </span>
              ))}
              {customModels[adapter].map((m) => (
                <span
                  key={m}
                  className="status-pill status-succeeded"
                  title="Your addition — click ✕ to remove"
                >
                  {m}{' '}
                  <CloseButton
                    variant="ghost"
                    label={`Remove model '${m}'`}
                    style={{ padding: '0 4px' }}
                    onClose={() => {
                      onRemove(adapter, m);
                    }}
                  />
                </span>
              ))}
              {MODEL_PRESETS[adapter].length === 0 &&
                customModels[adapter].length === 0 && (
                  <span className="field-hint">
                    No suggestions — type any model name.
                  </span>
                )}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="input"
                value={drafts[adapter]}
                placeholder="Add model name, e.g. gpt-6-turbo"
                aria-label={`Add ${ADAPTER_LABELS[adapter]} model`}
                onChange={(e) => {
                  const value = e.target.value;
                  setDrafts((prev) => ({ ...prev, [adapter]: value }));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit(adapter);
                }}
              />
              <button
                className="btn"
                disabled={drafts[adapter].trim() === ''}
                onClick={() => {
                  submit(adapter);
                }}
              >
                Add
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProfileEditor({
  initial,
  customModels,
  onCancel,
  onSave,
}: {
  initial: AgentProfile;
  customModels: Record<AdapterKind, string[]>;
  onCancel: () => void;
  onSave: (p: AgentProfile) => void;
}): React.JSX.Element {
  const appDefault = useAppStore((s) => s.agentPermissionDefault);
  const [form, setForm] = useState<AgentProfile>(initial);
  const [skillsResult, setSkillsResult] = useState<{
    adapter: AdapterKind;
    directory: string | undefined;
    skills: AgentSkillInfo[];
    error: string | null;
  } | null>(null);
  const [manualSkill, setManualSkill] = useState('');
  const skillDirectory = form.workingDirMode === 'profile' ? form.workingDir : undefined;
  const currentSkills =
    skillsResult?.adapter === form.adapter && skillsResult.directory === skillDirectory
      ? skillsResult
      : null;
  const availableSkills = currentSkills?.skills ?? [];
  const skillsLoading = currentSkills === null;
  const skillsError = currentSkills?.error ?? null;
  useEffect(() => {
    let active = true;
    void getBackend()
      .listAgentSkills(form.adapter, skillDirectory)
      .then((skills) => {
        if (active) {
          setSkillsResult({
            adapter: form.adapter,
            directory: skillDirectory,
            skills,
            error: null,
          });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setSkillsResult({
            adapter: form.adapter,
            directory: skillDirectory,
            skills: [],
            error: errorMessage(error),
          });
        }
      });
    return () => {
      active = false;
    };
  }, [form.adapter, skillDirectory]);
  const validation = useSubmitValidation(validateProfile(form));
  const suggestions = mergeModelSuggestions(
    MODEL_PRESETS[form.adapter],
    customModels[form.adapter],
  );
  const set = (patch: Partial<AgentProfile>): void => {
    setForm((f) => ({ ...f, ...patch }));
  };
  const addSkill = (name: string): void => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    setForm((current) => {
      const existing = current.skills ?? [];
      return existing.some((skill) => skill.toLowerCase() === trimmed.toLowerCase())
        ? current
        : { ...current, skills: [...existing, trimmed] };
    });
    setManualSkill('');
  };

  return (
    <div aria-label="Profile editor">
      <h3 style={{ marginTop: 0, paddingRight: 40 }}>
        {initial.name === '' ? 'New profile' : 'Edit profile'}
      </h3>
      <div className="field">
        <label className="field-label" htmlFor="prof-name">
          Name
        </label>
        <input
          id="prof-name"
          className="input"
          value={form.name}
          onChange={(e) => {
            set({ name: e.target.value });
          }}
          placeholder="Claude — Implementation"
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="field">
          <label className="field-label" htmlFor="prof-adapter">
            Provider / CLI
          </label>
          <select
            id="prof-adapter"
            className="input"
            value={form.adapter}
            onChange={(e) => {
              const adapter = e.target.value as AdapterKind;
              const level = form.permissionLevel ?? 'appDefault';
              set({
                adapter,
                skills: [],
                // Keep only what the new CLI can express (agents.rs validation).
                permissionLevel: permissionLevels(adapter).includes(level)
                  ? level
                  : 'appDefault',
                allowedTools: adapter === 'claude' ? form.allowedTools : undefined,
              });
            }}
          >
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="custom">Custom CLI</option>
          </select>
          {form.adapter === 'custom' && (
            <span className="field-hint">
              Contract: your extra args first, prompt as the final argument, --model only
              when set. Effort is ignored (CLI default applies).
            </span>
          )}
        </div>
        <div className="field">
          <label className="field-label" htmlFor="prof-role">
            Role (default mapping)
          </label>
          <select
            id="prof-role"
            className="input"
            value={form.role ?? ''}
            onChange={(e) => {
              set({ role: e.target.value === '' ? undefined : e.target.value });
            }}
          >
            <option value="">— No default role —</option>
            {WELL_KNOWN_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="field">
          <label className="field-label" htmlFor="prof-exe">
            Executable{' '}
            {form.adapter === 'custom' ? '(required full path)' : '(blank = auto-detect)'}
          </label>
          <input
            id="prof-exe"
            className="input"
            value={form.executable ?? ''}
            onChange={(e) => {
              set({ executable: e.target.value === '' ? undefined : e.target.value });
            }}
            placeholder={
              form.adapter === 'claude'
                ? 'claude'
                : form.adapter === 'codex'
                  ? 'codex'
                  : '/home/user/.local/bin/aichat'
            }
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="prof-model">
            Model (adapter-specific, optional)
          </label>
          <input
            id="prof-model"
            className="input"
            list="orchevia-model-presets"
            value={form.model ?? ''}
            onChange={(e) => {
              set({ model: e.target.value === '' ? undefined : e.target.value });
            }}
            placeholder={
              form.adapter === 'claude'
                ? 'e.g. opus'
                : form.adapter === 'codex'
                  ? 'e.g. gpt-5.6-sol'
                  : 'e.g. provider-model (optional)'
            }
          />
          <datalist id="orchevia-model-presets">
            {suggestions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {suggestions.length > 0 && (
            <div
              style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}
              aria-label="Suggested models"
            >
              {suggestions.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`tool-chip${(form.model ?? '') === m ? ' selected' : ''}`}
                  title={`Use model '${m}'`}
                  onClick={() => {
                    set({ model: m });
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
          <span className="field-hint">
            Suggestions only — type any model your CLI accepts (names evolve; check{' '}
            <code>{form.adapter === 'custom' ? 'your CLI' : form.adapter} --help</code>{' '}
            for the current list). Blank means the CLI default.
          </span>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="prof-effort">
            Effort / reasoning (optional)
          </label>
          <select
            id="prof-effort"
            className="input"
            value={(form.effort ?? '').toLowerCase()}
            onChange={(e) => {
              set({ effort: e.target.value === '' ? undefined : e.target.value });
            }}
          >
            <option value="">— CLI default —</option>
            {EFFORT_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
          <span className="field-hint">
            Claude: adds --effort · Codex: sets model_reasoning_effort · Custom: ignored.
            Higher effort usually means slower, more thorough runs.
          </span>
        </div>
      </div>
      {form.adapter !== 'custom' && (
        <div className="field">
          <label className="field-label" htmlFor="prof-skill-name">
            Skills (optional)
          </label>
          <span className="field-hint">
            Selected skills run with every task using this profile. With none selected,
            {` ${ADAPTER_LABELS[form.adapter]}`} chooses normally. Only select skills you
            trust.
          </span>
          {(form.skills ?? []).length > 0 && (
            <div className="chip-list" aria-label="Selected skills">
              {(form.skills ?? []).map((name) => (
                <button
                  key={name}
                  type="button"
                  className="tool-chip selected"
                  title={`Remove ${name}`}
                  onClick={() =>
                    set({ skills: (form.skills ?? []).filter((skill) => skill !== name) })
                  }
                >
                  {name} · Remove
                </button>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id="prof-skill-name"
              className="input"
              value={manualSkill}
              onChange={(e) => setManualSkill(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addSkill(manualSkill);
                }
              }}
              placeholder={
                form.adapter === 'claude'
                  ? 'e.g. code-review or plugin:skill'
                  : 'e.g. review-pr'
              }
            />
            <button
              type="button"
              className="btn"
              onClick={() => addSkill(manualSkill)}
              disabled={manualSkill.trim() === ''}
            >
              Add skill
            </button>
          </div>
          {skillsLoading && <span className="field-hint">Looking for local skills…</span>}
          {skillsError !== null && (
            <span className="field-hint">Could not list skills: {skillsError}</span>
          )}
          {!skillsLoading &&
            skillsError === null &&
            (availableSkills.length > 0 ? (
              <div className="chip-list" aria-label="Discovered skills">
                {availableSkills.map((skill) => (
                  <button
                    key={skill.source}
                    type="button"
                    className={`tool-chip${(form.skills ?? []).includes(skill.name) ? ' selected' : ''}`}
                    title={`${skill.description || skill.name}\n${skill.source}`}
                    onClick={() => addSkill(skill.name)}
                  >
                    + {skill.name}
                  </button>
                ))}
              </div>
            ) : (
              <span className="field-hint">
                No file-backed skills found. You can enter a plugin, synced, or project
                skill name above.
              </span>
            ))}
          <span className="field-hint">
            Personal skills appear here. Choose a fixed profile directory to discover that
            repository’s skills; per-node repositories and plugin skills can be entered by
            name. Test a small workflow to confirm the CLI loads them.
          </span>
        </div>
      )}
      {form.adapter !== 'custom' && (
        <PermissionsEditor
          adapter={form.adapter}
          level={form.permissionLevel ?? 'appDefault'}
          appDefault={appDefault}
          allowedTools={form.allowedTools ?? []}
          onLevel={(permissionLevel) => {
            set({ permissionLevel });
          }}
          onTools={(allowedTools) => {
            set({ allowedTools: allowedTools.length > 0 ? allowedTools : undefined });
          }}
        />
      )}
      <div className="field">
        <label className="field-label" htmlFor="prof-args">
          Additional arguments (one per line, no secrets)
        </label>
        <LinesTextarea
          id="prof-args"
          rows={2}
          value={form.extraArgs}
          onChange={(extraArgs) => {
            set({ extraArgs });
          }}
          placeholder="--verbose"
        />
        <span className="field-hint">
          Passed verbatim as argv (no shell). Credential flags are rejected.
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <div className="field">
          <label className="field-label" htmlFor="prof-wdmode">
            Working directory mode
          </label>
          <select
            id="prof-wdmode"
            className="input"
            value={form.workingDirMode}
            onChange={(e) => {
              set({ workingDirMode: e.target.value as WorkingDirMode });
            }}
          >
            <option value="node">Per-node (from workflow)</option>
            <option value="profile">Fixed profile directory</option>
            <option value="inherit">Inherit app directory</option>
          </select>
        </div>
        <div
          style={
            form.workingDirMode !== 'profile'
              ? { opacity: 0.5, pointerEvents: 'none' }
              : undefined
          }
        >
          <DirPicker
            id="prof-wd"
            label="Profile directory"
            value={form.workingDir ?? ''}
            onChange={(v) => {
              set({ workingDir: v === '' ? undefined : v });
            }}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="prof-timeout">
            Default timeout in seconds (1–43200, default 3600 = 1 h)
          </label>
          <input
            id="prof-timeout"
            className="input"
            type="number"
            min={1}
            max={43200}
            value={form.defaultTimeoutSecs}
            onChange={(e) => {
              set({ defaultTimeoutSecs: Number(e.target.value) });
            }}
          />
        </div>
      </div>
      <FormError error={validation.error} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="btn btn-primary"
          onClick={() => validation.attempt(() => onSave(form))}
        >
          Save profile
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function permissionHint(
  level: PermissionLevel,
  cli: string,
  appDefault: AppPermissionDefault | null,
): React.ReactNode {
  if (level === 'appDefault')
    return `Follows Environment → Agent permissions, now ${permissionDefaultLabel(appDefault)}. Choose another level to give this profile its own.`;
  if (level === 'allowedTools')
    return (
      <>
        Passes <code>--allowedTools</code> with these rules. What the Claude Code settings
        already allow still applies. Orchevia never edits settings files.
      </>
    );
  return `No permission flag: ${cli} decides from its own settings. Headless runs cannot ask, so any tool those settings do not allow is refused and the step fails.`;
}

function PermissionsEditor({
  adapter,
  level,
  appDefault,
  allowedTools,
  onLevel,
  onTools,
}: {
  adapter: AdapterKind;
  level: PermissionLevel;
  appDefault: AppPermissionDefault | null;
  allowedTools: string[];
  onLevel: (level: PermissionLevel) => void;
  onTools: (tools: string[]) => void;
}): React.JSX.Element {
  const cli = ADAPTER_LABELS[adapter];
  return (
    <div className="field">
      <label className="field-label" htmlFor="prof-permissions">
        Permissions
      </label>
      <select
        id="prof-permissions"
        className="input"
        value={level}
        onChange={(e) => {
          onLevel(e.target.value as PermissionLevel);
        }}
      >
        {permissionLevels(adapter).map((option) => (
          <option key={option} value={option}>
            {permissionLevelLabel(adapter, option, appDefault)}
          </option>
        ))}
      </select>
      {level === 'fullAccess' ? (
        <Notice inline variant="warn" style={{ marginTop: 8 }}>
          Full access skips every permission check (
          <code>
            {adapter === 'codex'
              ? '--dangerously-bypass-approvals-and-sandbox'
              : '--permission-mode bypassPermissions'}
          </code>
          ): {cli} can run any command, change any file and call any MCP tool without
          asking. Use it only for repositories and tools you trust. Schedules that use
          this profile need the trusted opt-in.
        </Notice>
      ) : (
        <span className="field-hint">
          {permissionHint(level, cli, appDefault)}
          {adapter === 'codex' &&
            ' Codex has no tool allow-list, so only its settings or full access apply.'}
        </span>
      )}
      {adapter === 'claude' && level === 'allowedTools' && (
        <ToolRulesField
          id="prof-allowed-tools"
          label="Allowed tools (one per line)"
          value={allowedTools}
          onChange={onTools}
          placeholder={'Edit\nmcp__jira\nBash(git status *)'}
          hint="A tool (Edit, Write), an MCP server (mcp__server) or one of its tools, or a tool with a pattern such as Bash(git status *). Refused runs suggest the exact rules."
        />
      )}
    </div>
  );
}
