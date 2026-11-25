import { useState } from 'react';
import {
  abilityAccess,
  automationsFollowingAppBrowser,
  missingConnectors,
  unlistedAllowedRules,
  WEB_TOOL_RULES,
  withAllowedRules,
  type AbilityAccess,
  type AppAbilities,
  type HostAbilities,
  type HostConnector,
} from '../lib/abilities';
import type { AppPermissionDefault } from '../lib/agents';
import { errorMessage } from '../lib/errors';
import { formatTime } from '../lib/time';
import { useAppStore, type HostAbilitiesState } from '../store';
import { confirmDialog } from './ConfirmDialog';
import { Notice } from './Notice';
import { Switch } from './Switch';

/**
 * What Claude Code and Codex bring from the user's own setup (v0.3.3), and
 * the one choice of what workflow steps may use: the user's browser through
 * Claude in Chrome, and the connectors, MCP servers and web tools they already
 * use in their terminal. Used in Environment and the setup wizard; a profile
 * can still turn the browser on or off for itself in Agents.
 */
export function AgentAbilitiesPanel(): React.JSX.Element {
  const tools = useAppStore((s) => s.tools);
  const workflows = useAppStore((s) => s.workflows);
  const appDefault = useAppStore((s) => s.agentPermissionDefault);
  const abilities = useAppStore((s) => s.agentAbilities);
  const host = useAppStore((s) => s.hostAbilities);
  const profiles = useAppStore((s) => s.profiles);
  const schedules = useAppStore((s) => s.schedules);
  const watchers = useAppStore((s) => s.watchers);
  const detect = useAppStore((s) => s.detectHostAbilities);
  const save = useAppStore((s) => s.setAgentAbilities);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Found on PATH, or set up through a profile's own executable path.
  const installed = (id: string): boolean =>
    tools.some((tool) => tool.id === id && tool.installed) ||
    profiles.some((profile) => profile.adapter === id);
  const clis = (['claude', 'codex'] as const).filter(
    (id) => installed(id) || host[id] !== undefined,
  );
  const detecting = clis.some((id) => host[id]?.kind === 'detecting');

  const update = (next: AppAbilities): void => {
    setBusy(true);
    setError(null);
    save(next)
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const affected = automationsFollowingAppBrowser(
    [...schedules, ...watchers],
    workflows,
    profiles,
  );

  const detectAll = (): void => {
    for (const id of clis.length > 0 ? clis : (['claude', 'codex'] as const))
      void detect(id);
  };

  return (
    <div className="abilities">
      <p className="field-hint section-hint" style={{ marginBottom: 0 }}>
        Workflow steps run your own Claude Code and Codex, so they already load the MCP
        servers, claude.ai connectors, skills and personal instructions you use in your
        terminal. See what is there, then choose what steps may use without asking.
      </p>
      <div className="section-actions" style={{ marginBottom: 0 }}>
        <button className="btn" disabled={detecting} onClick={detectAll}>
          {detecting ? 'Looking…' : 'Find what my agents can use'}
        </button>
        <span className="field-hint">
          Runs <code>claude mcp list</code> and <code>codex mcp list</code>, which start
          your MCP servers to check them. Sends no prompt.
        </span>
      </div>
      {error !== null && (
        <Notice variant="error" style={{ marginBottom: 0 }}>
          {error}
        </Notice>
      )}
      {installed('claude') || host.claude !== undefined ? (
        <ClaudeAbilities
          state={host.claude}
          appDefault={appDefault}
          abilities={abilities}
          affected={affected}
          busy={busy}
          workflows={workflows.map((w) => w.definition)}
          onChange={update}
        />
      ) : (
        <>
          <ul className="ability-list" aria-label="Claude Code abilities">
            <BrowserChoice
              abilities={abilities}
              affected={affected}
              appDefault={appDefault}
              busy={busy}
              detail="Claude Code is not installed. Install it to let steps use your browser."
              onChange={update}
            />
          </ul>
          <StoredRules abilities={abilities} shown={[]} busy={busy} onChange={update} />
        </>
      )}
      {(installed('codex') || host.codex !== undefined) && (
        <CodexAbilities state={host.codex} appDefault={appDefault} />
      )}
    </div>
  );
}

function resultOf(state: HostAbilitiesState | undefined): HostAbilities | null {
  if (state?.kind === 'done') return state.abilities;
  if (state?.kind === 'detecting') return state.previous;
  return null;
}

function DetectionStatus({
  state,
}: {
  state: HostAbilitiesState | undefined;
}): React.JSX.Element {
  if (state === undefined) return <span className="field-hint">Not checked yet</span>;
  if (state.kind === 'detecting')
    return (
      <span className="field-hint" aria-live="polite">
        Looking…
      </span>
    );
  if (state.kind === 'error')
    return (
      <span className="status-pill status-failed" title={state.message}>
        Could not check
      </span>
    );
  return (
    <span className="field-hint" title={state.abilities.detectedAt}>
      Checked {formatTime(state.abilities.detectedAt)}
    </span>
  );
}

const ACCESS_LABEL: Record<AbilityAccess, string> = {
  fullAccess: 'Allowed: full access',
  settings: 'Allowed in your Claude settings',
  orchevia: 'Allowed for workflow steps',
  needed: 'Would be refused',
};

const STATUS_LABEL: Record<HostConnector['status'], [string, string]> = {
  connected: ['Connected', 'status-succeeded'],
  enabled: ['On', 'status-succeeded'],
  needsAuth: ['Needs sign-in', 'status-paused'],
  pending: ['Needs approval', 'status-paused'],
  failed: ['Not connecting', 'status-failed'],
  disabled: ['Off', 'status-cancelled'],
  unknown: ['Unknown', 'status-cancelled'],
};

function BrowserChoice({
  abilities,
  affected,
  appDefault,
  busy,
  detail,
  onChange,
}: {
  abilities: AppAbilities;
  /** Enabled automations that would start using the browser. */
  affected: string[];
  appDefault: AppPermissionDefault | null;
  busy: boolean;
  detail: string;
  onChange: (next: AppAbilities) => void;
}): React.JSX.Element {
  return (
    <li className="ability-row">
      <div>
        <strong>Your browser (Claude in Chrome)</strong>
        <p className="field-hint">{detail}</p>
        {abilities.browser && (
          <p className="field-hint">
            Steps run Claude Code with <code>--chrome</code>
            {appDefault === 'fullAccess'
              ? ''
              : ', and may use the browser tools without asking'}
            . Claude acts in your signed-in browser. Profiles whose Browser is set in
            Agents keep their own choice, and workflows list it among their automation
            risks.
          </p>
        )}
      </div>
      <div className="ability-side">
        <Switch
          label="Let workflow steps use my browser"
          checked={abilities.browser}
          busy={busy}
          onText="On"
          offText="Off"
          onChange={(browser) => {
            if (!browser) {
              onChange({ ...abilities, browser });
              return;
            }
            void confirmDialog({
              title: 'Let workflow steps use your browser?',
              message: `Claude Code steps run with Claude in Chrome unless their profile's Browser is set to Off in Agents: Claude can open pages and act in the browser you are signed in to, without asking.${
                affected.length > 0
                  ? ` These enabled automations will use it too, unattended: ${affected.join(', ')}.`
                  : ''
              }`,
              confirmLabel: 'Use my browser',
              danger: true,
            }).then((ok) => {
              if (ok) onChange({ ...abilities, browser });
            });
          }}
        />
      </div>
    </li>
  );
}

function ClaudeAbilities({
  state,
  appDefault,
  abilities,
  affected,
  busy,
  workflows,
  onChange,
}: {
  state: HostAbilitiesState | undefined;
  appDefault: AppPermissionDefault | null;
  abilities: AppAbilities;
  affected: string[];
  busy: boolean;
  workflows: Parameters<typeof missingConnectors>[0];
  onChange: (next: AppAbilities) => void;
}): React.JSX.Element {
  const found = resultOf(state);
  const listed = found?.connectorsListed === true;
  const settingsRules = found?.allowedInSettings ?? [];
  const access = (rule: string): AbilityAccess =>
    abilityAccess(rule, appDefault, abilities, settingsRules);
  const connectors = (found?.connectors ?? []).filter((c) => c.rule !== undefined);
  const refused = connectors.filter(
    (c) =>
      c.rule !== undefined &&
      (c.status === 'connected' || c.status === 'needsAuth') &&
      access(c.rule) === 'needed',
  );
  const webAccess = WEB_TOOL_RULES.map(access);
  const webAllowed = webAccess.every((a) => a !== 'needed');
  // Only a listing that ran can say a server is gone.
  const missing = listed ? missingConnectors(workflows, connectors) : [];
  const webOn = webAccess.every((a) => a === 'orchevia' || a === 'settings');
  // Rules a switch on screen can turn off. Rows that only say "Allowed" (full
  // access, or your Claude settings) cannot, so a rule stored for them stays
  // in the list below with Remove.
  const switchable = (rule: string): boolean => {
    const a = access(rule);
    return a === 'orchevia' || a === 'needed';
  };
  const shown = [
    ...(listed
      ? connectors.flatMap((c) =>
          c.rule !== undefined && switchable(c.rule) ? [c.rule] : [],
        )
      : []),
    ...(appDefault !== 'fullAccess' && webOn && !webAccess.every((a) => a === 'settings')
      ? WEB_TOOL_RULES
      : []),
  ];
  const browserDetail =
    found?.browser.detail ??
    'Lets steps open pages and act in the browser you are signed in to.';

  return (
    <div className="tool-card ability-cli">
      <div className="tool-card-head">
        <h3>Claude Code</h3>
        <DetectionStatus state={state} />
      </div>
      {state?.kind === 'error' && (
        <p className="field-hint" role="alert">
          {state.message}
        </p>
      )}
      <ul className="ability-list" aria-label="Claude Code abilities">
        <BrowserChoice
          abilities={abilities}
          affected={affected}
          appDefault={appDefault}
          busy={busy}
          detail={browserDetail}
          onChange={onChange}
        />
        <li className="ability-row">
          <div>
            <strong>Web search and fetch</strong>
            <p className="field-hint">
              {webAllowed
                ? `${ACCESS_LABEL[webAccess.includes('fullAccess') ? 'fullAccess' : webAccess.includes('settings') ? 'settings' : 'orchevia']}.`
                : 'Claude Code’s WebSearch and WebFetch. Without permission a step that searches the web fails.'}
            </p>
          </div>
          <div className="ability-side">
            {appDefault !== 'fullAccess' && (
              <Switch
                label="Let workflow steps search and read the web"
                checked={webOn}
                disabled={webAccess.every((a) => a === 'settings')}
                busy={busy}
                onText="Allowed"
                offText="Ask"
                onChange={(on) => {
                  onChange(withAllowedRules(abilities, WEB_TOOL_RULES, on));
                }}
              />
            )}
          </div>
        </li>
        <li className="ability-row">
          <div>
            <strong>
              Connectors and MCP servers
              {found !== null && ` (${String(connectors.length)})`}
            </strong>
            {found === null ? (
              <p className="field-hint">
                Your claude.ai connectors (Jira, Slack, Gmail…) and the MCP servers you
                added to Claude Code. Choose Find to list them.
              </p>
            ) : connectors.length === 0 ? (
              <p className="field-hint">
                {found.connectorsNote ??
                  'Claude Code lists no MCP servers or connectors.'}
              </p>
            ) : (
              <>
                {found.connectorsNote !== undefined && (
                  <p className="field-hint">{found.connectorsNote}</p>
                )}
                <p className="field-hint">
                  {appDefault === 'fullAccess'
                    ? 'Full access: steps can use all of them without asking.'
                    : refused.length > 0
                      ? `${String(refused.length)} would be refused in a step. Allow the ones workflows should use.`
                      : 'Steps can use every connected one without asking.'}
                </p>
                <ul className="connector-list" aria-label="Claude Code connectors">
                  {connectors.map((connector) => (
                    <ConnectorRow
                      key={connector.name}
                      connector={connector}
                      access={access(connector.rule ?? '')}
                      busy={busy}
                      onAllow={(on) => {
                        onChange(withAllowedRules(abilities, [connector.rule ?? ''], on));
                      }}
                    />
                  ))}
                </ul>
              </>
            )}
          </div>
          <div className="ability-side">
            {refused.length > 1 && (
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  onChange(
                    withAllowedRules(
                      abilities,
                      refused.flatMap((c) => (c.rule === undefined ? [] : [c.rule])),
                      true,
                    ),
                  );
                }}
              >
                Allow all {refused.length}
              </button>
            )}
          </div>
        </li>
        {found !== null && (
          <li className="ability-row">
            <div>
              <strong>Skills and instructions</strong>
              <p className="field-hint">
                {found.skills.length === 0
                  ? 'No personal skills in ~/.claude/skills; plugin and claude.ai skills still load.'
                  : `${String(found.skills.length)} personal skill${found.skills.length === 1 ? '' : 's'} (${found.skills.slice(0, 4).join(', ')}${found.skills.length > 4 ? ', …' : ''}), plus plugin skills.`}{' '}
                {found.instructions.length > 0
                  ? `${found.instructions.join(', ')} applies to every step.`
                  : 'No personal CLAUDE.md.'}
              </p>
            </div>
          </li>
        )}
      </ul>
      <StoredRules abilities={abilities} shown={shown} busy={busy} onChange={onChange} />
      {missing.length > 0 && (
        <Notice inline variant="warn" style={{ marginTop: 12, marginBottom: 0 }}>
          <strong>Workflows ask for MCP servers Claude Code does not list.</strong>
          <ul className="mcp-update-changes">
            {missing.map((m) => (
              <li key={m.server}>
                <code>mcp__{m.server}</code> in {m.workflows.join(', ')}
                {m.suggestion !== undefined && (
                  <>
                    {' '}
                    — probably <code>mcp__{m.suggestion}</code> now
                  </>
                )}
                .
              </li>
            ))}
          </ul>
          Reconnecting a connector can rename it; update the step’s required tools and the
          prompt that names it. Servers added for one project only are listed when a step
          runs there, so those may be fine.
        </Notice>
      )}
      {appDefault !== 'fullAccess' && (
        <p className="field-hint" style={{ marginBottom: 0, marginTop: 10 }}>
          Connectors and web tools allowed here reach profiles whose Permissions follow
          the app default; a profile with its own level in Agents keeps its own rules. The
          browser follows each profile’s Browser choice.
        </p>
      )}
    </div>
  );
}

/**
 * Allowed rules no switch above shows (not listed yet, or renamed or removed
 * in Claude Code). They stay granted until removed, so they are always here.
 */
function StoredRules({
  abilities,
  shown,
  busy,
  onChange,
}: {
  abilities: AppAbilities;
  shown: string[];
  busy: boolean;
  onChange: (next: AppAbilities) => void;
}): React.JSX.Element | null {
  const rules = unlistedAllowedRules(abilities, shown);
  if (rules.length === 0) return null;
  return (
    <div className="ability-stored">
      <p className="field-hint">
        Also allowed for workflow steps (not in the list above: not listed yet, or renamed
        or removed in Claude Code). Steps get these until you remove them.
      </p>
      <ul className="connector-list" aria-label="Other allowed abilities">
        {rules.map((rule) => (
          <li key={rule} className="connector-row">
            <code title={rule}>{rule}</code>
            <button
              className="btn btn-ghost btn-inline danger-hover"
              disabled={busy}
              aria-label={`Stop allowing ${rule}`}
              onClick={() => {
                onChange(withAllowedRules(abilities, [rule], false));
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConnectorRow({
  connector,
  access,
  busy,
  onAllow,
}: {
  connector: HostConnector;
  access: AbilityAccess;
  busy: boolean;
  onAllow: (on: boolean) => void;
}): React.JSX.Element {
  const [label, tone] = STATUS_LABEL[connector.status];
  const usable = connector.status === 'connected' || connector.status === 'needsAuth';
  return (
    <li className="connector-row">
      <span className="connector-name" title={connector.target}>
        {connector.name.replace(/^claude\.ai /, '')}
      </span>
      <code title={connector.rule}>{connector.rule}</code>
      <span className={`status-pill ${tone}`}>{label}</span>
      {access === 'fullAccess' || access === 'settings' ? (
        <span className="field-hint" title={ACCESS_LABEL[access]}>
          {access === 'settings' ? 'Allowed in settings' : 'Allowed'}
        </span>
      ) : (
        <Switch
          label={`Let workflow steps use ${connector.name}`}
          checked={access === 'orchevia'}
          disabled={!usable && access !== 'orchevia'}
          busy={busy}
          onText="Allowed"
          offText="Ask"
          onChange={onAllow}
        />
      )}
    </li>
  );
}

function CodexAbilities({
  state,
  appDefault,
}: {
  state: HostAbilitiesState | undefined;
  appDefault: AppPermissionDefault | null;
}): React.JSX.Element {
  const found = resultOf(state);
  return (
    <div className="tool-card ability-cli">
      <div className="tool-card-head">
        <h3>Codex</h3>
        <DetectionStatus state={state} />
      </div>
      {state?.kind === 'error' && (
        <p className="field-hint" role="alert">
          {state.message}
        </p>
      )}
      <p className="field-hint">
        Codex has no allow-list:{' '}
        {appDefault === 'fullAccess'
          ? 'with full access, steps use all of these without asking.'
          : 'its own approval settings decide, or choose full access above.'}
      </p>
      {found === null ? (
        <p className="field-hint" style={{ marginBottom: 0 }}>
          Its MCP servers, plugins (browser, Gmail, Slack…) and ~/.codex/AGENTS.md load in
          every step. Choose Find to list them.
        </p>
      ) : (
        <ul className="ability-list" aria-label="Codex abilities">
          <li className="ability-row">
            <div>
              <strong>Browser</strong>
              <p className="field-hint">{found.browser.detail}</p>
            </div>
          </li>
          <li className="ability-row">
            <div>
              <strong>MCP servers ({found.connectors.length})</strong>
              {found.connectors.length === 0 ? (
                <p className="field-hint">
                  {found.connectorsNote ?? 'Codex lists no MCP servers.'}
                </p>
              ) : (
                <ul className="connector-list" aria-label="Codex MCP servers">
                  {found.connectors.map((connector) => {
                    const [label, tone] = STATUS_LABEL[connector.status];
                    return (
                      <li key={connector.name} className="connector-row">
                        <span className="connector-name">{connector.name}</span>
                        <code title={connector.target}>{connector.target}</code>
                        <span className={`status-pill ${tone}`}>{label}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </li>
          <li className="ability-row">
            <div>
              <strong>Plugins and instructions</strong>
              <p className="field-hint">
                {found.plugins.length > 0
                  ? `Plugins on: ${found.plugins.join(', ')}.`
                  : 'No plugins on.'}{' '}
                {found.instructions.length > 0
                  ? `${found.instructions.join(', ')} applies to every step.`
                  : 'No personal AGENTS.md.'}
              </p>
            </div>
          </li>
        </ul>
      )}
    </div>
  );
}
