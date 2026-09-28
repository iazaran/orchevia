import { useState } from 'react';
import { getBackend } from '../lib/backend';
import {
  newMcpId,
  validateMcpServer,
  type McpServerConfig,
  type McpToolInfo,
} from '../lib/integrations';
import { confirmDialog } from './ConfirmDialog';
import { useAppStore } from '../store';
import { CloseButton } from './CloseButton';
import { Modal } from './Modal';
import { Notice } from './Notice';
import { errorMessage } from '../lib/errors';

export function EnvironmentView(): React.JSX.Element {
  const tools = useAppStore((s) => s.tools);
  const adapters = useAppStore((s) => s.adapters);
  const profiles = useAppStore((s) => s.profiles);
  const mcpServers = useAppStore((s) => s.mcpServers);
  const githubState = useAppStore((s) => s.githubState);
  const refreshTools = useAppStore((s) => s.refreshTools);
  const refreshProfiles = useAppStore((s) => s.refreshProfiles);
  const refreshIntegrations = useAppStore((s) => s.refreshIntegrations);
  const setView = useAppStore((s) => s.setView);

  const [editing, setEditing] = useState<McpServerConfig | null>(null);
  const [serverTools, setServerTools] = useState<
    Record<
      string,
      | { state: 'loading' }
      | { state: 'ready'; tools: McpToolInfo[] }
      | { state: 'error'; message: string }
    >
  >({});
  const [message, setMessage] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string | null>(null);

  const refreshAll = (): void => {
    void Promise.all([refreshTools(), refreshProfiles(), refreshIntegrations()]);
  };

  const saveServer = (server: McpServerConfig): void => {
    const errors = validateMcpServer(server);
    if (errors.length > 0) {
      setMessage(errors[0] ?? 'Invalid server.');
      return;
    }
    void getBackend()
      .saveMcpServer(server)
      .then(() => refreshIntegrations())
      .then(() => {
        setEditing(null);
        setMessage(`Saved MCP server '${server.name}'.`);
      })
      .catch((err: unknown) => {
        setMessage(errorMessage(err));
      });
  };

  const removeServer = (id: string, name: string): void => {
    void confirmDialog({
      title: `Delete MCP server '${name}'?`,
      message: 'Workflows using it will fail validation.',
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      return getBackend()
        .deleteMcpServer(id)
        .then(() => refreshIntegrations())
        .catch((err: unknown) => {
          setMessage(errorMessage(err));
        });
    });
  };

  const listTools = (id: string): void => {
    setServerTools((prev) => ({ ...prev, [id]: { state: 'loading' } }));
    void getBackend()
      .mcpListTools(id)
      .then((tools) => {
        setServerTools((prev) => ({
          ...prev,
          [id]: { state: 'ready', tools: [...tools] },
        }));
      })
      .catch((err: unknown) => {
        setServerTools((prev) => ({
          ...prev,
          [id]: {
            state: 'error',
            message: errorMessage(err),
          },
        }));
      });
  };

  return (
    <>
      <div className="topbar">
        <h1>Environment</h1>
        <span className="topbar-sub">
          Optional local tools — the app works with or without them.
        </span>
        <div className="topbar-actions">
          <button className="btn" onClick={refreshAll}>
            Re-detect
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
        <Notice>
          Orchevia never installs tools for you. Install and authenticate <code>git</code>
          , <code>gh</code>, <code>claude</code> or <code>codex</code> yourself; Orchevia
          discovers them on <code>PATH</code> and delegates AI work to them. Those tools
          may contact their own providers — Orchevia itself sends nothing anywhere.
        </Notice>

        <h2 style={{ fontSize: 14, marginTop: 20 }}>Local CLIs</h2>
        <div className="tool-grid">
          {tools.map((tool) => (
            <div key={tool.id} className="tool-card">
              <h3>{tool.displayName}</h3>
              <div style={{ margin: '6px 0' }}>
                <span
                  className={`status-pill ${tool.installed ? 'status-succeeded' : 'status-cancelled'}`}
                >
                  {tool.installed ? 'Installed' : 'Not found'}
                </span>
              </div>
              {tool.version !== undefined && (
                <div className="tool-version">{tool.version}</div>
              )}
              {tool.path !== undefined && (
                <div className="tool-version" title={tool.path}>
                  {tool.path}
                </div>
              )}
              {!tool.installed && (
                <p className="field-hint" style={{ marginBottom: 0 }}>
                  Optional. Workflows that need it will fail validation with a clear
                  message.
                </p>
              )}
            </div>
          ))}
        </div>
        {tools.length === 0 && <p className="field-hint">Detecting tools…</p>}

        {adapters.length > 0 && (
          <>
            <h2 style={{ fontSize: 14, marginTop: 20 }}>AI CLI adapters</h2>
            <p className="field-hint">
              Orchevia builds argv per adapter (
              {adapters
                .map((a) => a.defaultExecutable)
                .filter((e) => e !== '')
                .join(', ')}
              ) — the engine never embeds CLI-specific syntax. {profiles.length} Agent
              Profile(s) configured.{' '}
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setView('agents');
                }}
              >
                Manage profiles
              </button>
            </p>
          </>
        )}

        <h2 style={{ fontSize: 14, marginTop: 20 }}>Git</h2>
        <p className="field-hint" style={{ maxWidth: 720 }}>
          Git runs inside workflows through Git nodes (status, commit, branches,
          worktrees) — pick the working directory on the node itself in the Workflows
          view. Use the Samples dialog there for a ready-made Commit + PR flow.
        </p>

        <h2 style={{ fontSize: 14, marginTop: 20 }}>GitHub via gh</h2>
        {githubState === null ? (
          <p className="field-hint">Detecting…</p>
        ) : (
          <div className="tool-card" style={{ maxWidth: 640 }}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <span
                className={`status-pill ${githubState.installed ? 'status-succeeded' : 'status-cancelled'}`}
              >
                {githubState.installed ? 'gh installed' : 'gh not found'}
              </span>
              {githubState.installed && (
                <span
                  className={`status-pill ${githubState.authenticated ? 'status-succeeded' : 'status-paused'}`}
                >
                  {githubState.authenticated
                    ? `authenticated${githubState.user !== undefined ? ` as ${githubState.user}` : ''}`
                    : 'not authenticated'}
                </span>
              )}
            </div>
            {!githubState.installed && (
              <p className="field-hint">
                Install <code>gh</code> and run <code>gh auth login</code> yourself to
                enable GitHub nodes. No tokens ever enter Orchevia.
              </p>
            )}
            {githubState.installed && !githubState.authenticated && (
              <p className="field-hint">
                Run <code>gh auth login</code> in a terminal. GitHub nodes fail with a
                clear message until then.
              </p>
            )}
          </div>
        )}

        <h2 style={{ fontSize: 14, marginTop: 20 }}>MCP servers ({mcpServers.length})</h2>
        <p className="field-hint" style={{ maxWidth: 720 }}>
          Local stdio servers (command + args only — Orchevia stores no secrets and passes
          no credentials; the child inherits the normal environment). Used by Ticket nodes
          (Jira) and MCP Tool nodes. Disabled or missing servers fail validation instead
          of running.
        </p>
        <div className="tool-grid">
          {mcpServers.map((s) => {
            const tools = serverTools[s.id];
            return (
              <div key={s.id} className="tool-card" style={{ position: 'relative' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    paddingRight: 36,
                  }}
                >
                  <h3 style={{ margin: 0 }}>{s.name}</h3>
                  <span
                    className={`status-pill ${s.enabled ? 'status-succeeded' : 'status-paused'}`}
                  >
                    {s.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
                <CloseButton
                  variant="card"
                  label={`Delete MCP server '${s.name}'`}
                  title={`Delete MCP server '${s.name}'`}
                  onClose={() => {
                    removeServer(s.id, s.name);
                  }}
                />
                <div className="tool-version" style={{ marginTop: 6 }}>
                  {s.command} {s.args.join(' ')}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      listTools(s.id);
                    }}
                  >
                    {tools === undefined ? 'List tools' : 'Refresh tools'}
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      setEditing({ ...s, args: [...s.args] });
                    }}
                  >
                    Edit
                  </button>
                </div>
                {tools !== undefined && (
                  <div style={{ marginTop: 8 }}>
                    {tools.state === 'loading' && (
                      <p className="field-hint" aria-live="polite">
                        Listing tools…
                      </p>
                    )}
                    {tools.state === 'ready' && tools.tools.length === 0 && (
                      <p className="field-hint">
                        No tools exposed — the server started but listed none. Check it
                        implements MCP tools/list and that its env vars are set.
                      </p>
                    )}
                    {tools.state === 'ready' && tools.tools.length > 0 && (
                      <McpToolsList tools={tools.tools} />
                    )}
                    {tools.state === 'error' && (
                      <Notice variant="error" style={{ marginBottom: 0 }}>
                        Failed: {tools.message}
                      </Notice>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <button
          className="btn"
          style={{ marginTop: 10 }}
          onClick={() => {
            setEditing({
              id: newMcpId(),
              name: '',
              command: '',
              args: [],
              enabled: true,
            });
          }}
        >
          + New MCP server
        </button>

        {editing !== null && (
          <Modal
            label="MCP server editor"
            onClose={() => {
              setEditing(null);
            }}
            closeLabel="Close server editor"
            onBackdrop={() => {
              setEditing(null);
            }}
          >
            <div>
              <McpEditor
                initial={editing}
                onCancel={() => {
                  setEditing(null);
                }}
                onSave={saveServer}
              />
            </div>
          </Modal>
        )}

        <h2 style={{ fontSize: 14, marginTop: 20 }}>Diagnostics</h2>
        <p className="field-hint" style={{ maxWidth: 720 }}>
          Local-only support bundle: versions, counts, tool availability, recent error
          titles. No prompts, files, or credentials. Review it before sharing.
        </p>
        <button
          className="btn"
          onClick={() => {
            void getBackend()
              .diagnosticsBundle()
              .then((json) => {
                setDiagnostics(json);
                setMessage(null);
              })
              .catch((err: unknown) => {
                setMessage(errorMessage(err));
              });
          }}
        >
          Export diagnostics bundle
        </button>
        {diagnostics !== null && (
          <DiagnosticsModal
            bundle={diagnostics}
            onClose={() => {
              setDiagnostics(null);
            }}
          />
        )}
      </div>
    </>
  );
}

/**
 * Compact MCP tool browser. Servers like the Jira one expose 60+ tools with
 * multi-paragraph descriptions — rendering them inline would stretch the card
 * for pages. So: one row per tool (name + first line), a filter box, a
 * capped scroll region, and the full text one click away in <details>.
 */
function McpToolsList({ tools }: { tools: McpToolInfo[] }): React.JSX.Element {
  const [filter, setFilter] = useState('');
  const query = filter.trim().toLowerCase();
  const visible =
    query === ''
      ? tools
      : tools.filter(
          (t) =>
            t.name.toLowerCase().includes(query) ||
            t.description.toLowerCase().includes(query),
        );
  return (
    <div>
      <p className="field-hint" style={{ margin: '0 0 6px' }}>
        {tools.length} tool{tools.length === 1 ? '' : 's'}
        {query !== '' &&
          ` · ${String(visible.length)} match${visible.length === 1 ? '' : 'es'}`}
      </p>
      {tools.length > 5 && (
        <input
          className="input"
          style={{ marginBottom: 6 }}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
          }}
          placeholder="Filter tools…"
          aria-label="Filter MCP tools"
        />
      )}
      {visible.length === 0 ? (
        <p className="field-hint">No tools match “{filter.trim()}”.</p>
      ) : (
        <ul className="mcp-tools-list" aria-label="MCP tools">
          {visible.map((t) => (
            <li key={t.name} className="mcp-tool-row">
              <details>
                <summary
                  className="mcp-tool-summary"
                  title={t.description !== '' ? t.description : t.name}
                >
                  <code className="mcp-tool-name">{t.name}</code>
                  {firstLine(t.description) !== '' && (
                    <span className="mcp-tool-brief">{firstLine(t.description)}</span>
                  )}
                </summary>
                {t.description !== '' && <p className="mcp-tool-full">{t.description}</p>}
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0]?.trim() ?? '';
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

function McpEditor({
  initial,
  onCancel,
  onSave,
}: {
  initial: McpServerConfig;
  onCancel: () => void;
  onSave: (s: McpServerConfig) => void;
}): React.JSX.Element {
  const [form, setForm] = useState<McpServerConfig>(initial);
  const errors = validateMcpServer(form);
  const set = (patch: Partial<McpServerConfig>): void => {
    setForm((f) => ({ ...f, ...patch }));
  };
  const fillJiraExample = (): void => {
    setForm((f) => ({
      ...f,
      name: f.name.trim() === '' ? 'Jira' : f.name,
      command: 'uvx',
      args: ['mcp-atlassian'],
    }));
  };
  return (
    <>
      <h3 style={{ marginTop: 0 }}>MCP server</h3>
      <details className="guide-box">
        <summary>Setting up Jira? Step-by-step guide</summary>
        <ol style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          <li>
            Install <code>uv</code> (provides <code>uvx</code>) if missing:{' '}
            <code>curl -LsSf astral.sh/uv/install.sh | sh</code>
          </li>
          <li>
            Press <strong>Fill Jira example</strong> below, then Save. It uses the{' '}
            <code>mcp-atlassian</code> package — edit the command if your setup differs.
          </li>
          <li>
            Give the server its credentials <em>outside</em> Orchevia (it inherits your
            shell environment; never paste secrets here) — snippet and checker below.
          </li>
          <li>
            Back in the list, press <strong>List tools</strong> — you should see{' '}
            <code>jira_get_issue</code>. Ticket nodes call it by default: reference the
            server from a Ticket node with a key like <code>{'{{input.ticket}}'}</code>;
            fields become <code>ticket.key</code>, <code>ticket.title</code>,{' '}
            <code>ticket.description</code>, <code>ticket.acceptanceCriteria</code>.
            Ticket text is untrusted input — passed to agents as data, never executed.
          </li>
        </ol>
        <JiraCredentialsBody />
      </details>
      <div className="field">
        <label className="field-label" htmlFor="mcp-name">
          Name
        </label>
        <input
          id="mcp-name"
          className="input"
          value={form.name}
          placeholder="Jira"
          onChange={(e) => {
            set({ name: e.target.value });
          }}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="field">
          <label className="field-label" htmlFor="mcp-cmd">
            Command
          </label>
          <input
            id="mcp-cmd"
            className="input"
            value={form.command}
            placeholder="npx / uvx / /path/to/server"
            onChange={(e) => {
              set({ command: e.target.value });
            }}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="mcp-enabled">
            State
          </label>
          <select
            id="mcp-enabled"
            className="input"
            value={form.enabled ? 'on' : 'off'}
            onChange={(e) => {
              set({ enabled: e.target.value === 'on' });
            }}
          >
            <option value="on">Enabled</option>
            <option value="off">Disabled</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="mcp-args">
          Arguments (one per line, no secrets)
        </label>
        <textarea
          id="mcp-args"
          className="textarea"
          rows={2}
          value={form.args.join('\n')}
          onChange={(e) => {
            set({
              args: e.target.value
                .split('\n')
                .map((s) => s.trim())
                .filter((s) => s !== ''),
            });
          }}
        />
      </div>
      {errors.length > 0 && (
        <Notice variant="error" style={{ marginBottom: 12 }}>
          {errors[0]}
        </Notice>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          className="btn btn-primary"
          disabled={errors.length > 0}
          onClick={() => onSave(form)}
        >
          Save server
        </button>
        <button className="btn" onClick={fillJiraExample}>
          Fill Jira example
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}

function DiagnosticsModal({
  bundle,
  onClose,
}: {
  bundle: string;
  onClose: () => void;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    try {
      void navigator.clipboard
        .writeText(bundle)
        .then(() => {
          setCopied(true);
        })
        .catch(() => {
          setCopied(false);
        });
    } catch {
      setCopied(false);
    }
  };
  return (
    <Modal
      label="Diagnostics bundle"
      onClose={onClose}
      closeLabel="Close diagnostics"
      onBackdrop={onClose}
    >
      <div>
        <h3 style={{ marginTop: 0 }}>Diagnostics bundle</h3>
        <p className="field-hint">
          Local-only: versions, counts, tool availability, recent error titles. No
          prompts, files, or credentials. Review before sharing.
        </p>
        <textarea
          className="textarea"
          rows={14}
          readOnly
          value={bundle}
          aria-label="Diagnostics bundle preview"
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" onClick={copy}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

const JIRA_ENV_SNIPPET = `# Where do Jira credentials go? NOT in Orchevia — put them in your shell
# profile (~/.profile, ~/.bashrc or ~/.zshenv), then restart Orchevia so the
# MCP server child inherits them. Jira Cloud example:
export JIRA_URL="https://your-site.atlassian.net"
export JIRA_USERNAME="you@example.com"
export JIRA_API_TOKEN="paste-a-jira-api-token"`;

const JIRA_ENV_VARS = [
  'JIRA_URL',
  'JIRA_USERNAME',
  'JIRA_API_TOKEN',
  'JIRA_PERSONAL_TOKEN',
];

/**
 * Jira credential guide: snippet + names-only env visibility check. Rendered
 * inside the MCP server editor's Jira guide — not as a permanent page
 * section — so it shows where it is acted on.
 */
function JiraCredentialsBody(): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const [envState, setEnvState] = useState<{ name: string; present: boolean }[] | null>(
    null,
  );
  const [checking, setChecking] = useState(false);
  const checkEnv = (): void => {
    setChecking(true);
    void getBackend()
      .mcpEnvPresent(JIRA_ENV_VARS)
      .then(setEnvState)
      .catch(() => {
        setEnvState(null);
      })
      .finally(() => {
        setChecking(false);
      });
  };
  return (
    <>
      <p className="field-hint">
        Orchevia stores no secrets by design. Add these exports to <code>~/.profile</code>
        , <code>~/.bashrc</code> or <code>~/.zshenv</code>, reload your shell, then
        restart Orchevia. For Jira Cloud: <code>JIRA_URL</code>,{' '}
        <code>JIRA_USERNAME</code>, <code>JIRA_API_TOKEN</code>; for Server/DC check the{' '}
        <code>mcp-atlassian</code> README for the token variable. <code>~/.profile</code>{' '}
        needs a full log out + back in; <code>~/.bashrc</code>/<code>~/.zshrc</code> needs
        Orchevia launched from a terminal. Restarting the app alone is not enough.
      </p>
      <p className="field-hint">
        For the suggested <code>uvx mcp-atlassian</code> server, use the names above.{' '}
        <code>JIRA_BASE_URL</code> and <code>JIRA_EMAIL</code> are names a custom shell
        script might use; this MCP server does not read them. If “List tools” shows Jira
        tools, its connection is ready for Ticket and MCP nodes.
      </p>
      <div className="log-block">{JIRA_ENV_SNIPPET}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button
          className="btn"
          onClick={() => {
            try {
              void navigator.clipboard
                .writeText(JIRA_ENV_SNIPPET)
                .then(() => {
                  setCopied(true);
                })
                .catch(() => {
                  setCopied(false);
                });
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? 'Copied ✓' : 'Copy snippet'}
        </button>
        <button className="btn btn-primary" disabled={checking} onClick={checkEnv}>
          {checking ? 'Checking…' : 'Check what Orchevia sees'}
        </button>
      </div>
      {envState !== null && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {envState.map((v) => (
              <span
                key={v.name}
                className={`status-pill ${v.present ? 'status-succeeded' : 'status-cancelled'}`}
                title={
                  v.present
                    ? `${v.name} is visible to Orchevia (value never shown)`
                    : `${v.name} is NOT visible to the running app`
                }
              >
                {v.present ? '✓' : '✕'} {v.name}
              </span>
            ))}
          </div>
          <p className="field-hint" style={{ marginTop: 6 }}>
            Only names are checked — values are never read or shown. Missing here but set
            in a terminal? That proves it: the desktop session never got them. Log out +
            back in (for ~/.profile) or quit and run <code>orchevia</code> from a terminal
            (for ~/.bashrc), then check again. Note: either the Cloud trio (URL + USERNAME
            + API_TOKEN) or a personal token must be present — not necessarily all four.
          </p>
        </div>
      )}
    </>
  );
}
