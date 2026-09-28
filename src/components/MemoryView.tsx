import { useState } from 'react';
import { getBackend } from '../lib/backend';
import { isPendingSuggestion, type Preference } from '../lib/generation';
import { formatTime } from '../lib/time';
import { confirmDialog } from './ConfirmDialog';
import { useAppStore } from '../store';
import { Notice } from './Notice';
import { errorMessage } from '../lib/errors';
import { MarkdownText } from './Markdown';

export function MemoryView(): React.JSX.Element {
  const preferences = useAppStore((s) => s.preferences);
  const generations = useAppStore((s) => s.generations);
  const refreshLibrary = useAppStore((s) => s.refreshLibrary);
  const [message, setMessage] = useState<string | null>(null);
  const [memoryText, setMemoryText] = useState<string | null>(null);

  const suggestions = preferences.filter(isPendingSuggestion);
  const active = preferences.filter((p) => !isPendingSuggestion(p));

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
        setMessage(errorMessage(err));
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
        setMessage(errorMessage(err));
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
          setMessage(errorMessage(err));
        });
    });
  };

  const toggleEnabled = (pref: Preference): void => {
    void getBackend()
      .savePreference({ ...pref, enabled: !pref.enabled })
      .then(() => reload())
      .catch((err: unknown) => {
        setMessage(errorMessage(err));
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
          setMessage(errorMessage(err));
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
        setMessage(errorMessage(err));
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
        setMessage(errorMessage(err));
      });
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
        setMessage(errorMessage(err));
      });
  };

  return (
    <>
      <div className="topbar">
        <h1>Memory</h1>
        <span className="topbar-sub">
          Structured local preferences — inspectable, no hidden profile.
        </span>
        <div className="topbar-actions">
          <button className="btn" onClick={() => void refreshLibrary()}>
            Refresh
          </button>
          <button className="btn btn-danger" onClick={resetAll}>
            Reset all
          </button>
        </div>
      </div>
      <div className="view">
        {message !== null && (
          <Notice
            style={{ marginBottom: 12 }}
            onDismiss={() => {
              setMessage(null);
            }}
          >
            <span>{message}</span>
          </Notice>
        )}
        <Notice style={{ marginBottom: 16 }}>
          Orchevia learns only what you repeatedly do: after 3 consistent edits it{' '}
          <strong>suggests</strong> a preference — you accept, reject, edit, disable, or
          reset it. Everything stays on this machine; nothing contains credentials.
        </Notice>

        <label
          className="field-hint"
          style={{ display: 'flex', gap: 8, marginBottom: 16 }}
        >
          <input type="checkbox" checked={learningOn} onChange={toggleLearning} />
          Learning suggestions enabled
        </label>

        <h2 style={{ fontSize: 14 }}>Suggestions ({suggestions.length})</h2>
        {suggestions.length === 0 && (
          <p className="field-hint">
            No pending suggestions. Keep working — consistency gets noticed.
          </p>
        )}
        {suggestions.map((p) => (
          <div key={p.key} className="tool-card" style={{ marginBottom: 8 }}>
            <h3>{p.key}</h3>
            <div className="tool-version">
              → {String(p.value)} · scope {p.scope}
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

        <h2 style={{ fontSize: 14, marginTop: 20 }}>Preferences ({active.length})</h2>
        {active.map((p) => (
          <div key={p.key} className="run-row" style={{ opacity: p.enabled ? 1 : 0.6 }}>
            <span className="status-pill status-paused">{p.source}</span>
            <span>
              <div style={{ fontWeight: 600 }}>{p.key}</div>
              <div className="wf-card-meta">
                {String(p.value)} · scope {p.scope}
                {p.note !== '' ? ` · ${p.note}` : ''}
              </div>
            </span>
            <button className="btn btn-ghost" onClick={() => toggleEnabled(p)}>
              {p.enabled ? 'Disable' : 'Enable'}
            </button>
            <button className="btn btn-ghost" onClick={() => remove(p.key)}>
              Delete
            </button>
          </div>
        ))}

        <h2 style={{ fontSize: 14, marginTop: 20 }}>Export / Import</h2>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button className="btn" onClick={doExport}>
            Export JSON
          </button>
          <button className="btn" onClick={doImport}>
            Import JSON
          </button>
        </div>
        <textarea
          className="textarea"
          rows={5}
          style={{ maxWidth: 680 }}
          value={memoryText ?? ''}
          onChange={(e) => setMemoryText(e.target.value)}
          placeholder="Exported preferences JSON appears here; paste to import."
        />

        <h2 style={{ fontSize: 14, marginTop: 20 }}>
          Generation history ({generations.length})
        </h2>
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
      </div>
    </>
  );
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
