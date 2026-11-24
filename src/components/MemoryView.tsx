import { PROJECT_FIELDS, projectKey } from '../lib/memory';
import { DirPicker } from './DirPicker';
import { Modal } from './Modal';
import { readLocal } from '../lib/storage';
import { useRef, useState } from 'react';
import { getBackend } from '../lib/backend';
import { isPendingSuggestion, type Preference } from '../lib/generation';
import { formatTime } from '../lib/time';
import { confirmDialog } from './ConfirmDialog';
import { useAppStore } from '../store';
import { Notice, useNoticeMessage } from './Notice';
import { errorMessage } from '../lib/errors';
import { MarkdownText } from './Markdown';

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
  const [disabledFields, setDisabledFields] = useState<string[]>([]);
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
    setDisabledFields([]);
    setNote('');
    setMessage(null);
  };

  const loadPlaybook = (directory: string): void => {
    const request = ++playbookRequest.current;
    setBusy(true);
    setMessage(null);
    void getBackend()
      .getProjectMemoryContext(directory)
      .then(async (context) => {
        const all = await getBackend().listPreferences();
        if (request !== playbookRequest.current) return;
        const disabled: string[] = [];
        const savedFields = PROJECT_FIELDS.flatMap<[string, string]>((field) => {
          if (!context.scope.startsWith('repo:')) return [];
          const key = projectKey(context.scope, field);
          const saved = all.find(
            (p) =>
              p.key === key &&
              p.scope === context.scope &&
              (p.source === 'manual' || p.source === 'accepted'),
          );
          if (saved?.enabled === false) disabled.push(field);
          return typeof saved?.value === 'string' ? [[field, saved.value]] : [];
        });
        setFields(Object.fromEntries(savedFields));
        setDisabledFields(disabled);
        setMessage(
          savedFields.length
            ? 'Loaded project playbook.'
            : 'No saved project knowledge for this repository yet.',
        );
      })
      .catch(
        (e: unknown) =>
          request === playbookRequest.current && setMessage(errorMessage(e), 'error'),
      )
      .finally(() => request === playbookRequest.current && setBusy(false));
  };
  const saveField = (field: string): void => {
    const request = ++playbookRequest.current;
    setBusy(true);
    setMessage(null);
    void getBackend()
      .saveProjectPreference(
        repoDir,
        field,
        fields[field] ?? '',
        note || 'Saved explicitly in Playbooks.',
      )
      .then(async () => {
        await refreshLibrary();
        if (request === playbookRequest.current) {
          setDisabledFields((previous) => previous.filter((item) => item !== field));
          setMessage(`Saved ${FIELD_LABELS[field] ?? field}.`);
        }
      })
      .catch((e: unknown) => {
        if (request === playbookRequest.current) setMessage(errorMessage(e), 'error');
      })
      .finally(() => request === playbookRequest.current && setBusy(false));
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

  return (
    <>
      <div className="topbar">
        <h1>Playbooks</h1>
        <span className="topbar-sub">Save what works in each repository.</span>
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
        <h2 style={{ fontSize: 14 }}>Project playbook</h2>
        <p className="field-hint">
          Workflow generation and assistance use these saved commands, conventions and
          reviewer preferences when you work in this repository.
        </p>
        <div className="playbook-editor">
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
            onChange={chooseRepo}
            onPicked={loadPlaybook}
          />
          <button
            className="btn"
            disabled={busy || !repoDir.trim()}
            onClick={() => loadPlaybook(repoDir)}
          >
            {busy ? 'Working…' : 'Load playbook'}
          </button>
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
              placeholder="Where this knowledge came from"
            />
          </div>
          <div className="playbook-fields">
            {PROJECT_FIELDS.map((field) => (
              <div className="field" key={field}>
                <label className="field-label" htmlFor={'playbook-' + field}>
                  {FIELD_LABELS[field]}
                </label>
                {field === 'templateId' ? (
                  <select
                    id={'playbook-' + field}
                    className="select"
                    value={fields[field] ?? ''}
                    onChange={(e) => setFields({ ...fields, [field]: e.target.value })}
                  >
                    <option value="">Choose a saved template</option>
                    {userTemplates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                    {fields[field] &&
                      !userTemplates.some((t) => t.id === fields[field]) && (
                        <option value={fields[field]}>
                          Missing template: {fields[field]}
                        </option>
                      )}
                  </select>
                ) : field === 'fastReviewProfile' || field === 'deepReviewProfile' ? (
                  <select
                    id={'playbook-' + field}
                    className="select"
                    value={fields[field] ?? ''}
                    onChange={(e) => setFields({ ...fields, [field]: e.target.value })}
                  >
                    <option value="">Choose an exact profile name</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.name}>
                        {p.name} ({p.adapter})
                      </option>
                    ))}
                    {fields[field] && !profiles.some((p) => p.name === fields[field]) && (
                      <option value={fields[field]}>
                        Missing profile: {fields[field]}
                      </option>
                    )}
                  </select>
                ) : (
                  <textarea
                    id={'playbook-' + field}
                    className="textarea"
                    rows={field === 'conventions' ? 3 : 2}
                    maxLength={4000}
                    value={fields[field] ?? ''}
                    onChange={(e) => setFields({ ...fields, [field]: e.target.value })}
                  />
                )}
                <button
                  className="btn"
                  disabled={busy || !repoDir.trim() || !fields[field]?.trim()}
                  onClick={() => saveField(field)}
                >
                  {disabledFields.includes(field) ? 'Save and enable' : 'Save'}{' '}
                  {FIELD_LABELS[field]}
                </button>
                {disabledFields.includes(field) && (
                  <span className="field-hint">
                    Disabled for workflow generation and assistance.
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="field" style={{ maxWidth: 760 }}>
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

        <details className="playbook-section" open={suggestions.length > 0}>
          <summary>Suggestions ({suggestions.length})</summary>
          <label className="playbook-learning">
            <input type="checkbox" checked={learningOn} onChange={toggleLearning} />
            Suggest changes after three matching edits
          </label>
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
          <summary>Saved preferences ({active.length})</summary>
          {active.length === 0 && <p className="field-hint">No preferences saved yet.</p>}
          {active.map((p) => (
            <div key={p.key} className="run-row" style={{ opacity: p.enabled ? 1 : 0.6 }}>
              <span className="status-pill status-paused">{p.source}</span>
              <span>
                <div style={{ fontWeight: 600 }}>{preferenceLabel(p)}</div>
                <div className="wf-card-meta">
                  {String(p.value)} · {scopeLabel(p.scope)}
                  {p.note !== '' ? ` · ${p.note}` : ''}
                </div>
              </span>
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
              <button className="btn btn-ghost" onClick={() => remove(p.key)}>
                Delete
              </button>
            </div>
          ))}
        </details>

        <details className="playbook-section">
          <summary>Import, export and reset</summary>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button className="btn" onClick={doExport}>
              Export JSON
            </button>
            <button className="btn" onClick={doImport}>
              Import JSON
            </button>
            <button className="btn btn-danger" onClick={resetAll}>
              Reset all
            </button>
          </div>
          <textarea
            className="textarea"
            aria-label="Preferences JSON"
            rows={5}
            style={{ maxWidth: 680 }}
            value={memoryText ?? ''}
            onChange={(e) => setMemoryText(e.target.value)}
            placeholder="Exported preferences JSON appears here; paste to import."
          />
        </details>

        <details className="playbook-section">
          <summary>Generation history ({generations.length})</summary>
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
                  <pre className="log-block gen-proposal">
                    {formatProposalJson(g.proposalJson)}
                  </pre>
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

function formatProposalJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json) as unknown, null, 2);
  } catch {
    return json;
  }
}

const FIELD_LABELS: Record<string, string> = {
  testCommand: 'Test command',
  lintCommand: 'Lint command',
  buildCommand: 'Build command',
  conventions: 'Repository conventions',
  fastReviewProfile: 'Preferred fast reviewer',
  deepReviewProfile: 'Preferred deep reviewer',
  templateId: 'Reusable workflow template',
};
