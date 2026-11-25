import { useState } from 'react';
import { getBackend } from '../lib/backend';
import {
  MCP_CATEGORIES,
  MCP_PRESETS,
  MCP_SETUP_GUIDE,
  matchMcpPreset,
  mcpEnvSnippet,
  newMcpId,
  validateMcpServer,
  type McpCategory,
  type McpPreset,
  type McpServerConfig,
  type McpToolInfo,
  type McpCheckReport,
} from '../lib/integrations';
import {
  ADAPTERS,
  AGENT_SETUP_GUIDE,
  AGENT_SIGN_IN,
  BUILTIN_ADAPTERS,
} from '../lib/agents';
import { AgentPermissionsSettings } from './AgentPermissions';
import { confirmDialog } from './ConfirmDialog';
import { useAppStore } from '../store';
import { CloseButton } from './CloseButton';
import { Modal } from './Modal';
import { Notice, useNoticeMessage } from './Notice';
import { FormError, useSubmitValidation } from './FormValidation';
import { errorMessage } from '../lib/errors';
import { UpdatesSection } from './Updates';
import { LinesTextarea } from './DraftText';
import { CheckList, SetupCheckPanel } from './SetupCheck';
import { CopyButton } from './CopyButton';
import { Segmented } from './Segmented';

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
  const [message, setMessage, messageVariant, messageEvent] = useNoticeMessage();
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  // MCP server checks, run only when asked, per server.
  const [serverChecks, setServerChecks] = useState<
    Record<
      string,
      | { state: 'checking' }
      | { state: 'done'; report: McpCheckReport }
      | { state: 'error'; message: string }
    >
  >({});

  const refreshAll = (): void => {
    void Promise.all([refreshTools(), refreshProfiles(), refreshIntegrations()]);
  };

  const openGuide = (url: string): void => {
    void getBackend()
      .openExternalUrl(url)
      .catch((error: unknown) => setMessage(errorMessage(error), 'error'));
  };

  const saveServer = (server: McpServerConfig): void => {
    const errors = validateMcpServer(server);
    if (errors.length > 0) {
      setMessage(errors[0] ?? 'Invalid server.', 'error');
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
        setMessage(errorMessage(err), 'error');
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
          setMessage(errorMessage(err), 'error');
        });
    });
  };

  const checkServer = (id: string): void => {
    setServerChecks((prev) => ({ ...prev, [id]: { state: 'checking' } }));
    void getBackend()
      .mcpCheckServer(id)
      .then((report) => {
        setServerChecks((prev) => ({ ...prev, [id]: { state: 'done', report } }));
      })
      .catch((err: unknown) => {
        setServerChecks((prev) => ({
          ...prev,
          [id]: { state: 'error', message: errorMessage(err) },
        }));
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
        <h2 className="section-title">Local CLIs</h2>
        <p className="field-hint section-hint">
          Install and sign in to the tools you use, then re-detect to refresh what
          Orchevia can find.
        </p>
        <div className="tool-grid">
          {tools.map((tool) => {
            const agent = BUILTIN_ADAPTERS.find((id) => id === tool.id);
            return (
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
                {agent !== undefined && (
                  <p className="field-hint" style={{ marginBottom: 0 }}>
                    {!tool.installed && (
                      <>
                        Install <code>{ADAPTERS[agent].executable}</code>.{' '}
                      </>
                    )}
                    {AGENT_SIGN_IN[agent].replaceAll('`', '')}
                  </p>
                )}
              </div>
            );
          })}
        </div>
        {tools.length === 0 && <p className="field-hint">Detecting tools…</p>}

        {adapters.length > 0 && (
          <>
            <h2 className="section-title">Agent connections</h2>
            <p className="field-hint section-hint">
              {profiles.length} profiles configured. Use the setup check to verify a
              profile’s sign-in and file access.
            </p>
            <div className="section-actions">
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setView('agents');
                }}
              >
                Agents <span aria-hidden="true">→</span>
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => openGuide(AGENT_SETUP_GUIDE)}
              >
                Agent setup guide
              </button>
            </div>
          </>
        )}

        <h2 id="setup-check" className="section-title">
          Agent setup check
        </h2>
        <SetupCheckPanel profiles={profiles} />

        <h2 id="agent-permissions" className="section-title">
          Agent permissions
        </h2>
        <p className="field-hint section-hint">
          Headless Claude Code and Codex cannot ask for permission while a workflow step
          runs. Configure the app default for Claude Code and Codex here, or set an
          override per profile in Agents. Other agents use their own CLI settings.
        </p>
        <div className="section-panel">
          <AgentPermissionsSettings />
        </div>

        <h2 className="section-title">Git</h2>
        <p className="field-hint section-hint">
          Git runs inside workflows through Git nodes (status, commit, branches,
          worktrees) — pick the working directory on the node itself in the Workflows
          view. Use the Samples dialog there for a ready-made Commit + PR flow.
        </p>

        <h2 className="section-title">GitHub via gh</h2>
        {githubState === null ? (
          <p className="field-hint">Detecting…</p>
        ) : (
          <div className="tool-card section-panel">
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

        <h2 id="mcp-connections" className="section-title">
          MCP connections
        </h2>
        <p className="field-hint section-hint">
          MCP servers give MCP Tool and Ticket steps access to your tools. Start from{' '}
          {String(MCP_PRESETS.length)} ready-made setups such as Google Workspace, GitHub,
          Slack, Jira, Notion and Microsoft 365. Credentials stay in your shell, never in
          Orchevia. Use Check server after saving to verify startup and list its tools.
        </p>
        <div className="section-actions">
          <button
            className="btn btn-primary"
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
          <button className="btn btn-ghost" onClick={() => openGuide(MCP_SETUP_GUIDE)}>
            MCP setup guide
          </button>
        </div>
        <h3 className="section-title">Saved servers ({mcpServers.length})</h3>
        {mcpServers.length === 0 && (
          <div className="empty-inline">
            No MCP servers yet. Choose <strong>+ New MCP server</strong> to pick a setup.
          </div>
        )}
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
                    style={{ marginLeft: 'auto' }}
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
                  {serverChecks[s.id]?.state === 'checking' ? (
                    <button
                      className="btn btn-ghost"
                      onClick={() => {
                        void getBackend().cancelMcpCheck(s.id);
                      }}
                    >
                      Cancel check
                    </button>
                  ) : (
                    <button
                      className="btn btn-ghost"
                      title="Starts the server, lists its tools and compares them with your workflows. Never calls a tool."
                      onClick={() => {
                        checkServer(s.id);
                      }}
                    >
                      Check server
                    </button>
                  )}
                  <button
                    className="btn"
                    onClick={() => {
                      setEditing({ ...s, args: [...s.args] });
                    }}
                  >
                    Edit
                  </button>
                </div>
                {serverChecks[s.id] !== undefined && (
                  <div style={{ marginTop: 8 }} aria-live="polite">
                    {serverChecks[s.id]?.state === 'checking' && (
                      <p className="field-hint">
                        Checking: starting the server and listing its tools (up to 45 s)…
                      </p>
                    )}
                    {(() => {
                      const check = serverChecks[s.id];
                      if (check?.state === 'done')
                        return (
                          <CheckList
                            label={`Server check for ${check.report.serverName}`}
                            items={check.report.items}
                          />
                        );
                      if (check?.state === 'error')
                        return (
                          <Notice variant="error" style={{ marginBottom: 0 }}>
                            Checking {s.name} failed: {check.message}
                          </Notice>
                        );
                      return null;
                    })()}
                  </div>
                )}
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
                        Listing tools for {s.name} failed: {tools.message}
                      </Notice>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
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
            maxWidth={880}
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

        <h2 id="updates" className="section-title">
          Updates
        </h2>
        <UpdatesSection />

        <h2 className="section-title">Diagnostics</h2>
        <p className="field-hint section-hint">
          Local-only support bundle: versions, counts, tool availability, recent error
          titles. No prompts, files, or credentials. Review it before sharing.
        </p>
        <div className="section-actions">
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
                  setMessage(errorMessage(err), 'error');
                });
            }}
          >
            Export diagnostics bundle
          </button>
        </div>
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

const PRESET_TONES = [
  '#4f86ff',
  '#a78bfa',
  '#34d399',
  '#f59e0b',
  '#f472b6',
  '#22d3ee',
  '#fb7185',
];

const PRESET_MARKS: Record<string, string> = {
  'microsoft-365': 'M365',
  'aws-knowledge': 'AWS',
  'google-workspace': 'GW',
  jira: 'JC',
  postgres: 'PG',
  context7: 'C7',
  'cloudflare-docs': 'CF',
  playwright: 'PW',
  'brave-search': 'BS',
};

/** A short mark for a setup tile: GitHub → GH, Slack → S. */
function presetMark(preset: McpPreset): string {
  const fixed = PRESET_MARKS[preset.id];
  if (fixed !== undefined) return fixed;
  const capitals = preset.name.match(/[A-Z]/g) ?? [];
  return (
    capitals.length >= 2 ? capitals.slice(0, 2).join('') : preset.name.charAt(0)
  ).toUpperCase();
}

function presetTone(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PRESET_TONES[hash % PRESET_TONES.length] ?? '#4f86ff';
}

const AUTH_LABEL: Record<McpPreset['auth'], string> = {
  none: 'No sign-in',
  env: 'Token in your shell',
  oauth: 'Browser sign-in',
  login: 'One-time login',
};

function McpPresetPicker({
  onPick,
  onCancel,
}: {
  onPick: (preset: McpPreset | null) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | McpCategory>('all');
  const needle = query.trim().toLowerCase();
  const list = MCP_PRESETS.filter(
    (preset) =>
      (category === 'all' || preset.category === category) &&
      (needle === '' ||
        `${preset.name} ${preset.summary} ${preset.category}`
          .toLowerCase()
          .includes(needle)),
  );
  return (
    <div className="mcp-picker">
      <h3 style={{ marginTop: 0 }}>Add an MCP server</h3>
      <p className="field-hint">
        Pick a ready-made setup to prefill the command and see how to sign in, or start
        blank. Nothing runs until you save and choose Check server.
      </p>
      <div className="mcp-picker-bar">
        <input
          className="input"
          type="search"
          aria-label="Search MCP setups"
          placeholder="Search Google, GitHub, Slack, docs…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Segmented
          label="MCP setup category"
          size="small"
          value={category}
          onChange={setCategory}
          options={[
            { value: 'all', label: 'All' },
            ...MCP_CATEGORIES.map((c) => ({ value: c, label: c })),
          ]}
        />
      </div>
      <div className="mcp-preset-grid">
        {list.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="mcp-preset-tile"
            aria-label={`Set up ${preset.name}`}
            aria-describedby={`mcp-preset-${preset.id}`}
            onClick={() => onPick(preset)}
          >
            <span
              className="mcp-tile-icon"
              aria-hidden="true"
              style={{ background: presetTone(preset.id) }}
            >
              {presetMark(preset)}
            </span>
            <span className="mcp-tile-text">
              <strong>{preset.name}</strong>
              <span id={`mcp-preset-${preset.id}`}>{preset.summary}</span>
              <span className="mcp-tile-tags">
                <span className="tag">{AUTH_LABEL[preset.auth]}</span>
                {preset.readOnly && <span className="tag tag-green">Read-only</span>}
                {preset.ticket === true && (
                  <span className="tag tag-blue">Ticket steps</span>
                )}
              </span>
            </span>
          </button>
        ))}
        <button
          type="button"
          className="mcp-preset-tile is-blank"
          onClick={() => onPick(null)}
        >
          <span className="mcp-tile-icon" aria-hidden="true">
            +
          </span>
          <span className="mcp-tile-text">
            <strong>Blank server</strong>
            <span>Any stdio MCP server: a command and its arguments.</span>
          </span>
        </button>
      </div>
      {list.length === 0 && (
        <p className="field-hint">
          No setup matches “{query}”. Start from a blank server.
        </p>
      )}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function McpPresetGuide({ preset }: { preset: McpPreset }): React.JSX.Element {
  const snippet = mcpEnvSnippet(preset);
  const names = [...preset.env, ...(preset.envOptional ?? [])];
  return (
    <div className="mcp-guide">
      <div className="mcp-guide-tags">
        <span className="tag">{preset.category}</span>
        <span className="tag">{AUTH_LABEL[preset.auth]}</span>
        {preset.readOnly && <span className="tag tag-green">Read-only</span>}
        {preset.ticket === true && (
          <span className="tag tag-blue">Works with Ticket steps</span>
        )}
        <span className="tag">Needs {preset.needs}</span>
      </div>
      <p className="mcp-guide-summary">{preset.summary}</p>
      <ol className="mcp-guide-steps">
        {preset.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {snippet !== '' && (
        <div className="mcp-guide-env">
          <div className="log-block">{snippet}</div>
          <McpEnvironmentCheck
            names={names}
            actions={<CopyButton text={snippet} label="Copy exports" />}
          />
        </div>
      )}
      <details className="mcp-guide-tools">
        <summary>Tools to call from an MCP Tool step</summary>
        <ul>
          {preset.tools.map((tool) => (
            <li key={tool.name}>
              <code>{tool.name}</code> <span className="field-hint">{tool.args}</span>
            </li>
          ))}
        </ul>
        <p className="field-hint">
          Press List tools after saving to see every tool with its description.
        </p>
      </details>
      <p className="field-hint mcp-guide-source">
        Source: <code>{preset.source}</code>{' '}
        <CopyButton
          className="btn btn-ghost btn-inline"
          text={preset.source}
          label="Copy link"
        />
      </p>
    </div>
  );
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
  const isNew = initial.name.trim() === '' && initial.command.trim() === '';
  const [picking, setPicking] = useState(isNew);
  const [presetId, setPresetId] = useState<string | null>(
    () => matchMcpPreset(initial)?.id ?? null,
  );
  const preset = MCP_PRESETS.find((p) => p.id === presetId);
  const placeholder = preset?.placeholder;
  const validation = useSubmitValidation([
    ...validateMcpServer(form),
    ...(placeholder !== undefined && form.args.some((arg) => arg.includes(placeholder))
      ? [`Replace ${placeholder} in the arguments with your own value.`]
      : []),
  ]);
  const set = (patch: Partial<McpServerConfig>): void => {
    setForm((f) => ({ ...f, ...patch }));
  };
  if (picking)
    return (
      <McpPresetPicker
        onCancel={onCancel}
        onPick={(chosen) => {
          setPresetId(chosen?.id ?? null);
          setForm((f) =>
            chosen === null
              ? { ...f, name: '', command: '', args: [] }
              : {
                  ...f,
                  name: chosen.name,
                  command: chosen.command,
                  args: [...chosen.args],
                },
          );
          setPicking(false);
        }}
      />
    );
  return (
    <>
      <div className="mcp-editor-head">
        {preset !== undefined && (
          <span
            className="mcp-tile-icon"
            aria-hidden="true"
            style={{ background: presetTone(preset.id) }}
          >
            {presetMark(preset)}
          </span>
        )}
        <h3 style={{ margin: 0 }}>{preset?.name ?? 'MCP server'}</h3>
        {isNew && (
          <button className="btn btn-ghost btn-inline" onClick={() => setPicking(true)}>
            Choose another setup
          </button>
        )}
      </div>
      {preset !== undefined && <McpPresetGuide preset={preset} />}
      <div className="field">
        <label className="field-label" htmlFor="mcp-name">
          Name
        </label>
        <input
          id="mcp-name"
          className="input"
          value={form.name}
          placeholder="My server"
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
            className="input input-mono"
            value={form.command}
            placeholder="npx / uvx / docker / /path/to/server"
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
        <LinesTextarea
          id="mcp-args"
          rows={Math.min(8, Math.max(2, form.args.length))}
          value={form.args}
          onChange={(args) => {
            set({ args });
          }}
        />
      </div>
      <FormError error={validation.error} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          className="btn btn-primary"
          onClick={() => validation.attempt(() => onSave(form))}
        >
          Save server
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

function McpEnvironmentCheck({
  names,
  actions,
}: {
  names: string[];
  /** More buttons shown beside the check. */
  actions?: React.ReactNode;
}): React.JSX.Element {
  const [envState, setEnvState] = useState<{ name: string; present: boolean }[] | null>(
    null,
  );
  const [checking, setChecking] = useState(false);
  const checkEnv = (): void => {
    setChecking(true);
    void getBackend()
      .mcpEnvPresent(names)
      .then(setEnvState)
      .catch(() => {
        setEnvState(null);
      })
      .finally(() => {
        setChecking(false);
      });
  };
  return (
    <div style={{ marginTop: 8 }}>
      <div className="modal-actions" style={{ marginTop: 0 }}>
        {actions}
        <button className="btn" disabled={checking} onClick={checkEnv}>
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
            Orchevia shows only whether these variables are present. If they are available
            in your terminal, launch <code>orchevia</code> from that terminal and check
            again.
          </p>
        </div>
      )}
    </div>
  );
}
