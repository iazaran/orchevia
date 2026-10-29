import { useState } from 'react';
import { getBackend } from '../lib/backend';
import { errorMessage } from '../lib/errors';
import {
  setupCheckSummary,
  type AgentProfile,
  type SetupCheckReport,
  type SetupCheckStatus,
} from '../lib/agents';

const PILL: Record<SetupCheckStatus, string> = {
  passed: 'status-succeeded',
  warning: 'status-paused',
  failed: 'status-failed',
  skipped: 'status-cancelled',
};

const ITEM_WORD: Record<SetupCheckStatus, string> = {
  passed: 'OK',
  warning: 'Limited',
  failed: 'Failed',
  skipped: 'Skipped',
};

export const SETUP_CHECK_COST_NOTE =
  'Sends one short prompt with the profile, using your plan, and takes up to three minutes.';

/** Render `code` spans inside hints. */
function rich(text: string): React.ReactNode {
  return text
    .split('`')
    .map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
}

/** The checklist of one profile's setup check. */
export function SetupCheckResult({
  report,
}: {
  report: SetupCheckReport;
}): React.JSX.Element {
  return (
    <ul className="setup-check" aria-label={`Setup check for ${report.profileName}`}>
      {report.items.map((item) => (
        <li key={item.id} className="setup-check-item">
          <span className={`status-pill ${PILL[item.status]}`}>
            {ITEM_WORD[item.status]}
          </span>
          <div>
            <strong>{item.label}</strong>
            <div className="field-hint">{item.detail}</div>
            {item.hint !== undefined && (
              <div className="field-hint setup-check-hint">{rich(item.hint)}</div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export type SetupCheckState =
  | { kind: 'running' }
  | { kind: 'done'; report: SetupCheckReport }
  | { kind: 'error'; message: string };

/** Run checks one profile at a time and keep each result by profile id. */
export function useSetupChecks(): {
  checks: Record<string, SetupCheckState>;
  run: (profileIds: string[]) => Promise<void>;
  busy: boolean;
} {
  const [checks, setChecks] = useState<Record<string, SetupCheckState>>({});
  const [busy, setBusy] = useState(false);
  const run = async (profileIds: string[]): Promise<void> => {
    setBusy(true);
    try {
      for (const id of profileIds) {
        setChecks((prev) => ({ ...prev, [id]: { kind: 'running' } }));
        let next: SetupCheckState;
        try {
          next = { kind: 'done', report: await getBackend().checkAgentSetup(id) };
        } catch (err: unknown) {
          next = { kind: 'error', message: errorMessage(err) };
        }
        setChecks((prev) => ({ ...prev, [id]: next }));
      }
    } finally {
      setBusy(false);
    }
  };
  return { checks, run, busy };
}

/** A compact line for one check: what it means, or that it is running. */
export function SetupCheckStatusLine({
  state,
}: {
  state: SetupCheckState;
}): React.JSX.Element {
  if (state.kind === 'running')
    return (
      <span className="field-hint" role="status">
        Checking…
      </span>
    );
  if (state.kind === 'error')
    return (
      <span className="status-pill status-failed" title={state.message}>
        Check failed
      </span>
    );
  return (
    <span className={`status-pill ${PILL[state.report.status]}`}>
      {setupCheckSummary(state.report.status)}
    </span>
  );
}

/**
 * Check every profile in turn: used by Environment and the setup wizard.
 * Nothing runs until the button is pressed.
 */
export function SetupCheckPanel({
  profiles,
}: {
  profiles: AgentProfile[];
}): React.JSX.Element {
  const { checks, run, busy } = useSetupChecks();
  if (profiles.length === 0)
    return (
      <p className="field-hint">Add an Agent Profile in Agents, then check it here.</p>
    );
  return (
    <div className="setup-check-panel">
      <p className="field-hint" style={{ maxWidth: 720 }}>
        Proves each profile is signed in and can read and edit files in a headless run, at
        its permission level. Each check sends one short prompt with that profile, using
        your plan, and takes up to three minutes.
      </p>
      <button
        className="btn"
        disabled={busy}
        onClick={() => void run(profiles.map((p) => p.id))}
      >
        {busy ? 'Checking…' : 'Check every profile'}
      </button>
      <ul className="setup-check-profiles">
        {profiles.map((profile) => {
          const state = checks[profile.id];
          if (state === undefined) return null;
          return (
            <li key={profile.id}>
              <details open={state.kind === 'done' && state.report.status !== 'passed'}>
                <summary>
                  <span>{profile.name}</span> <SetupCheckStatusLine state={state} />
                </summary>
                {state.kind === 'done' && <SetupCheckResult report={state.report} />}
                {state.kind === 'error' && <p className="field-hint">{state.message}</p>}
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
