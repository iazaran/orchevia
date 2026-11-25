import { useMemo, useState } from 'react';
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
import { CopyButton } from './CopyButton';
import { JsonEditor, JsonView } from './JsonEditor';
import { Segmented } from './Segmented';
import { prepareImportText, toN8n } from '../lib/n8n';
import { MCP_PRESETS } from '../lib/integrations';

const STARTER_TEMPLATE = 'first-workflow';

/** Steps that run in a repository: commands, Git, GitHub or agents that edit files. */
function templateNeedsRepository(template: WorkflowTemplate): boolean {
  return template.workflow.nodes.some(
    (n) =>
      n.type === 'command' ||
      n.type === 'git' ||
      n.type === 'github' ||
      (n.type === 'agent' && (n.config.requiredTools?.length ?? 0) > 0),
  );
}

/** The MCP setups whose tools a template's MCP and Ticket steps call. */
function expectedMcpSetups(template: WorkflowTemplate): string[] {
  const tools = template.workflow.nodes.flatMap((n) =>
    n.type === 'ticket'
      ? ['jira_get_issue']
      : n.type === 'mcp'
        ? [n.config.mcpTool ?? '']
        : [],
  );
  return MCP_PRESETS.filter((preset) =>
    preset.tools.some((tool) => tools.includes(tool.name)),
  ).map((preset) => preset.name);
}

function categoryTone(category: string): string {
  switch (category) {
    case 'research':
      return 'cyan';
    case 'getting-started':
      return 'green';
    case 'review':
      return 'violet';
    case 'bugfix':
      return 'red';
    case 'feature':
      return 'blue';
    case 'integration':
      return 'pink';
    default:
      return 'amber';
  }
}

export function TemplatesView(): React.JSX.Element {
  const builtinTemplates = useAppStore((s) => s.builtinTemplates);
  const starter = builtinTemplates.find((template) => template.id === STARTER_TEMPLATE);
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
    | { mode: 'import' }
    | {
        mode: 'export';
        name: string;
        json: string;
        workflow: WorkflowTemplate['workflow'];
      }
    | null
  >(null);
  const [exportFormat, setExportFormat] = useState<'orchevia' | 'n8n'>('orchevia');
  const profiles = useAppStore((s) => s.profiles);
  const importPrepared = useMemo(() => prepareImportText(importText), [importText]);
  // The last imported template, checked against the profiles its roles map to.
  const [imported, setImported] = useState<{
    template: WorkflowTemplate;
    roleMap: Record<string, string>;
  } | null>(null);

  const reload = (): void => {
    void refreshLibrary();
  };
  const needsRepository =
    useTarget !== null &&
    !(useTarget.builtin && useTarget.template.id === STARTER_TEMPLATE) &&
    templateNeedsRepository(useTarget.template);
  // Agent steps can work in a folder even when nothing requires one.
  const optionalRepository =
    useTarget !== null &&
    !needsRepository &&
    !(useTarget.builtin && useTarget.template.id === STARTER_TEMPLATE) &&
    useTarget.template.workflow.nodes.some((n) => n.type === 'agent');
  const expectedSetups = useTarget === null ? [] : expectedMcpSetups(useTarget.template);

  const openUse = (template: WorkflowTemplate, builtin: boolean): void => {
    const servers = useAppStore.getState().mcpServers.filter((s) => s.enabled);
    setUseTarget({
      template,
      builtin,
      repoDir:
        (builtin && template.id === STARTER_TEMPLATE) ||
        !templateNeedsRepository(template)
          ? (template.workflow.defaults?.repoDir ?? '')
          : (template.workflow.defaults?.repoDir ??
            useAppStore.getState().knownFolders[0] ??
            ''),
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
        let workflow = setWorkflowDefaults(
          preview.workflow,
          repoDir,
          preview.workflow.defaults?.branch ?? '',
        );
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
            if (details.length) {
              const fresh = preview.freshSessionSteps?.join(', ');
              useAppStore.getState().pushUiNotice({
                content: `Template '${template.name}' uses Agent Profiles: ${details.join('; ')}.${fresh ? ` These steps use fresh sessions with the selected CLI: ${fresh}.` : ''}`,
              });
            }
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
        setExportFormat('orchevia');
        setIoModal({
          mode: 'export',
          name: template.name,
          json,
          workflow: template.workflow,
        });
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
    const prepared = importPrepared;
    void getBackend()
      .importTemplate(prepared.json)
      .then(async (t) => {
        setImportText('');
        setIoModal(null);
        setMessage(
          prepared.source === 'n8n'
            ? `Imported n8n workflow as template '${t.name}'. ${String(prepared.notes.length)} conversion note${prepared.notes.length === 1 ? '' : 's'}: ${prepared.notes.join(' ')}`
            : `Imported template '${t.name}'.`,
          prepared.source === 'n8n' && prepared.notes.length > 0 ? 'warn' : 'info',
        );
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
    <div key={template.id} className="tool-card template-card">
      {!builtin && (
        <CloseButton
          variant="card"
          label={`Delete template '${template.name}'`}
          title={`Delete template '${template.name}'`}
          onClose={() => removeUser(template.id, template.name)}
        />
      )}
      <div className="template-card-head" style={{ paddingRight: builtin ? 0 : 36 }}>
        <h3>{template.name}</h3>
        <div className="template-tags">
          <span className={`tag tag-${categoryTone(template.category)}`}>
            {template.category}
          </span>
          {template.workflow.nodes.some(
            (n) => n.type === 'mcp' || n.type === 'ticket',
          ) && (
            <span className="tag tag-mcp" title="Needs an MCP server from Environment">
              MCP
            </span>
          )}
          <span className="tag">
            {String(template.workflow.nodes.length)} steps · v{template.version}
          </span>
        </div>
      </div>
      <p className="template-desc">{template.description}</p>
      {(template.workflow.inputs?.length ?? 0) > 0 && (
        <p className="template-inputs">
          <span>Asks for</span>{' '}
          {template.workflow.inputs?.map((i) => (
            <code key={i.name} title={i.label ?? i.name}>
              {i.name}
            </code>
          ))}
        </p>
      )}
      <div className="template-actions">
        <button
          className="btn btn-primary"
          onClick={() => {
            openUse(template, builtin);
          }}
        >
          Use template
        </button>
        <button
          className="btn btn-ghost"
          title="Copy this template as Orchevia or n8n JSON (validated, secrets refused)"
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
        <h2 className="section-title">Built-in ({builtinTemplates.length})</h2>
        <div className="tool-grid">
          {starter !== undefined && renderCard(starter, true)}
          {builtinTemplates
            .filter((t) => t.id !== STARTER_TEMPLATE)
            .map((t) => renderCard(t, true))}
        </div>
        <h2 className="section-title">Mine ({userTemplates.length})</h2>
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
            {needsRepository && (
              <>
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
              </>
            )}
            {optionalRepository && (
              <>
                <DirPicker
                  id="tpl-repo"
                  label="Folder for AI steps (optional)"
                  value={useTarget.repoDir}
                  placeholder="/path/to/your/project"
                  onChange={(repoDir) => {
                    setUseTarget({ ...useTarget, repoDir });
                  }}
                />
                <p className="field-hint">
                  AI steps read files here when the prompt needs them. Leave it empty when
                  the steps only work with what earlier steps return.
                </p>
              </>
            )}
            {useTarget.template.workflow.nodes.some(
              (n) => n.type === 'ticket' || n.type === 'mcp',
            ) && (
              <div className="field">
                <label className="field-label" htmlFor="tpl-mcp">
                  MCP server
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
                    No MCP server yet: add one under Environment → + New MCP server, then
                    pick it on the step.
                  </p>
                )}
                {expectedSetups.length > 0 && (
                  <p className="field-hint">
                    Expects the <strong>{expectedSetups.join(' or ')}</strong> setup from
                    Environment → + New MCP server.
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
                disabled={needsRepository && useTarget.repoDir.trim() === ''}
                title={
                  needsRepository && useTarget.repoDir.trim() === ''
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
                  Paste Simple JSON, Advanced workflow JSON, an exported template, or an{' '}
                  <strong>n8n workflow</strong>. A new template is created directly;
                  configuration and role references are preserved. Invalid JSON and
                  secrets are refused.
                </p>
                <div className="field">
                  <div className="field-row">
                    <label className="field-label" htmlFor="tpl-import">
                      Workflow or template JSON
                    </label>
                    {importText.trim() !== '' && (
                      <span
                        className={`format-badge ${importPrepared.source === 'n8n' ? 'is-n8n' : ''}`}
                      >
                        {importPrepared.source === 'n8n'
                          ? 'n8n workflow'
                          : 'Orchevia JSON'}
                      </span>
                    )}
                  </div>
                  <JsonEditor
                    id="tpl-import"
                    rows={10}
                    allowEmpty
                    value={importText}
                    onChange={setImportText}
                  />
                </div>
                {importPrepared.source === 'n8n' && importPrepared.notes.length > 0 && (
                  <div className="transfer-notes" style={{ marginBottom: 12 }}>
                    <span className="field-label">Conversion notes</span>
                    <ul>
                      {importPrepared.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  </div>
                )}
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
                  {exportFormat === 'n8n'
                    ? 'n8n workflow JSON: paste it onto an n8n canvas (Ctrl+V or ⌘V) or import it from a file.'
                    : 'Portable JSON — no secrets inside by construction. Copy and share it, or import it on another machine.'}
                </p>
                <Segmented
                  label="Export format"
                  className="transfer-switches"
                  value={exportFormat}
                  onChange={setExportFormat}
                  options={[
                    { value: 'orchevia', label: 'Orchevia template' },
                    { value: 'n8n', label: 'n8n workflow' },
                  ]}
                />
                <JsonView
                  className="transfer-output"
                  value={
                    exportFormat === 'n8n'
                      ? toN8n(ioModal.workflow, profiles).workflow
                      : ioModal.json
                  }
                />
                {exportFormat === 'n8n' &&
                  toN8n(ioModal.workflow, profiles).notes.length > 0 && (
                    <div className="transfer-notes">
                      <span className="field-label">What changes in n8n</span>
                      <ul>
                        {toN8n(ioModal.workflow, profiles).notes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <CopyButton
                    className="btn btn-primary"
                    label={exportFormat === 'n8n' ? 'Copy n8n JSON' : 'Copy'}
                    text={
                      exportFormat === 'n8n'
                        ? JSON.stringify(
                            toN8n(ioModal.workflow, profiles).workflow,
                            null,
                            2,
                          )
                        : ioModal.json
                    }
                  />
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
