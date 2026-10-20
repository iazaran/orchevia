import { useState, type CSSProperties } from 'react';
import { getBackend } from '../lib/backend';
import { errorMessage } from '../lib/errors';
import { missingToolGrants, withAllowedTools } from '../lib/permissions';
import type { Workflow } from '../lib/workflow';
import { useAppStore } from '../store';
import { confirmDialog } from './ConfirmDialog';
import { Notice } from './Notice';

/**
 * Tools a workflow's Agent nodes declare (`requiredTools`) that their chosen
 * Claude Code profile does not grant, with an action that adds them to each
 * profile's allowed tools after confirmation. Shown on import and before a
 * run starts; renders nothing once every declared tool is granted.
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
  const refreshProfiles = useAppStore((s) => s.refreshProfiles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const grants = missingToolGrants(workflow, profiles, roleMap);
  if (grants.length === 0) return null;

  const add = (): void => {
    const changes = grants.map((grant) => {
      const saved = grant.profile.allowedTools ?? [];
      const dormant =
        (grant.profile.permissionLevel ?? 'cliSettings') === 'cliSettings' &&
        saved.length > 0
          ? ` (its saved list ${saved.join(', ')} applies too)`
          : '';
      return `${grant.profile.name}: ${grant.rules.join(', ')}${dormant}`;
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
        for (const grant of grants) {
          const next = withAllowedTools(grant.profile, grant.rules);
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
      </p>
      {error !== null && (
        <p className="field-hint" role="alert">
          {error}
        </p>
      )}
      <button className="btn" disabled={busy} onClick={add}>
        {busy ? 'Adding…' : 'Add to allowed tools'}
      </button>
    </Notice>
  );
}
