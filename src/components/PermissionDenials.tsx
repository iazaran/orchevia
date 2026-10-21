import { useState } from 'react';
import { getBackend } from '../lib/backend';
import { errorMessage } from '../lib/errors';
import {
  allowedToolsBlocker,
  dormantAllowedTools,
  profileGrants,
  profilesLimitingFullAccess,
  withAllowedTools,
  type PermissionDenied,
} from '../lib/permissions';
import { useAppStore } from '../store';
import { confirmDialog } from './ConfirmDialog';

/**
 * Tool calls Claude refused on a step, each with the allow rule that would
 * admit it, and actions (after confirmation) that give agents full access or
 * add the missing rules to the step's profile. The run itself is recovered
 * separately.
 */
export function PermissionDenials({
  denied,
  profileId,
}: {
  denied: PermissionDenied;
  /** Fallback when the stored result predates the recorded profile id. */
  profileId?: string | undefined;
}): React.JSX.Element {
  const profiles = useAppStore((s) => s.profiles);
  const appDefault = useAppStore((s) => s.agentPermissionDefault);
  const setDefault = useAppStore((s) => s.setAgentPermissionDefault);
  const refreshProfiles = useAppStore((s) => s.refreshProfiles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = denied.profileId ?? profileId;
  const profile = profiles.find((p) => p.id === id);
  const pending =
    profile === undefined
      ? denied.rules
      : denied.rules.filter((rule) => !profileGrants(profile, rule, appDefault));
  const blocker = profile === undefined ? null : allowedToolsBlocker(profile);

  const giveFullAccess = (): void => {
    if (profile === undefined) return;
    const switching = profilesLimitingFullAccess([profile]);
    void confirmDialog({
      title: 'Let agents work without asking?',
      message: `Claude Code and Codex profiles that follow the app default get full access: they can run any command, change any file and call any MCP tool without asking.${
        switching.length > 0 ? ` '${profile.name}' switches to the app default.` : ''
      } Change it anytime in Environment → Agent permissions.`,
      confirmLabel: 'Allow full access',
      danger: true,
    }).then(async (ok) => {
      if (!ok) return;
      setBusy(true);
      setError(null);
      try {
        await setDefault('fullAccess', switching);
      } catch (err: unknown) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    });
  };

  const add = (): void => {
    if (profile === undefined) return;
    const next = withAllowedTools(profile, pending, appDefault);
    if (next === null) return;
    const dormant = dormantAllowedTools(profile);
    const switching = (profile.permissionLevel ?? 'appDefault') !== 'allowedTools';
    void confirmDialog({
      title: `Allow ${String(pending.length)} tool rule${pending.length === 1 ? '' : 's'} for '${profile.name}'?`,
      message: `Adds ${pending.join(', ')} to the profile's allowed tools.${
        switching
          ? ' The profile switches to Allowed tools; what the Claude Code settings allow still applies.'
          : ''
      }${
        dormant.length > 0
          ? ` Its saved list (${dormant.join(', ')}) applies again too.`
          : ''
      } Every workflow that uses this profile gets these permissions.`,
      confirmLabel: 'Add to allowed tools',
    }).then(async (ok) => {
      if (!ok) return;
      setBusy(true);
      setError(null);
      try {
        await getBackend().saveAgentProfile(next);
        await refreshProfiles();
      } catch (err: unknown) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    });
  };

  return (
    <section className="permission-denials" aria-label="Refused tool calls">
      <h4>
        Refused tool calls ({denied.denials.length}
        {denied.denials.length === 1 ? ' call' : ' calls'})
      </h4>
      <ul>
        {denied.denials.map((denial, index) => (
          <li key={denial.toolUseId ?? `${denial.toolName}-${String(index)}`}>
            <code>{denial.toolName}</code>
            {denial.detail !== undefined && (
              <>
                {' '}
                <span className="denial-detail" title={denial.detail}>
                  {denial.detail}
                </span>
              </>
            )}
            {denial.rules.length > 0 && (
              <span className="field-hint">
                {' '}
                → allow with{' '}
                {denial.rules.map((rule, i) => (
                  <span key={rule}>
                    {i > 0 && ', '}
                    <code>{rule}</code>
                  </span>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
      {error !== null && (
        <p className="field-hint" role="alert">
          {error}
        </p>
      )}
      {profile === undefined ? (
        <p className="field-hint">
          The step&apos;s Agent Profile no longer exists. Add the rules to the profile you
          use in Agents.
        </p>
      ) : pending.length === 0 ? (
        <p className="field-hint">
          {profile.name} now allows these tools. Use Recover failed run to retry the step.
        </p>
      ) : blocker !== null ? (
        <p className="field-hint">{blocker}</p>
      ) : (
        <div className="permission-denials-actions">
          <button className="btn btn-primary" disabled={busy} onClick={giveFullAccess}>
            Let agents work without asking
          </button>
          <button className="btn" disabled={busy} onClick={add}>
            {busy
              ? 'Adding…'
              : `Add ${String(pending.length)} rule${pending.length === 1 ? '' : 's'} to ${profile.name}`}
          </button>
          <span className="field-hint">
            Then use Recover failed run to retry the step.
          </span>
        </div>
      )}
    </section>
  );
}
