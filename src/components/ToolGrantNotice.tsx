import { useState, type CSSProperties } from 'react';
import { getBackend } from '../lib/backend';
import { errorMessage } from '../lib/errors';
import {
  allowedToolsBlocker,
  dormantAllowedTools,
  missingToolGrants,
  profilesLimitingFullAccess,
  withAllowedTools,
} from '../lib/permissions';
import type { Workflow } from '../lib/workflow';
import { useAppStore } from '../store';
import { AgentAccessChoice } from './AgentPermissions';
import { confirmDialog } from './ConfirmDialog';
import { Notice } from './Notice';

/**
 * Agent permissions for a workflow, shown on import, on Use template and
 * before a run starts. While the app-wide level is not chosen it asks that
 * once (`AgentAccessChoice`). Otherwise it lists tools the Agent nodes declare
 * (`requiredTools`) that their Claude Code profile does not grant, with
 * actions that give agents full access or add the tools to each profile's
 * allowed tools after confirmation. Renders nothing when nothing is missing.
 */
export function ToolGrantNotice({
  workflow,
  roleMap,
  style,
  onDismiss,
}: {
  workflow: Workflow;
  /** Role → profile id for nodes that name only a role (templates). */
  roleMap?: Record<string, string>;
  style?: CSSProperties;
  onDismiss?: () => void;
}): React.JSX.Element | null {
  const profiles = useAppStore((s) => s.profiles);
  const appDefault = useAppStore((s) => s.agentPermissionDefault);
  const setDefault = useAppStore((s) => s.setAgentPermissionDefault);
  const refreshProfiles = useAppStore((s) => s.refreshProfiles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Until the app-wide level is chosen, that one choice covers every tool.
  if (appDefault === null)
    return (
      <AgentAccessChoice
        workflow={workflow}
        roleMap={roleMap}
        {...(style === undefined ? {} : { style })}
        {...(onDismiss === undefined ? {} : { onDismiss })}
      />
    );
  const grants = missingToolGrants(workflow, profiles, roleMap, appDefault);
  if (grants.length === 0) return null;
  // Profiles whose own extra arguments set permissions must be edited by hand.
  const addable = grants.filter((grant) => allowedToolsBlocker(grant.profile) === null);
  const limiting = profilesLimitingFullAccess(grants.map((grant) => grant.profile));

  const giveFullAccess = (): void => {
    const switching =
      limiting.length > 0
        ? ` ${limiting.map((p) => p.name).join(', ')} ${limiting.length === 1 ? 'switches' : 'switch'} to the app default.`
        : '';
    void confirmDialog({
      title: 'Let agents work without asking?',
      message: `Claude Code and Codex profiles that follow the app default get full access: they can run any command, change any file and call any MCP tool without asking.${switching} Change it anytime in Environment → Agent permissions.`,
      confirmLabel: 'Allow full access',
      danger: true,
    }).then(async (ok) => {
      if (!ok) return;
      setBusy(true);
      setError(null);
      try {
        await setDefault('fullAccess', limiting);
      } catch (err: unknown) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    });
  };

  const add = (): void => {
    const changes = addable.map((grant) => {
      const dormant = dormantAllowedTools(grant.profile);
      return `${grant.profile.name}: ${grant.rules.join(', ')}${
        dormant.length > 0 ? ` (its saved list ${dormant.join(', ')} applies too)` : ''
      }`;
    });
    void confirmDialog({
      title: 'Add declared tools to Agent Profiles?',
      message: `${changes.join('; ')}. A profile that uses the Claude Code settings switches to Allowed tools, and what those settings allow still applies.`,
      confirmLabel: 'Add tools',
    }).then(async (ok) => {
      if (!ok) return;
      setBusy(true);
      setError(null);
      try {
        for (const grant of addable) {
          const next = withAllowedTools(grant.profile, grant.rules, appDefault);
          if (next !== null) await getBackend().saveAgentProfile(next);
        }
        await refreshProfiles();
      } catch (err: unknown) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    });
  };

  return (
    <Notice
      inline
      variant="warn"
      {...(style === undefined ? {} : { style })}
      {...(onDismiss === undefined
        ? {}
        : { onDismiss, dismissLabel: 'Dismiss tool permissions notice' })}
    >
      <strong>This workflow declares tools its Agent Profiles do not grant.</strong>
      <ul className="tool-grant-list" aria-label="Tools not granted">
        {grants.map((grant) => (
          <li key={grant.profile.id}>
            <strong>{grant.profile.name}</strong>{' '}
            <span className="field-hint">({grant.nodes.join(', ')})</span>:{' '}
            {grant.rules.map((rule, index) => (
              <span key={rule}>
                {index > 0 && ', '}
                <code>{rule}</code>
              </span>
            ))}
          </li>
        ))}
      </ul>
      <p className="field-hint" style={{ margin: '0 0 8px' }}>
        Headless Claude refuses tools its permissions do not allow, and the step then
        fails. A profile that uses the Claude Code settings may already allow them there.
        Full access allows every tool at once.
      </p>
      {error !== null && (
        <p className="field-hint" role="alert">
          {error}
        </p>
      )}
      {grants
        .filter((grant) => !addable.includes(grant))
        .map((grant) => (
          <p key={grant.profile.id} className="field-hint">
            {allowedToolsBlocker(grant.profile)}
          </p>
        ))}
      <div className="permission-denials-actions">
        <button className="btn btn-primary" disabled={busy} onClick={giveFullAccess}>
          Let agents work without asking
        </button>
        {addable.length > 0 && (
          <button className="btn" disabled={busy} onClick={add}>
            {busy ? 'Adding…' : 'Add to allowed tools'}
          </button>
        )}
      </div>
    </Notice>
  );
}
