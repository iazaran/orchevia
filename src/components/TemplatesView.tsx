import { useState } from 'react';
import { ADAPTER_LABELS } from '../lib/agents';
import { getBackend } from '../lib/backend';
import type { WorkflowTemplate } from '../lib/generation';
import { confirmDialog } from './ConfirmDialog';
import { useAppStore } from '../store';
import { CloseButton } from './CloseButton';
import { Modal } from './Modal';
import { Notice, useNoticeMessage } from './Notice';
import { ToolGrantNotice } from './ToolGrantNotice';
import { errorMessage } from '../lib/errors';
import { setWorkflowDefaults, validateWorkflowLocal } from '../lib/workflow';
import { DirPicker } from './DirPicker';

export function TemplatesView(): React.JSX.Element {
  const builtinTemplates = useAppStore((s) => s.builtinTemplates);
  const userTemplates = useAppStore((s) => s.userTemplates);
  const refreshLibrary = useAppStore((s) => s.refreshLibrary);
  const refreshWorkflows = useAppStore((s) => s.refreshWorkflows);
  const selectWorkflow = useAppStore((s) => s.selectWorkflow);
  const setView = useAppStore((s) => s.setView);

  const [message, setMessage, messageVariant, messageEvent] = useNoticeMessage();
  const [setupNeeded, setSetupNeeded] = useState<{
    name: string;
    items: string[];
  } | null>(null);
  const [useTarget, setUseTarget] = useState<{
    template: WorkflowTemplate;
    builtin: boolean;
    repoDir: string;
    mcpServerId: string;
  } | null>(null);
  const [useRoleMap, setUseRoleMap] = useState<Record<string, string> | undefined>();
  const mcpServers = useAppStore((s) => s.mcpServers);
  const [importText, setImportText] = useState('');
  const [ioModal, setIoModal] = useState<
    { mode: 'import' } | { mode: 'export'; name: string; json: string } | null
  >(null);
  const [copied, setCopied] = useState(false);
  // The last imported template, checked against the profiles its roles map to.
  const [imported, setImported] = useState<{
    template: WorkflowTemplate;
    roleMap: Record<string, string>;
  } | null>(null);

  const reload = (): void => {
    void refreshLibrary();
  };

  const openUse = (template: WorkflowTemplate, builtin: boolean): void => {
    const servers = useAppStore.getState().mcpServers.filter((s) => s.enabled);
    setUseTarget({
      template,
      builtin,
      repoDir: useAppStore.getState().knownFolders[0] ?? '',
      mcpServerId: servers.length === 1 ? (servers[0]?.id ?? '') : '',
    });
    setUseRoleMap(undefined);
    void getBackend()
      .roleMapDefault()
      .then(setUseRoleMap)
      .catch(() => {
        setUseRoleMap({});
      });
  };

  const instantiate = (): void => {
    if (useTarget === null) return;
    const { template, builtin, repoDir, mcpServerId } = useTarget;
    setUseTarget(null);
    void getBackend()
      .instantiateTemplate(template.id, builtin)
      .then((preview) => {
        // The template works in the chosen repository; ticket and MCP steps
        // use the chosen server unless the template already names one.
        let workflow = setWorkflowDefaults(preview.workflow, repoDir, '');
        if (mcpServerId !== '')
          workflow = {
            ...workflow,
            nodes: workflow.nodes.map((n) =>
              (n.type === 'ticket' || n.type === 'mcp') &&
              (n.config.mcpServerId ?? '') === ''
                ? { ...n, config: { ...n.config, mcpServerId } }
                : n,
            ),
          };
        const remaining = validateWorkflowLocal(workflow)
          .filter((issue) => issue.severity === 'error')
          .map((issue) => issue.message);
        setSetupNeeded(
          remaining.length > 0
            ? { name: template.name, items: [...new Set(remaining)] }
            : null,
        );
        const profiles = useAppStore.getState().profiles;
        const chosen = [
          ...new Set(
            workflow.nodes
              .filter((n) => n.type === 'agent')
              .map((n) => n.config.agentProfileId),
          ),
        ];
        const details = chosen.map((id) => {
          const profile = profiles.find((p) => p.id === id);
          return profile
            ? `${profile.name} (${ADAPTER_LABELS[profile.adapter]}, ${profile.model || 'CLI default'})`
            : `Missing profile: ${id ?? 'none'}`;
        });
        return getBackend()
          .saveWorkflow(workflow)
          .then((stored) => {
            if (details.length)
              useAppStore.getState().pushUiNotice({
                content: `Template '${template.name}' uses Agent Profiles: ${details.join('; ')}.`,
              });
            return stored;
          });
      })
      .then((stored) => {
        void refreshWorkflows().then(() => {
          selectWorkflow(stored.id);
          setView('workflows');
        });
      })
      .catch((err: unknown) => {
        setMessage(errorMessage(err), 'error');
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
        setMessage(errorMessage(err), 'error');
      });
  };

  const doImport = (): void => {
    if (importText.trim() === '') {
      setMessage('Paste workflow or template JSON first, then Import.', 'warn');
      return;
    }
    void getBackend()
      .importTemplate(importText)
      .then(async (t) => {
        setImportText('');
        setIoModal(null);
        setMessage(`Imported template '${t.name}'.`);
        reload();
        const roleMap = await getBackend()
          .roleMapDefault()
          .catch(() => ({}));
        setImported({ template: t, roleMap });
      })
      .catch((err: unknown) => {
        setMessage(errorMessage(err), 'error');
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
          setMessage(errorMessage(err), 'error');
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
      {(template.workflow.inputs?.length ?? 0) > 0 && (
        <p className="field-hint">
          Asks when run:{' '}
          {template.workflow.inputs?.map((i) => i.label ?? i.name).join(' · ')}
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'nowrap' }}>
        <button
          className="btn btn-primary"
          style={{ whiteSpace: 'nowrap' }}
          onClick={() => {
            openUse(template, builtin);
          }}
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
            title="Paste workflow or template JSON to add a new template to your library"
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
        {imported !== null && (
          <ToolGrantNotice
            workflow={imported.template.workflow}
            roleMap={imported.roleMap}
            style={{ marginBottom: 12 }}
            onDismiss={() => {
              setImported(null);
            }}
          />
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
      {useTarget !== null && (
        <Modal
          label={`Use template ${useTarget.template.name}`}
          onClose={() => {
            setUseTarget(null);
          }}
          closeLabel="Close template setup"
          onBackdrop={() => {
            setUseTarget(null);
          }}
        >
          <div>
            <h3 style={{ marginTop: 0 }}>Use “{useTarget.template.name}”</h3>
            <p className="field-hint">{useTarget.template.description}</p>
            <DirPicker
              id="tpl-repo"
              label="Repository folder (required)"
              value={useTarget.repoDir}
              placeholder="/path/to/your/project"
              onChange={(repoDir) => {
                setUseTarget({ ...useTarget, repoDir });
              }}
            />
            <p className="field-hint">
              Every step works here: AI agents edit and review this repository, and
              commands, Git and GitHub steps run in it. You can change it later in the
              workflow settings.
            </p>
            {useTarget.template.workflow.nodes.some(
              (n) => n.type === 'ticket' || n.type === 'mcp',
            ) && (
              <div className="field">
                <label className="field-label" htmlFor="tpl-mcp">
                  Jira / MCP server
                </label>
                {mcpServers.some((s) => s.enabled) ? (
                  <select
                    id="tpl-mcp"
                    className="input"
                    value={useTarget.mcpServerId}
                    onChange={(e) => {
                      setUseTarget({ ...useTarget, mcpServerId: e.target.value });
                    }}
                  >
                    <option value="">Choose later</option>
                    {mcpServers
                      .filter((s) => s.enabled)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                ) : (
                  <p className="field-hint">
                    No MCP server yet: add your Jira server under Environment → MCP
                    servers, then pick it on the ticket step.
                  </p>
                )}
              </div>
            )}
            {(useTarget.template.workflow.inputs?.length ?? 0) > 0 && (
              <div className="field">
                <span className="field-label">Each run asks for</span>
                <ul className="preview-checklist">
                  {useTarget.template.workflow.inputs?.map((input) => (
                    <li key={input.name}>
                      {input.label ?? input.name}
                      {input.default !== undefined && ` (default: ${input.default})`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {useRoleMap !== undefined && (
              <ToolGrantNotice
                workflow={useTarget.template.workflow}
                roleMap={useRoleMap}
                style={{ marginBottom: 12 }}
              />
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-primary"
                disabled={useTarget.repoDir.trim() === ''}
                title={
                  useTarget.repoDir.trim() === ''
                    ? 'Choose the repository this workflow works in'
                    : 'Create the workflow and open it on the canvas'
                }
                onClick={instantiate}
              >
                Create workflow
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setUseTarget(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}
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
                  Paste Simple JSON, Advanced workflow JSON, or an exported template. A
                  new template is created directly; configuration and role references are
                  preserved. Invalid JSON and secrets are refused.
                </p>
                <div className="field">
                  <label className="field-label" htmlFor="tpl-import">
                    Workflow or template JSON
                  </label>
                  <textarea
                    id="tpl-import"
                    className="textarea"
                    rows={8}
                    value={importText}
                    onChange={(e) => {
                      setImportText(e.target.value);
                    }}
                    placeholder='{"version": 1, "name": "My template", "nodes": [...], "edges": [...]}'
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
