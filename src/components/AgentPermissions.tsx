import { useState } from 'react';
import {
  ADAPTER_LABELS,
  permissionLevelLabel,
  type AgentProfile,
  type AppPermissionDefault,
} from '../lib/agents';
import { errorMessage } from '../lib/errors';
import {
  profilesLimitingFullAccess,
  profilesWithOwnLevel,
  workflowAgentProfiles,
} from '../lib/permissions';
import type { Workflow } from '../lib/workflow';
import { useAppStore } from '../store';
import { Notice } from './Notice';

/**
 * The app-wide agent permission level (v0.1.19). Profiles at "App default"
 * follow it; Agents can still give one profile its own level. Headless Claude
 * Code and Codex cannot ask while a step runs, so this is the one place the
 * user decides whether they work without asking.
 */

const OPTIONS: { level: AppPermissionDefault; title: string; hint: string }[] = [
  {
    level: 'fullAccess',
    title: 'Let agents work without asking (full access)',
    hint: 'Claude Code and Codex skip their permission checks: they can run any command, change any file and call any MCP tool. Use it for repositories and tools you trust.',
  },
  {
    level: 'cliSettings',
    title: 'Follow each CLI’s own settings',
    hint: 'No permission flag. A tool the Claude Code or Codex settings do not allow is refused, and the step fails.',
  },
];

/** "Name (Allowed tools)" for the profiles a change would switch. */
function profileList(profiles: AgentProfile[]): string {
  return profiles
    .map((p) => `${p.name} (${permissionLevelLabel(p.adapter, p.permissionLevel)})`)
    .join(', ');
}

/**
 * The radio choice with every profile that sets its own level. Saved as soon
 * as it changes. Used in Environment and the setup wizard.
 */
export function AgentPermissionsSettings({
  idPrefix = 'agent-permissions',
}: {
  idPrefix?: string;
}): React.JSX.Element {
  const profiles = useAppStore((s) => s.profiles);
  const appDefault = useAppStore((s) => s.agentPermissionDefault);
  const setDefault = useAppStore((s) => s.setAgentPermissionDefault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = profilesWithOwnLevel(profiles);
  const limiting = profilesLimitingFullAccess(profiles);

  const save = (level: AppPermissionDefault, switching: AgentProfile[] = []): void => {
    setBusy(true);
    setError(null);
    setDefault(level, switching)
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="agent-permissions">
      <div role="radiogroup" aria-label="Agent permissions" className="access-options">
        {OPTIONS.map((option) => (
          <label
            key={option.level}
            className={`access-option${appDefault === option.level ? ' selected' : ''}`}
            htmlFor={`${idPrefix}-${option.level}`}
          >
            <input
              id={`${idPrefix}-${option.level}`}
              type="radio"
              name={`${idPrefix}-level`}
              value={option.level}
              checked={appDefault === option.level}
              disabled={busy}
              onChange={() => {
                save(option.level);
              }}
            />
            <span>
              <strong>{option.title}</strong>
              <span className="field-hint">{option.hint}</span>
            </span>
          </label>
        ))}
      </div>
      {appDefault === null && (
        <p className="field-hint">
          Not chosen yet: agents follow each CLI’s own settings, and starting a workflow
          asks once.
        </p>
      )}
      {own.length > 0 && (
        <div className="access-overrides">
          <p className="field-hint" style={{ margin: '8px 0 4px' }}>
            {own.length === 1
              ? 'This profile sets its own level in Agents and does not follow this choice:'
              : 'These profiles set their own level in Agents and do not follow this choice:'}
          </p>
          <ul className="tool-grant-list" aria-label="Profiles with their own level">
            {own.map((profile) => (
              <li key={profile.id}>
                <strong>{profile.name}</strong>{' '}
                <span className="field-hint">
                  ({ADAPTER_LABELS[profile.adapter]},{' '}
                  {permissionLevelLabel(profile.adapter, profile.permissionLevel)})
                </span>
              </li>
            ))}
          </ul>
          {appDefault !== null && (
            <button
              className="btn"
              disabled={busy}
              onClick={() => {
                save(appDefault, own);
              }}
            >
              {own.length === 1
                ? 'Make it follow the app default'
                : `Make all ${String(own.length)} follow the app default`}
            </button>
          )}
          {appDefault === 'fullAccess' && limiting.length > 0 && (
            <p className="field-hint" style={{ marginBottom: 0 }}>
              {profileList(limiting)} can still be refused tools.
            </p>
          )}
        </div>
      )}
      {error !== null && (
        <p className="field-hint" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The one-time question before a workflow or template runs agents while the
 * app-wide level is not chosen yet. Renders nothing once it is chosen, or
 * when the workflow has no Claude Code or Codex Agent step.
 */
export function AgentAccessChoice({
  workflow,
  roleMap,
  style,
  onDismiss,
}: {
  workflow: Workflow;
  /** Role → profile id for nodes that name only a role (templates). */
  roleMap?: Record<string, string> | undefined;
  style?: React.CSSProperties;
  onDismiss?: () => void;
}): React.JSX.Element | null {
  const profiles = useAppStore((s) => s.profiles);
  const appDefault = useAppStore((s) => s.agentPermissionDefault);
  const setDefault = useAppStore((s) => s.setAgentPermissionDefault);
  const [switchOwn, setSwitchOwn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (
    appDefault !== null ||
    workflowAgentProfiles(workflow, profiles, roleMap).length === 0
  )
    return null;
  const limiting = profilesLimitingFullAccess(profiles);

  const choose = (level: AppPermissionDefault): void => {
    setBusy(true);
    setError(null);
    setDefault(level, level === 'fullAccess' && switchOwn ? limiting : [])
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Notice
      inline
      variant="info"
      {...(style === undefined ? {} : { style })}
      {...(onDismiss === undefined
        ? {}
        : { onDismiss, dismissLabel: 'Dismiss agent permissions question' })}
    >
      <strong>Let AI agents work without asking?</strong>
      <p className="field-hint" style={{ margin: '4px 0 8px' }}>
        Claude Code and Codex cannot ask for permission while a step runs: a tool their
        settings do not allow is refused, and the step fails. Choose once for every
        workflow. Full access lets them run any command, change any file and call any MCP
        tool without asking. Change it anytime in Environment → Agent permissions, or per
        profile in Agents.
      </p>
      {limiting.length > 0 && (
        <label className="field-hint" style={{ display: 'block', marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={switchOwn}
            disabled={busy}
            onChange={(e) => {
              setSwitchOwn(e.target.checked);
            }}
          />{' '}
          With full access, also switch {profileList(limiting)} to the app default
        </label>
      )}
      {error !== null && (
        <p className="field-hint" role="alert">
          {error}
        </p>
      )}
      <div className="permission-denials-actions">
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => {
            choose('fullAccess');
          }}
        >
          Let agents work without asking
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() => {
            choose('cliSettings');
          }}
        >
          Keep each CLI’s settings
        </button>
      </div>
    </Notice>
  );
}
