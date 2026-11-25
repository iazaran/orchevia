import { useCallback, useEffect, useState } from 'react';
import { getBackend } from '../lib/backend';
import {
  ADAPTER_LABELS,
  ADAPTER_KINDS,
  AGENT_INSTALL,
  AGENT_SIGN_IN,
  CUSTOM_CLI_PRESETS,
  profileFromPreset,
  supportsProfileControls,
  supportsEffort,
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
  resolveForRun,
  usesBrowser,
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
import { CopyButton } from './CopyButton';
import {
  SETUP_CHECK_COST_NOTE,
  SetupCheckResult,
  SetupCheckStatusLine,
  useSetupChecks,
} from './SetupCheck';

function emptyForm(adapter: AdapterKind): AgentProfile {
  return createDefaultProfile(adapter);
}

export function AgentsView(): React.JSX.Element {
  const profiles = useAppStore((s) => s.profiles);
  const appDefault = useAppStore((s) => s.agentPermissionDefault);
  const appAbilities = useAppStore((s) => s.agentAbilities);
  const adapters = useAppStore((s) => s.adapters);
  const tools = useAppStore((s) => s.tools);
  const knownFolders = useAppStore((s) => s.knownFolders);
  const refreshProfiles = useAppStore((s) => s.refreshProfiles);
  const refreshTools = useAppStore((s) => s.refreshTools);

  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [message, setMessage, messageVariant, messageEvent] = useNoticeMessage();
  const setupChecks = useSetupChecks();
  const [newAdapter, setNewAdapter] = useState<AdapterKind>('claude');
  const [customModels, setCustomModels] = useState<
    Partial<Record<AdapterKind, string[]>>
  >({});

  const reloadCustomModels = useCallback((): void => {
    for (const adapter of ADAPTER_KINDS) {
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

  /** Enabled schedules and watchers whose workflow has a step with this profile. */
  const automationsUsingProfile = (profileId: string): string[] => {
    const { schedules, watchers, workflows } = useAppStore.getState();
    return [...schedules, ...watchers]
      .filter((automation) => automation.enabled)
      .filter((automation) =>
        (
          workflows.find((w) => w.id === automation.workflowId)?.definition.nodes ?? []
        ).some(
          (node) => node.type === 'agent' && node.config.agentProfileId === profileId,
        ),
      )
      .map((automation) => automation.name);
  };

  const save = (profile: AgentProfile): void => {
    const errors = validateProfile(profile);
    if (errors.length > 0) {
      setMessage(errors[0] ?? 'Invalid profile.', 'error');
      return;
    }
    const before = profiles.find((p) => p.id === profile.id);
    const confirmations: { title: string; message: string; confirmLabel: string }[] = [];
    if (hasFullAccess(profile) && (before === undefined || !hasFullAccess(before)))
      confirmations.push({
        title: `Give '${profile.name}' full access?`,
        message: `${ADAPTER_LABELS[profile.adapter]} can run tools without asking under this configuration. Schedules that use it need the trusted opt-in.`,
        confirmLabel: 'Allow full access',
      });
    // Judged as runs resolve it, so --chrome among the extra arguments asks too.
    const browserNow = usesBrowser(resolveForRun(profile, appDefault, appAbilities));
    const browserBefore =
      before !== undefined &&
      usesBrowser(resolveForRun(before, appDefault, appAbilities));
    if (browserNow && !browserBefore) {
      const affected = automationsUsingProfile(profile.id);
      confirmations.push({
        title: `Let '${profile.name}' use your browser?`,
        message: `Its steps run Claude Code with Claude in Chrome: Claude can open pages and act in the browser you are signed in to, without asking.${
          affected.length > 0
            ? ` These enabled automations will use it too, unattended: ${affected.join(', ')}.`
            : ''
        }`,
        confirmLabel: 'Use my browser',
      });
    }
    void (async () => {
      for (const confirmation of confirmations)
        if (!(await confirmDialog({ ...confirmation, danger: true }))) return;
      persist(profile);
    })();
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
                  `Saved. Review the suggested preference in Playbooks (${suggestions[0]?.key ?? ''}).`,
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
    const current = customModels[adapter] ?? [];
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
        (customModels[adapter] ?? []).filter((m) => m !== name),
      )
      .then((models) => {
        setCustomModels((prev) => ({ ...prev, [adapter]: models }));
      })
      .catch((err: unknown) => {
        setMessage(errorMessage(err), 'error');
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
            {ADAPTER_KINDS.map((id) => (
              <option key={id} value={id}>
                {ADAPTER_LABELS[id]}
              </option>
            ))}
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

        <h2 className="section-title">Your agent profiles</h2>
        {profiles.length === 0 && editing === null && (
          <div className="empty-state">
            <h2>No Agent Profiles yet</h2>
            <p>
              Create a profile for a CLI you use, check its setup, then select it in an AI
              Agent step.
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
            const check = setupChecks.checks[p.id];
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
                  {p.adapter === 'claude' && (
                    <div>
                      <dt>Browser</dt>
                      <dd
                        className={
                          usesBrowser(resolveForRun(p, appDefault, appAbilities))
                            ? 'profile-fact-risk'
                            : undefined
                        }
                      >
                        {browserFact(p, appAbilities.browser)}
                      </dd>
                    </div>
                  )}
                  {supportsProfileControls(p.adapter) && (
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
                  <button
                    className="btn btn-ghost"
                    title={SETUP_CHECK_COST_NOTE}
                    disabled={check?.kind === 'running'}
                    onClick={() => void setupChecks.run([p.id])}
                  >
                    Check setup
                  </button>
                  {check !== undefined && <SetupCheckStatusLine state={check} />}
                </div>
                {check?.kind === 'done' && <SetupCheckResult report={check.report} />}
                {check?.kind === 'error' && <p className="field-hint">{check.message}</p>}
              </div>
            );
          })}
        </div>

        {adapters.length > 0 && (
          <section aria-label="Detected adapters">
            <h2 className="section-title">AI CLIs on this computer</h2>
            <div className="tool-grid">
              {adapters
                .filter(
                  (a): a is typeof a & { id: Exclude<AdapterKind, 'custom'> } =>
                    a.id !== 'custom',
                )
                .map((a) => {
                  const installed = toolById(a.id);
                  const version = tools.find((t) => t.id === a.id)?.version;
                  const count = profiles.filter((p) => p.adapter === a.id).length;
                  return (
                    <div key={a.id} className="tool-card cli-card">
                      <div className="cli-card-head">
                        <h3>{a.displayName}</h3>
                        <span
                          className={`status-pill ${installed ? 'status-succeeded' : 'status-cancelled'}`}
                        >
                          {installed ? 'Installed' : 'Not found'}
                        </span>
                      </div>
                      <p className="field-hint">{a.notes}</p>
                      {installed ? (
                        <p className="field-hint cli-card-meta">
                          {version !== undefined && <code>{version}</code>}{' '}
                          {AGENT_SIGN_IN[a.id]}
                        </p>
                      ) : (
                        <div className="install-line">
                          <code title={AGENT_INSTALL[a.id]}>{AGENT_INSTALL[a.id]}</code>
                          <CopyButton
                            className="btn btn-ghost btn-inline"
                            text={AGENT_INSTALL[a.id]}
                          />
                        </div>
                      )}
                      <div className="card-actions">
                        <button
                          className={`btn${installed && count === 0 ? ' btn-primary' : ''}`}
                          onClick={() => {
                            setEditing(emptyForm(a.id));
                            setMessage(null);
                          }}
                        >
                          {count === 0 ? 'Create profile' : 'Add another profile'}
                        </button>
                        {count > 0 && (
                          <span className="field-hint">
                            {String(count)} profile{count === 1 ? '' : 's'}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </section>
        )}

        <section aria-label="More coding CLIs">
          <h2 className="section-title">More coding CLIs</h2>
          <p className="field-hint section-hint">
            These run through the Custom CLI adapter: Orchevia passes the arguments below,
            then your prompt. Review the profile, save it, then use Check setup.
          </p>
          <div className="tool-grid">
            {CUSTOM_CLI_PRESETS.map((preset) => (
              <div key={preset.id} className="tool-card cli-card">
                <div className="cli-card-head">
                  <h3>{preset.name}</h3>
                  <span className="tag">Custom CLI</span>
                </div>
                <p className="field-hint">{preset.notes}</p>
                <code className="cli-command">
                  {[preset.executable, ...preset.extraArgs, '"<prompt>"'].join(' ')}
                </code>
                <div className="install-line">
                  <code title={preset.install}>{preset.install}</code>
                  <CopyButton
                    className="btn btn-ghost btn-inline"
                    text={preset.install}
                  />
                </div>
                <div className="card-actions">
                  <button
                    className="btn"
                    onClick={() => {
                      setEditing(profileFromPreset(preset));
                      setMessage(null);
                    }}
                  >
                    Set up {preset.name}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <details className="playbook-section">
          <summary>Known models</summary>
          <ModelCatalog
            customModels={customModels}
            onAdd={addCustomModel}
            onRemove={removeCustomModel}
          />
        </details>

        {knownFolders.length > 0 && (
          <section aria-label="Recent project folders" style={{ marginTop: 20 }}>
            <h2 className="section-title">Recent project folders (local only)</h2>
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
            label={
              profiles.some((p) => p.id === editing.id)
                ? 'Edit agent profile'
                : 'New agent profile'
            }
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
  customModels: Partial<Record<AdapterKind, string[]>>;
  onAdd: (adapter: AdapterKind, name: string) => void;
  onRemove: (adapter: AdapterKind, name: string) => void;
}): React.JSX.Element {
  const [drafts, setDrafts] = useState<Partial<Record<AdapterKind, string>>>({});
  const submit = (adapter: AdapterKind): void => {
    onAdd(adapter, drafts[adapter] ?? '');
    setDrafts((prev) => ({ ...prev, [adapter]: '' }));
  };
  return (
    <section aria-label="Known models">
      <p className="field-hint" style={{ maxWidth: 720 }}>
        Add any model name your CLI supports. Saved names appear as suggestions in every
        profile editor; availability depends on your CLI and account.
      </p>
      <div className="tool-grid">
        {ADAPTER_KINDS.map((adapter) => (
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
              {(customModels[adapter] ?? []).map((m) => (
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
                (customModels[adapter] ?? []).length === 0 && (
                  <span className="field-hint">
                    No suggestions — type any model name.
                  </span>
                )}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="input"
                value={drafts[adapter] ?? ''}
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
                disabled={(drafts[adapter] ?? '').trim() === ''}
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
  customModels: Partial<Record<AdapterKind, string[]>>;
  onCancel: () => void;
  onSave: (p: AgentProfile) => void;
}): React.JSX.Element {
  const appDefault = useAppStore((s) => s.agentPermissionDefault);
  const appAbilities = useAppStore((s) => s.agentAbilities);
  const isNew = useAppStore((s) => !s.profiles.some((p) => p.id === initial.id));
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
    customModels[form.adapter] ?? [],
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
        {isNew ? 'New profile' : 'Edit profile'}
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
                effort: supportsEffort(adapter) ? form.effort : undefined,
                // Keep only what the new CLI can express (agents.rs validation).
                permissionLevel: permissionLevels(adapter).includes(level)
                  ? level
                  : 'appDefault',
                allowedTools: adapter === 'claude' ? form.allowedTools : undefined,
                browser: adapter === 'claude' ? form.browser : undefined,
              });
            }}
          >
            {ADAPTER_KINDS.map((id) => (
              <option key={id} value={id}>
                {ADAPTER_LABELS[id]}
              </option>
            ))}
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
              effectiveExecutable({ ...form, executable: undefined }) ||
              '/home/user/.local/bin/aichat'
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
            <code>{effectiveExecutable(form) || 'your CLI'} --help</code> for the current
            list). Blank means the CLI default.
          </span>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="prof-effort">
            Effort / reasoning (optional)
          </label>
          <select
            id="prof-effort"
            disabled={!supportsEffort(form.adapter)}
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
            {supportsEffort(form.adapter)
              ? 'Higher effort usually means slower, more thorough runs.'
              : 'Set reasoning effort in this CLI’s own configuration.'}
          </span>
        </div>
      </div>
      {supportsProfileControls(form.adapter) && (
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
      {supportsProfileControls(form.adapter) && (
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
      {form.adapter === 'claude' && (
        <BrowserField
          value={form.browser}
          appBrowser={appAbilities.browser}
          onChange={(browser) => {
            set({ browser });
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

/** The Browser fact on a profile card: what its runs pass, and why. */
function browserFact(profile: AgentProfile, appBrowser: boolean): string {
  if (profile.extraArgs.includes('--chrome')) return 'On (extra argument)';
  if (profile.extraArgs.includes('--no-chrome')) return 'Off (extra argument)';
  if (profile.browser !== undefined) return profile.browser ? 'On' : 'Off';
  return appBrowser ? 'On (app)' : 'Claude settings (app)';
}

/** Whether a Claude Code profile runs with Claude in Chrome (`--chrome`). */
function BrowserField({
  value,
  appBrowser,
  onChange,
}: {
  value: boolean | undefined;
  appBrowser: boolean;
  onChange: (value: boolean | undefined) => void;
}): React.JSX.Element {
  const effective = value ?? appBrowser;
  return (
    <div className="field">
      <label className="field-label" htmlFor="prof-browser">
        Browser
      </label>
      <select
        id="prof-browser"
        className="input"
        value={value === undefined ? 'app' : value ? 'on' : 'off'}
        onChange={(e) => {
          const next = e.target.value;
          onChange(next === 'app' ? undefined : next === 'on');
        }}
      >
        <option value="app">
          App default ({appBrowser ? 'uses my browser' : 'Claude Code settings decide'})
        </option>
        <option value="on">Use my browser (Claude in Chrome)</option>
        <option value="off">Off</option>
      </select>
      <span className="field-hint">
        {value === false
          ? 'Steps run Claude Code with --no-chrome, whatever its own settings say.'
          : effective
            ? 'Steps run Claude Code with --chrome: Claude can open pages and act in your signed-in browser, and may use the browser tools without asking. Workflows using this profile list it among their automation risks.'
            : 'Orchevia adds no browser flag, so your Claude Code settings decide. Turn it on here, or for every profile in Environment → Agents → Abilities.'}
      </span>
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
