import { PROJECT_FIELDS, projectKey, type DetectedCommand } from '../lib/memory';
import { DirPicker } from './DirPicker';
import { Modal } from './Modal';
import { readLocal } from '../lib/storage';
import { useEffect, useRef, useState } from 'react';
import { getBackend } from '../lib/backend';
import { isPendingSuggestion, type Preference } from '../lib/generation';
import { formatTime } from '../lib/time';
import { confirmDialog } from './ConfirmDialog';
import { useAppStore } from '../store';
import { Notice, useNoticeMessage } from './Notice';
import { errorMessage } from '../lib/errors';
import { MarkdownText } from './Markdown';
import { JsonEditor, JsonView } from './JsonEditor';
import { Switch } from './Switch';

export function MemoryView(): React.JSX.Element {
  const profiles = useAppStore((s) => s.profiles);
  const userTemplates = useAppStore((s) => s.userTemplates);
  const workflows = useAppStore((s) => s.workflows);
  const activeWorkflowId = useAppStore((s) => s.activeWorkflowId);
  const playbookRequest = useRef(0);
  const [repoDir, setRepoDir] = useState(
    () =>
      workflows.find((w) => w.id === activeWorkflowId)?.definition.defaults?.repoDir ??
      readLocal('orchevia.genRepo.v1') ??
      '',
  );
  const [fields, setFields] = useState<Record<string, string>>({});
  // What is stored for the loaded repository, to save only what changed.
  const [savedFields, setSavedFields] = useState<Record<string, string>>({});
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [disabledFields, setDisabledFields] = useState<string[]>([]);
  const [detected, setDetected] = useState<DetectedCommand[] | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Preference | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editNote, setEditNote] = useState('');
  const preferences = useAppStore((s) => s.preferences);
  const generations = useAppStore((s) => s.generations);
  const refreshLibrary = useAppStore((s) => s.refreshLibrary);
  const setView = useAppStore((s) => s.setView);
  const [message, setMessage, messageVariant, messageEvent] = useNoticeMessage();
  const [memoryText, setMemoryText] = useState<string | null>(null);

  const suggestions = preferences.filter(isPendingSuggestion);
  const active = preferences.filter((p) => !isPendingSuggestion(p));
  const repositoryPaths = [
    ...workflows.flatMap((w) => w.definition.defaults?.repoDir ?? []),
    ...preferences.flatMap((p) => (p.scope.startsWith('repo:') ? p.scope.slice(5) : [])),
  ];
  const savedRepos = [
    ...new Set(
      repositoryPaths
        .map((path) => path.trim().replace(/([^:/])\/+$/, '$1'))
        .filter(Boolean),
    ),
  ].sort();
  const changedFields = PROJECT_FIELDS.filter(
    (field) => (fields[field] ?? '').trim() !== (savedFields[field] ?? ''),
  );
  const repoName =
    repoDir
      .trim()
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? '';

  const reload = (): void => {
    void refreshLibrary();
  };

  const accept = (pref: Preference): void => {
    void getBackend()
      .savePreference({ ...pref, source: 'accepted' })
      .then(() => {
        setMessage(`Accepted '${pref.key}'.`);
        reload();
      })
      .catch((err: unknown) => {
        setMessage(errorMessage(err), 'error');
      });
  };

  const reject = (pref: Preference): void => {
    // Rejected suggestions are stored disabled so they are never re-created
    // until a memory reset — no nagging.
    void getBackend()
      .savePreference({ ...pref, source: 'rejected', enabled: false })
      .then(() => {
        setMessage(`Rejected '${pref.key}' (won't ask again until reset).`);
        reload();
      })
      .catch((err: unknown) => {
        setMessage(errorMessage(err), 'error');
      });
  };

  const remove = (key: string): void => {
    void confirmDialog({
      title: `Delete preference '${key}'?`,
      message: 'The learned preference is removed. Future edits may suggest it again.',
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      return getBackend()
        .deletePreference(key)
        .then(() => reload())
        .catch((err: unknown) => {
          setMessage(errorMessage(err), 'error');
        });
    });
  };

  const toggleEnabled = (pref: Preference): void => {
    void getBackend()
      .savePreference({ ...pref, enabled: !pref.enabled })
      .then(() => reload())
      .catch((err: unknown) => {
        setMessage(errorMessage(err), 'error');
      });
  };

  const resetAll = (): void => {
    void confirmDialog({
      title: 'Reset all learned preferences?',
      message:
        'Every accepted and suggested preference is removed. This cannot be undone.',
      confirmLabel: 'Reset all',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      return getBackend()
        .resetMemory()
        .then(() => {
          setMessage('Memory reset.');
          reload();
        })
        .catch((err: unknown) => {
          setMessage(errorMessage(err), 'error');
        });
    });
  };

  const doExport = (): void => {
    void getBackend()
      .exportMemory()
      .then((json) => {
        setMemoryText(json);
        setMessage(null);
      })
      .catch((err: unknown) => {
        setMessage(errorMessage(err), 'error');
      });
  };

  const doImport = (): void => {
    if (memoryText === null || memoryText.trim() === '') return;
    void getBackend()
      .importMemory(memoryText)
      .then((count) => {
        setMessage(`Imported ${String(count)} preferences.`);
        reload();
      })
      .catch((err: unknown) => {
        setMessage(errorMessage(err), 'error');
      });
  };

  const chooseRepo = (dir: string): void => {
    ++playbookRequest.current;
    setBusy(false);
    setRepoDir(dir);
    setFields({});
    setSavedFields({});
    setLoadedScope(null);
    setDisabledFields([]);
    setDetected(null);
    setNote('');
    setMessage(null);
  };

  /** The stored playbook of a repository: its scope, saved values and disabled fields. */
  const readPlaybook = async (
    directory: string,
  ): Promise<{
    scope: string | null;
    stored: Record<string, string>;
    disabled: string[];
  }> => {
    const context = await getBackend().getProjectMemoryContext(directory);
    const all = await getBackend().listPreferences();
    const scope = context.scope.startsWith('repo:') ? context.scope : null;
    const disabled: string[] = [];
    const stored = PROJECT_FIELDS.flatMap<[string, string]>((field) => {
      if (scope === null) return [];
      const key = projectKey(scope, field);
      const saved = all.find(
        (p) =>
          p.key === key &&
          p.scope === scope &&
          (p.source === 'manual' || p.source === 'accepted'),
      );
      if (saved?.enabled === false) disabled.push(field);
      return typeof saved?.value === 'string' ? [[field, saved.value]] : [];
    });
    return { scope, stored: Object.fromEntries(stored), disabled };
  };
  const showPlaybook = (loaded: Awaited<ReturnType<typeof readPlaybook>>): void => {
    setFields(loaded.stored);
    setSavedFields(loaded.stored);
    setLoadedScope(loaded.scope);
    setDisabledFields(loaded.disabled);
  };

  const loadPlaybook = (directory: string): void => {
    const request = ++playbookRequest.current;
    setBusy(true);
    setMessage(null);
    setDetected(null);
    void readPlaybook(directory)
      .then((loaded) => {
        if (request !== playbookRequest.current) return;
        showPlaybook(loaded);
        setMessage(
          Object.keys(loaded.stored).length > 0
            ? 'Loaded project playbook.'
            : 'No saved project knowledge for this repository yet. Detect commands or type them, then Save playbook.',
        );
      })
      .catch(
        (e: unknown) =>
          request === playbookRequest.current && setMessage(errorMessage(e), 'error'),
      )
      .finally(() => request === playbookRequest.current && setBusy(false));
  };

  // Show the saved playbook of the repository the view opens with.
  useEffect(() => {
    if (!/^(\/|[A-Za-z]:[\\/])/.test(repoDir.trim())) return;
    const request = playbookRequest.current;
    void readPlaybook(repoDir)
      .then((loaded) => {
        // Ignored once the user picks a repository or acts.
        if (request !== playbookRequest.current) return;
        setSavedFields(loaded.stored);
        setLoadedScope(loaded.scope);
        setDisabledFields(loaded.disabled);
        // Anything typed while it loaded stays.
        setFields((current) => ({
          ...loaded.stored,
          ...Object.fromEntries(
            Object.entries(current).filter(([, value]) => value.trim() !== ''),
          ),
        }));
      })
      .catch(() => {
        // The picker and Load playbook report errors.
      });
    // Only on open: later changes load through the picker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const detect = (): void => {
    const request = ++playbookRequest.current;
    setBusy(true);
    setMessage(null);
    void (async () => {
      try {
        // Saved values come first: detection only fills what is still empty.
        if (loadedScope === null) {
          const loaded = await readPlaybook(repoDir);
          if (request !== playbookRequest.current) return;
          setSavedFields(loaded.stored);
          setLoadedScope(loaded.scope);
          setDisabledFields(loaded.disabled);
          // What you typed before loading stays; saved values fill the rest.
          setFields((current) => ({
            ...loaded.stored,
            ...Object.fromEntries(
              Object.entries(current).filter(([, value]) => value.trim() !== ''),
            ),
          }));
        }
        const found = await getBackend().detectProjectCommands(repoDir);
        if (request !== playbookRequest.current) return;
        setDetected(found);
        setFields((current) => {
          const next = { ...current };
          for (const item of found)
            if ((next[item.field] ?? '').trim() === '') next[item.field] = item.value;
          return next;
        });
        setMessage(
          found.length === 0
            ? 'Nothing to suggest: no package.json, Cargo.toml, Makefile, go.mod, pyproject.toml or similar file was found in that folder.'
            : `Found ${String(found.length)} suggestion${found.length === 1 ? '' : 's'} in ${[...new Set(found.map((d) => d.source.split(' ')[0] ?? d.source))].join(', ')}. Review them, then Save playbook.`,
        );
      } catch (e) {
        if (request === playbookRequest.current) setMessage(errorMessage(e), 'error');
      } finally {
        if (request === playbookRequest.current) setBusy(false);
      }
    })();
  };

  const enableField = (field: string): void => {
    const value = savedFields[field];
    if (value === undefined) return;
    const request = ++playbookRequest.current;
    setBusy(true);
    void getBackend()
      .saveProjectPreference(
        repoDir,
        field,
        value,
        note.trim() || 'Enabled again in Playbooks.',
      )
      .then(async () => {
        await refreshLibrary();
        if (request !== playbookRequest.current) return;
        setDisabledFields((previous) => previous.filter((item) => item !== field));
        setMessage(`Enabled ${FIELD_LABELS[field] ?? field} again.`);
      })
      .catch((e: unknown) => {
        if (request === playbookRequest.current) setMessage(errorMessage(e), 'error');
      })
      .finally(() => request === playbookRequest.current && setBusy(false));
  };

  const savePlaybook = (): void => {
    void (async () => {
      const clearing = changedFields.filter(
        (field) =>
          (fields[field] ?? '').trim() === '' && savedFields[field] !== undefined,
      );
      if (
        clearing.length > 0 &&
        !(await confirmDialog({
          title: `Clear ${String(clearing.length)} saved value${clearing.length === 1 ? '' : 's'}?`,
          message: `${clearing.map((field) => FIELD_LABELS[field] ?? field).join(', ')} will no longer be used for this repository.`,
          confirmLabel: 'Clear and save',
          danger: true,
        }))
      )
        return;
      const request = ++playbookRequest.current;
      setBusy(true);
      setMessage(null);
      const backend = getBackend();
      const saved: string[] = [];
      const cleared: string[] = [];
      const written: string[] = [];
      try {
        for (const field of changedFields) {
          const value = (fields[field] ?? '').trim();
          if (value === '') {
            if (loadedScope !== null && savedFields[field] !== undefined) {
              await backend.deletePreference(projectKey(loadedScope, field));
              cleared.push(FIELD_LABELS[field] ?? field);
              written.push(field);
            }
            continue;
          }
          const source = detected?.find((d) => d.field === field && d.value === value);
          await backend.saveProjectPreference(
            repoDir,
            field,
            value,
            note.trim() ||
              (source === undefined
                ? 'Saved explicitly in Playbooks.'
                : `Detected from ${source.source}; reviewed in Playbooks.`),
          );
          saved.push(FIELD_LABELS[field] ?? field);
          written.push(field);
        }
        await refreshLibrary();
        if (request !== playbookRequest.current) return;
        setSavedFields(
          Object.fromEntries(
            PROJECT_FIELDS.flatMap((field) => {
              const value = (fields[field] ?? '').trim();
              return value === '' ? [] : [[field, value]];
            }),
          ),
        );
        // Only what was written changes state; other disabled values stay disabled.
        setDisabledFields((previous) =>
          previous.filter((field) => !written.includes(field)),
        );
        setMessage(
          [
            saved.length > 0 ? `Saved ${saved.join(', ')}.` : '',
            cleared.length > 0 ? `Cleared ${cleared.join(', ')}.` : '',
          ]
            .filter(Boolean)
            .join(' ') || 'Nothing changed.',
        );
      } catch (e) {
        if (request === playbookRequest.current) setMessage(errorMessage(e), 'error');
      } finally {
        if (request === playbookRequest.current) setBusy(false);
      }
    })();
  };

  const editPreference = (): void => {
    if (!editing) return;
    let value: Preference['value'];
    try {
      value =
        typeof editing.value === 'string'
          ? editValue
          : (JSON.parse(editValue) as Preference['value']);
    } catch {
      setMessage('Enter valid JSON for this scalar preference.', 'error');
      return;
    }
    void getBackend()
      .savePreference({ ...editing, value, note: editNote, source: 'manual' })
      .then(async () => {
        setEditing(null);
        await refreshLibrary();
        setMessage('Preference updated.');
      })
      .catch((e: unknown) => setMessage(errorMessage(e), 'error'));
  };

  const learning = preferences.find((p) => p.key === 'learning.enabled');
  const learningOn = learning === undefined ? true : learning.value !== false;

  const toggleLearning = (): void => {
    void getBackend()
      .savePreference({
        key: 'learning.enabled',
        scope: '*',
        value: !learningOn,
        source: 'manual',
        enabled: true,
        note: 'Whether repeated edits produce suggestions.',
      })
      .then(() => reload())
      .catch((err: unknown) => {
        setMessage(errorMessage(err), 'error');
      });
  };

  const fieldControl = (field: (typeof PROJECT_FIELDS)[number]): React.JSX.Element => {
    const id = 'playbook-' + field;
    const set = (value: string): void => {
      setFields({ ...fields, [field]: value });
    };
    const suggestion = detected?.find((d) => d.field === field);
    return (
      <div className="field" key={field}>
        <label className="field-label" htmlFor={id}>
          {FIELD_LABELS[field]}
        </label>
        {field === 'templateId' ? (
          <select
            id={id}
            className="select"
            value={fields[field] ?? ''}
            onChange={(e) => set(e.target.value)}
          >
            <option value="">No template</option>
            {userTemplates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
            {fields[field] && !userTemplates.some((t) => t.id === fields[field]) && (
              <option value={fields[field]}>Missing template: {fields[field]}</option>
            )}
          </select>
        ) : field === 'fastReviewProfile' || field === 'deepReviewProfile' ? (
          <select
            id={id}
            className="select"
            value={fields[field] ?? ''}
            onChange={(e) => set(e.target.value)}
          >
            <option value="">Use the role default</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.name}>
                {p.name} ({p.adapter})
              </option>
            ))}
            {fields[field] && !profiles.some((p) => p.name === fields[field]) && (
              <option value={fields[field]}>Missing profile: {fields[field]}</option>
            )}
          </select>
        ) : field === 'conventions' ? (
          <textarea
            id={id}
            className="textarea"
            rows={3}
            maxLength={4000}
            value={fields[field] ?? ''}
            placeholder="e.g. Use pnpm. Keep pull requests small. Tests live next to the code."
            onChange={(e) => set(e.target.value)}
          />
        ) : (
          <input
            id={id}
            className="input input-mono"
            maxLength={4000}
            value={fields[field] ?? ''}
            placeholder={FIELD_PLACEHOLDERS[field]}
            spellCheck={false}
            onChange={(e) => set(e.target.value)}
          />
        )}
        {suggestion !== undefined && (
          <span className="field-hint playbook-detected">
            {(fields[field] ?? '').trim() === suggestion.value ? (
              <>Detected in {suggestion.source}</>
            ) : (
              <>
                Detected <code>{suggestion.value}</code> in {suggestion.source}{' '}
                <button
                  type="button"
                  className="btn btn-ghost btn-inline"
                  onClick={() => set(suggestion.value)}
                >
                  Use it
                </button>
              </>
            )}
          </span>
        )}
        {disabledFields.includes(field) && (
          <span className="field-hint playbook-disabled">
            Disabled for workflow generation and assistance.{' '}
            {(fields[field] ?? '').trim() === (savedFields[field] ?? '') &&
              savedFields[field] !== undefined && (
                <button
                  type="button"
                  className="btn btn-ghost btn-inline"
                  disabled={busy}
                  onClick={() => enableField(field)}
                >
                  Enable again
                </button>
              )}
          </span>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="topbar">
        <h1>Playbooks</h1>
        <span className="topbar-sub">
          What Orchevia should know about each repository.
        </span>
        <div className="topbar-actions">
          <button className="btn" onClick={() => void refreshLibrary()}>
            Refresh
          </button>
          <button className="btn btn-ghost" onClick={() => setView('templates')}>
            Open templates
          </button>
        </div>
      </div>
      <div className="view playbooks-view">
        {message !== null && (
          <Notice
            variant={messageVariant}
            eventId={messageEvent}
            style={{ marginBottom: 12 }}
            onDismiss={() => {
              setMessage(null);
            }}
          >
            <span>{message}</span>
          </Notice>
        )}
        <section className="playbook-intro" aria-labelledby="playbook-intro-title">
          <div>
            <h2 id="playbook-intro-title">Teach Orchevia how a repository works</h2>
            <p>
              Save the commands that test, lint and build a repository, its conventions
              and your preferred reviewers. When you <strong>Generate</strong> or{' '}
              <strong>Assist</strong> a workflow for that repository, Orchevia hands these
              to your AI CLI so it uses your real commands instead of guessing. Nothing
              runs from this page.
            </p>
          </div>
          <ol className="playbook-steps">
            <li>
              <strong>Pick a repository</strong>
              <span>Browse, or choose one you already use.</span>
            </li>
            <li>
              <strong>Detect or type</strong>
              <span>Reads package.json, Cargo.toml, Makefile, go.mod and more.</span>
            </li>
            <li>
              <strong>Save playbook</strong>
              <span>Generate and Assist use it from then on.</span>
            </li>
          </ol>
        </section>

        <section className="card playbook-card" aria-labelledby="playbook-repo-title">
          <header className="card-head">
            <h2 id="playbook-repo-title">Repository</h2>
          </header>
          <div className="playbook-repo-row">
            {savedRepos.length > 0 && (
              <div className="field">
                <label className="field-label" htmlFor="saved-playbooks">
                  Saved repositories
                </label>
                <select
                  className="select"
                  id="saved-playbooks"
                  value={savedRepos.includes(repoDir) ? repoDir : ''}
                  onChange={(e) => {
                    const directory = e.target.value;
                    chooseRepo(directory);
                    if (directory !== '') loadPlaybook(directory);
                  }}
                >
                  <option value="">Choose a repository</option>
                  {savedRepos.map((directory) => (
                    <option key={directory}>{directory}</option>
                  ))}
                </select>
              </div>
            )}
            <DirPicker
              id="playbook-repo"
              label="Playbook repository"
              value={repoDir}
              placeholder="/path/to/repository"
              onChange={chooseRepo}
              onPicked={loadPlaybook}
            />
          </div>
          <div className="card-actions">
            <button
              className="btn"
              disabled={busy || !repoDir.trim()}
              onClick={() => loadPlaybook(repoDir)}
            >
              {busy ? 'Working…' : 'Load playbook'}
            </button>
            <button
              className="btn"
              disabled={busy || !repoDir.trim()}
              title="Read package.json, Cargo.toml, Makefile and similar files to suggest commands. Nothing runs."
              onClick={detect}
            >
              ✦ Detect commands
            </button>
          </div>
        </section>

        <section className="card playbook-card" aria-labelledby="playbook-form-title">
          <header className="card-head">
            <h2 id="playbook-form-title">
              {repoName !== '' ? (
                <>
                  Playbook for <code title={repoDir}>{repoName}</code>
                </>
              ) : (
                'Playbook'
              )}
            </h2>
            {changedFields.length > 0 && (
              <span className="status-pill status-paused">Unsaved changes</span>
            )}
          </header>
          <h3 className="card-subhead">Commands</h3>
          <div className="playbook-grid">
            {fieldControl('testCommand')}
            {fieldControl('lintCommand')}
            {fieldControl('buildCommand')}
          </div>
          <h3 className="card-subhead">Conventions</h3>
          {fieldControl('conventions')}
          <h3 className="card-subhead">Reviewers and template</h3>
          <div className="playbook-grid">
            {fieldControl('fastReviewProfile')}
            {fieldControl('deepReviewProfile')}
            {fieldControl('templateId')}
          </div>
          <div className="field playbook-evidence">
            <label className="field-label" htmlFor="playbook-evidence">
              Evidence note
            </label>
            <input
              id="playbook-evidence"
              className="input"
              value={note}
              maxLength={4000}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional: where this knowledge came from (shown to the AI with each value)"
            />
          </div>
          <div className="card-actions">
            <button
              className="btn btn-primary"
              disabled={busy || !repoDir.trim() || changedFields.length === 0}
              onClick={savePlaybook}
            >
              Save playbook
            </button>
            <span className="field-hint">
              Values are stored locally and only for this repository.
            </span>
          </div>
        </section>

        <section className="card playbook-card" aria-labelledby="playbook-global-title">
          <header className="card-head">
            <h2 id="playbook-global-title">All repositories</h2>
          </header>
          <div className="playbook-grid">
            <div className="field">
              <label className="field-label" htmlFor="default-deep-reviewer">
                Default deep reviewer
              </label>
              <select
                id="default-deep-reviewer"
                className="select"
                value={String(
                  preferences.find(
                    (p) =>
                      p.key === 'role.deepReview.profile' &&
                      p.enabled &&
                      ['manual', 'accepted'].includes(p.source),
                  )?.value ?? '',
                )}
                onChange={(e) => {
                  const value = e.target.value;
                  if (!value) {
                    remove('role.deepReview.profile');
                    return;
                  }
                  void getBackend()
                    .savePreference({
                      key: 'role.deepReview.profile',
                      scope: '*',
                      value,
                      source: 'manual',
                      enabled: true,
                      note: 'Explicit default selected in Playbooks.',
                    })
                    .then(() => refreshLibrary())
                    .catch((err: unknown) => setMessage(errorMessage(err), 'error'));
                }}
              >
                <option value="">First configured profile with the role</option>
                {profiles
                  .filter((p) => p.role === 'deepReview')
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.adapter})
                    </option>
                  ))}
              </select>
            </div>
            <div className="field">
              <span className="field-label">Learn from edits</span>
              <div className="switch-row">
                <Switch
                  checked={learningOn}
                  onChange={toggleLearning}
                  label="Suggest changes after three matching edits"
                  onText="On"
                  offText="Off"
                />
                <span className="field-hint">
                  Suggest a preference after three matching edits. You approve each one.
                </span>
              </div>
            </div>
          </div>
        </section>

        <details className="playbook-section" open={suggestions.length > 0}>
          <summary>
            Suggestions <span className="count-badge">{suggestions.length}</span>
          </summary>
          {suggestions.length === 0 && (
            <p className="field-hint">No suggestions to review.</p>
          )}
          {suggestions.map((p) => (
            <div key={p.key} className="tool-card" style={{ marginBottom: 8 }}>
              <h3>{preferenceLabel(p)}</h3>
              <div className="tool-version">
                {String(p.value)} · {scopeLabel(p.scope)}
              </div>
              <p className="field-hint">{p.note}</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" onClick={() => accept(p)}>
                  Accept
                </button>
                <button className="btn btn-ghost" onClick={() => reject(p)}>
                  Reject
                </button>
              </div>
            </div>
          ))}
        </details>

        <details className="playbook-section">
          <summary>
            Saved preferences <span className="count-badge">{active.length}</span>
          </summary>
          {active.length === 0 && <p className="field-hint">No preferences saved yet.</p>}
          {active.map((p) => (
            <div
              key={p.key}
              className="pref-row"
              style={{ opacity: p.enabled ? 1 : 0.6 }}
            >
              <span className="status-pill status-paused">{p.source}</span>
              <span className="pref-text">
                <span className="pref-title">{preferenceLabel(p)}</span>
                <span className="wf-card-meta">
                  {String(p.value)} · {scopeLabel(p.scope)}
                  {p.note !== '' ? ` · ${p.note}` : ''}
                </span>
              </span>
              <span className="pref-actions">
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setEditing(p);
                    setEditValue(
                      typeof p.value === 'string' ? p.value : JSON.stringify(p.value),
                    );
                    setEditNote(p.note);
                  }}
                >
                  Edit
                </button>
                <button className="btn btn-ghost" onClick={() => toggleEnabled(p)}>
                  {p.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  className="btn btn-ghost danger-hover"
                  onClick={() => remove(p.key)}
                >
                  Delete
                </button>
              </span>
            </div>
          ))}
        </details>

        <details className="playbook-section">
          <summary>Import, export and reset</summary>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button className="btn" onClick={doExport}>
              Export JSON
            </button>
            <button
              className="btn"
              onClick={doImport}
              disabled={memoryText === null || memoryText.trim() === ''}
            >
              Import JSON
            </button>
            <button className="btn btn-danger" onClick={resetAll}>
              Reset all
            </button>
          </div>
          <JsonEditor
            id="memory-json"
            ariaLabel="Preferences JSON"
            rows={6}
            allowEmpty
            value={memoryText ?? ''}
            onChange={setMemoryText}
          />
        </details>

        <details className="playbook-section">
          <summary>
            Generation history <span className="count-badge">{generations.length}</span>
          </summary>
          {generations.length === 0 && (
            <p className="field-hint">No workflows generated yet.</p>
          )}
          {generations.slice(0, 20).map((g) => (
            <details key={g.id} className="run-row gen-row">
              <summary className="gen-summary" title={g.goal}>
                <span className={`status-pill ${generationPill(g.status)}`}>
                  {g.status}
                </span>
                <span className="gen-head">
                  <span className="gen-goal">{g.goal}</span>
                  <span className="wf-card-meta" title={g.createdAt}>
                    {formatTime(g.createdAt)}
                  </span>
                </span>
              </summary>
              <div className="gen-body">
                <div className="gen-full">
                  <MarkdownText text={g.goal} />
                </div>
                <p className="wf-card-meta" style={{ marginBottom: 8 }}>
                  profile {g.generatorProfile} · {g.id} ·{' '}
                  <span title={g.createdAt}>{formatTime(g.createdAt)}</span>
                </p>
                <details>
                  <summary
                    className="field-hint"
                    style={{ cursor: 'pointer', marginBottom: 6 }}
                  >
                    Proposal JSON ({formatSize(g.proposalJson.length)})
                  </summary>
                  <JsonView value={g.proposalJson} className="gen-proposal" />
                </details>
              </div>
            </details>
          ))}
        </details>
      </div>
      {editing && (
        <Modal
          label="Edit preference"
          onClose={() => setEditing(null)}
          onBackdrop={() => setEditing(null)}
        >
          <div className="modal-panel">
            <h3>Edit preference</h3>
            <p className="field-hint">
              {editing.key} · {editing.scope}
            </p>
            <label className="field-label" htmlFor="memory-edit-value">
              Value
            </label>
            <textarea
              id="memory-edit-value"
              className="textarea"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              maxLength={4000}
            />
            <label className="field-label" htmlFor="memory-edit-note">
              Evidence
            </label>
            <textarea
              id="memory-edit-note"
              className="textarea"
              value={editNote}
              onChange={(e) => setEditNote(e.target.value)}
              maxLength={4000}
            />
            <button className="btn btn-primary" onClick={editPreference}>
              Save preference
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function preferenceLabel(preference: Preference): string {
  if (!preference.key.startsWith('project.')) return preference.key;
  const field = preference.key.split('.').at(-1) ?? '';
  return FIELD_LABELS[field] ?? preference.key;
}

function scopeLabel(scope: string): string {
  if (scope === '*') return 'All repositories';
  return scope.startsWith('repo:') ? scope.slice(5) : scope;
}

function generationPill(status: string): string {
  switch (status) {
    case 'accepted':
      return 'status-succeeded';
    case 'failed':
      return 'status-failed';
    case 'discarded':
      return 'status-cancelled';
    default:
      return 'status-paused';
  }
}

function formatSize(chars: number): string {
  return chars < 1024 ? `${String(chars)} chars` : `${(chars / 1024).toFixed(1)} KB`;
}

const FIELD_PLACEHOLDERS: Record<string, string> = {
  testCommand: 'npm test',
  lintCommand: 'npm run lint',
  buildCommand: 'npm run build',
};

const FIELD_LABELS: Record<string, string> = {
  testCommand: 'Test command',
  lintCommand: 'Lint command',
  buildCommand: 'Build command',
  conventions: 'Repository conventions',
  fastReviewProfile: 'Preferred fast reviewer',
  deepReviewProfile: 'Preferred deep reviewer',
  templateId: 'Reusable workflow template',
};
