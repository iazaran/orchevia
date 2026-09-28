import { useState } from 'react';
import { getBackend } from '../lib/backend';
import type { WorkflowTemplate } from '../lib/generation';
import { confirmDialog } from './ConfirmDialog';
import { useAppStore } from '../store';
import { CloseButton } from './CloseButton';
import { Modal } from './Modal';
import { Notice } from './Notice';
import { errorMessage } from '../lib/errors';

export function TemplatesView(): React.JSX.Element {
  const builtinTemplates = useAppStore((s) => s.builtinTemplates);
  const userTemplates = useAppStore((s) => s.userTemplates);
  const profiles = useAppStore((s) => s.profiles);
  const refreshLibrary = useAppStore((s) => s.refreshLibrary);
  const refreshWorkflows = useAppStore((s) => s.refreshWorkflows);
  const selectWorkflow = useAppStore((s) => s.selectWorkflow);
  const setView = useAppStore((s) => s.setView);

  const [message, setMessage] = useState<string | null>(null);
  const [setupNeeded, setSetupNeeded] = useState<{
    name: string;
    items: string[];
  } | null>(null);
  const [importText, setImportText] = useState('');
  const [ioModal, setIoModal] = useState<
    { mode: 'import' } | { mode: 'export'; name: string; json: string } | null
  >(null);
  const [copied, setCopied] = useState(false);

  const reload = (): void => {
    void refreshLibrary();
  };

  const roleMap = (): Record<string, string> => {
    const map: Record<string, string> = {};
    for (const p of profiles) {
      if (p.role !== undefined && p.role !== '' && map[p.role] === undefined) {
        map[p.role] = p.id;
      }
    }
    return map;
  };

  const instantiate = (template: WorkflowTemplate, builtin: boolean): void => {
    void getBackend()
      .instantiateTemplate(template.id, builtin, roleMap())
      .then((preview) => {
        if (preview.setupNeeded.length > 0) {
          setSetupNeeded({ name: template.name, items: preview.setupNeeded });
        }
        return getBackend().saveWorkflow(preview.workflow);
      })
      .then((stored) => {
        void refreshWorkflows().then(() => {
          selectWorkflow(stored.id);
          setView('workflows');
        });
      })
      .catch((err: unknown) => {
        setMessage(errorMessage(err));
      });
  };

  const doExport = (template: WorkflowTemplate, builtin: boolean): void => {
    void getBackend()
      .exportTemplate(template.id, builtin)
      .then((json) => {
        setCopied(false);
        setIoModal({ mode: 'export', name: template.name, json });
      })
      .catch((err: unknown) => {
        setMessage(errorMessage(err));
      });
  };

  const doImport = (): void => {
    if (importText.trim() === '') {
      setMessage('Paste template JSON first, then Import.');
      return;
    }
    void getBackend()
      .importTemplate(importText)
      .then((t) => {
        setImportText('');
        setIoModal(null);
        setMessage(`Imported template '${t.name}'.`);
        reload();
      })
      .catch((err: unknown) => {
        setMessage(errorMessage(err));
      });
  };

  const removeUser = (id: string, name: string): void => {
    void confirmDialog({
      title: `Delete template '${name}'?`,
      message: 'The template leaves your library. Workflows made from it are kept.',
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      return getBackend()
        .deleteUserTemplate(id)
        .then(() => reload())
        .catch((err: unknown) => {
          setMessage(errorMessage(err));
        });
    });
  };

  const renderCard = (
    template: WorkflowTemplate,
    builtin: boolean,
  ): React.JSX.Element => (
    <div key={template.id} className="tool-card" style={{ position: 'relative' }}>
      {!builtin && (
        <CloseButton
          variant="card"
          label={`Delete template '${template.name}'`}
          title={`Delete template '${template.name}'`}
          onClose={() => removeUser(template.id, template.name)}
        />
      )}
      <h3 style={{ paddingRight: builtin ? 0 : 40 }}>{template.name}</h3>
      <div style={{ margin: '6px 0', display: 'flex', gap: 6 }}>
        <span className="status-pill status-running">{template.category}</span>
        <span className="status-pill status-paused">v{template.version}</span>
      </div>
      <p className="field-hint">{template.description}</p>
      <div className="tool-version">{template.workflow.nodes.length} nodes</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'nowrap' }}>
        <button
          className="btn btn-primary"
          style={{ whiteSpace: 'nowrap' }}
          onClick={() => instantiate(template, builtin)}
        >
          Use template
        </button>
        <button
          className="btn btn-ghost"
          style={{ whiteSpace: 'nowrap' }}
          title="Show this template as portable JSON (validated, secrets refused)"
          onClick={() => doExport(template, builtin)}
        >
          Export JSON
        </button>
      </div>
    </div>
  );

  return (
    <>
      <div className="topbar">
        <h1>Templates</h1>
        <span className="topbar-sub">
          Versioned, cloneable starters — roles resolve to your profiles on use.
        </span>
        <div className="topbar-actions">
          <button
            className="btn btn-primary"
            title="Paste portable template JSON to add it to your library"
            onClick={() => {
              setImportText('');
              setIoModal({ mode: 'import' });
            }}
          >
            Import JSON…
          </button>
          <button className="btn" onClick={reload}>
            Refresh
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
            <span>{message}</span>{' '}
          </Notice>
        )}
        {setupNeeded !== null && (
          <Notice variant="warn" style={{ marginBottom: 12 }}>
            <strong>Setup needed for {setupNeeded.name}:</strong>
            <ul>
              {setupNeeded.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Notice>
        )}
        <h2 style={{ fontSize: 14 }}>Built-in ({builtinTemplates.length})</h2>
        <div className="tool-grid">
          {builtinTemplates.map((t) => renderCard(t, true))}
        </div>
        <h2 style={{ fontSize: 14, marginTop: 20 }}>Mine ({userTemplates.length})</h2>
        {userTemplates.length === 0 && (
          <p className="field-hint">
            Save any workflow as a template from the Workflows tab, or import JSON below.
          </p>
        )}
        <div className="tool-grid">{userTemplates.map((t) => renderCard(t, false))}</div>
        <p className="field-hint" style={{ marginTop: 20 }}>
          Tip: save any workflow as a template from the Workflows tab (“Save as
          template”), or bring a portable template in with <strong>Import JSON…</strong>{' '}
          above. Every card can also <strong>Export JSON</strong> for sharing.
        </p>
      </div>
      {ioModal !== null && (
        <Modal
          label={
            ioModal.mode === 'import' ? 'Import template JSON' : 'Export template JSON'
          }
          onClose={() => {
            setIoModal(null);
          }}
          closeLabel="Close template import/export"
          onBackdrop={() => {
            setIoModal(null);
          }}
        >
          <div>
            {ioModal.mode === 'import' ? (
              <>
                <h3 style={{ marginTop: 0 }}>Import template JSON</h3>
                <p className="field-hint">
                  Pasted JSON is validated before anything is stored; secrets are refused.
                </p>
                <div className="field">
                  <label className="field-label" htmlFor="tpl-import">
                    Template JSON
                  </label>
                  <textarea
                    id="tpl-import"
                    className="textarea"
                    rows={8}
                    value={importText}
                    onChange={(e) => {
                      setImportText(e.target.value);
                    }}
                    placeholder='{"id": "...", "name": "...", ...}'
                  />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary" onClick={doImport}>
                    Import into my library
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      setIoModal(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 style={{ marginTop: 0 }}>Export: {ioModal.name}</h3>
                <p className="field-hint">
                  Portable JSON — no secrets inside by construction. Copy and share it, or
                  import it on another machine.
                </p>
                <textarea
                  className="textarea"
                  rows={10}
                  readOnly
                  value={ioModal.json}
                  aria-label="Exported template JSON"
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(ioModal.json)
                        .then(() => {
                          setCopied(true);
                        })
                        .catch(() => {
                          setCopied(false);
                        });
                    }}
                  >
                    {copied ? 'Copied ✓' : 'Copy'}
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      setIoModal(null);
                    }}
                  >
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
