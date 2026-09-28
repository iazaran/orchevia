import { useState } from 'react';
import { getBackend } from '../lib/backend';
import { ADAPTER_LABELS, createDefaultProfile, type AdapterKind } from '../lib/agents';
import { useAppStore } from '../store';
import { errorMessage } from '../lib/errors';
import { Modal } from './Modal';
import { Notice } from './Notice';

interface InstallHint {
  id: string;
  name: string;
  blurb: string;
  steps: string[];
}

const INSTALL_HINTS: InstallHint[] = [
  {
    id: 'git',
    name: 'Git',
    blurb: 'Version control — needed by Git nodes and the Commit + PR flow.',
    steps: [
      'Install: `sudo apt install git` on Linux, `xcode-select --install` on macOS.',
      'Set your identity: `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`.',
      'Back here → Re-detect tools.',
    ],
  },
  {
    id: 'gh',
    name: 'GitHub CLI',
    blurb: 'Needed by GitHub nodes (PRs, checks, comments).',
    steps: [
      'Install: `sudo apt install gh` on Linux, `brew install gh` on macOS.',
      'Authenticate: run `gh auth login` in a terminal and complete the flow.',
      'Back here → Re-detect tools.',
    ],
  },
  {
    id: 'claude',
    name: 'Claude Code',
    blurb: 'One of the AI CLIs that powers Agent nodes.',
    steps: [
      'Install from your Claude dashboard, then make sure `claude` is on PATH (`claude --version` in a terminal).',
      'Authenticate: run `claude login` (or the provider flow) in a terminal.',
      'Back here → Re-detect tools, then Test the profile in Agents.',
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    blurb: 'The other AI CLI that powers Agent nodes.',
    steps: [
      'Install from your Codex dashboard, then make sure `codex` is on PATH (`codex --version` in a terminal).',
      'Complete the Codex login flow in a terminal.',
      'Back here → Re-detect tools, then Test the profile in Agents.',
    ],
  },
];

/** Render `code` spans inside help strings. */
function rich(text: string): React.ReactNode {
  const parts = text.split('`');
  return parts.map((part, i) =>
    i % 2 === 1 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>,
  );
}

const STEPS = [
  'Welcome',
  'Tools',
  'Connect',
  'Agents',
  'First workflow',
  'Done',
] as const;

export function OnboardingWizard({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const tools = useAppStore((s) => s.tools);
  const githubState = useAppStore((s) => s.githubState);
  const profiles = useAppStore((s) => s.profiles);
  const refreshAll = useAppStore((s) => s.refreshAll);
  const [step, setStep] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const installed = (id: string): boolean =>
    tools.some((t) => t.id === id && t.installed);

  const finish = (): void => {
    void getBackend()
      .setSetting('onboarding.completed', '1')
      .catch(() => {})
      .finally(() => {
        onClose();
      });
  };

  const seedProfiles = (): void => {
    setBusy(true);
    setMessage(null);
    // Roles that templates, samples, and the generator expect. Preferred
    // adapter first, installed fallback second, preferred anyway last (a
    // profile for a missing CLI shows an unavailable state, never an error).
    const wanted: { role: string; label: string; preferred: AdapterKind }[] = [
      { role: 'planning', label: 'Planning', preferred: 'claude' },
      { role: 'implementation', label: 'Implementation', preferred: 'claude' },
      { role: 'fastReview', label: 'Fast review', preferred: 'claude' },
      { role: 'deepReview', label: 'Deep review', preferred: 'codex' },
      { role: 'workflowGenerator', label: 'Workflow generator', preferred: 'claude' },
    ];
    const missing = wanted.filter((w) => !profiles.some((p) => p.role === w.role));
    void (async () => {
      try {
        for (const item of missing) {
          const other: AdapterKind = item.preferred === 'claude' ? 'codex' : 'claude';
          const adapter = installed(item.preferred)
            ? item.preferred
            : installed(other)
              ? other
              : item.preferred;
          await getBackend().saveAgentProfile({
            ...createDefaultProfile(adapter),
            name: `${ADAPTER_LABELS[adapter]} — ${item.label}`,
            role: item.role,
          });
        }
        await refreshAll();
        setMessage(
          missing.length === 0
            ? 'All recommended roles already have a profile.'
            : `Created ${missing.map((m) => m.label).join(', ')}. Tune model/effort in Agents anytime.`,
        );
      } catch (err) {
        setMessage(errorMessage(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Modal label="Orchevia setup wizard" maxWidth={640}>
      <div>
        <h2 style={{ marginTop: 0 }}>
          Set up Orchevia ({step + 1}/{STEPS.length}: {STEPS[step]})
        </h2>

        {step === 0 && (
          <>
            <p className="field-hint">
              Orchevia runs <strong>local-first</strong>: visual workflows that drive CLIs
              you already installed — Claude Code, Codex, <code>git</code>,{' '}
              <code>gh</code> — plus Jira via MCP. No accounts, no API keys, no telemetry.
              Third-party CLIs may contact their own providers; Orchevia itself sends
              nothing anywhere.
            </p>
            <p className="field-hint">
              This wizard detects your tools, helps you install/log in where needed, and
              creates your first Agent Profiles. Nothing runs until you press ▶ Run.
            </p>
          </>
        )}

        {step === 1 && (
          <>
            <div className="tool-grid">
              {INSTALL_HINTS.map((hint) => (
                <div key={hint.id} className="tool-card">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <h3 style={{ margin: 0 }}>{hint.name}</h3>
                    <span
                      className={`status-pill ${installed(hint.id) ? 'status-succeeded' : 'status-cancelled'}`}
                    >
                      {installed(hint.id) ? 'Detected' : 'Not found'}
                    </span>
                  </div>
                  <p className="field-hint" style={{ marginBottom: 0 }}>
                    {hint.blurb}
                  </p>
                  {!installed(hint.id) && (
                    <ol className="wizard-steps">
                      {hint.steps.map((step) => (
                        <li key={step}>{rich(step)}</li>
                      ))}
                    </ol>
                  )}
                </div>
              ))}
            </div>
            <p className="field-hint" style={{ marginTop: 12 }}>
              Installed but still “Not found”? Apps launched from the desktop don’t
              inherit your terminal’s PATH. Orchevia also probes well-known spots
              (~/.local/bin, /usr/local/bin, mise/asdf/volta shims) — otherwise launch it
              once from a terminal, or paste the full binary path into the Agent Profile’s
              Executable field later.
            </p>
            <button
              className="btn"
              style={{ marginTop: 4 }}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void refreshAll().finally(() => {
                  setBusy(false);
                });
              }}
            >
              Re-detect tools
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <h3 style={{ fontSize: 14 }}>GitHub</h3>
            <p className="field-hint">
              {githubState === null
                ? 'Detecting…'
                : githubState.installed
                  ? githubState.authenticated
                    ? `Authenticated${githubState.user !== undefined ? ` as ${githubState.user}` : ''}.`
                    : 'Installed but not authenticated — run `gh auth login`, then Re-detect.'
                  : 'Install `gh` and run `gh auth login` to enable GitHub nodes.'}
            </p>
            <h3 style={{ fontSize: 14 }}>Jira via MCP</h3>
            <p className="field-hint">
              Ticket nodes read Jira through a local MCP server (tool{' '}
              <code>jira_get_issue</code> by default). Register it under Environment → MCP
              servers: press <strong>+ New MCP server</strong>, open the{' '}
              <strong>Setting up Jira?</strong> guide inside the editor, and use{' '}
              <strong>Fill Jira example</strong>. Credentials live in your shell profile
              (never in Orchevia) — the guide has a “Check what Orchevia sees” button
              proving they reached the app. Ticket text is untrusted input — passed to
              agents as data, never executed.
            </p>
            <p className="field-hint">
              After finishing here: open <strong>Environment</strong> in the sidebar to
              register the MCP server and check GitHub auth.
            </p>
          </>
        )}

        {step === 3 && (
          <>
            <p className="field-hint">
              AI Agent nodes <strong>require</strong> a profile — without one the workflow
              fails validation. Templates, samples, and the generator expect these roles:
              planning, implementation, fast + deep review, and a workflow generator.
            </p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {[
                'planning',
                'implementation',
                'fastReview',
                'deepReview',
                'workflowGenerator',
              ].map((role) => {
                const covered = profiles.some((p) => p.role === role);
                return (
                  <span
                    key={role}
                    className={`status-pill ${covered ? 'status-succeeded' : 'status-paused'}`}
                  >
                    {covered ? '✓' : '·'} {role}
                  </span>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {[
                'planning',
                'implementation',
                'fastReview',
                'deepReview',
                'workflowGenerator',
              ].every((role) => profiles.some((p) => p.role === role)) ? (
                <p className="field-hint" style={{ marginBottom: 0 }}>
                  ✓ All recommended roles are covered — nothing left to create.
                </p>
              ) : (
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={seedProfiles}
                >
                  Create recommended profiles
                </button>
              )}
            </div>
            <p className="field-hint" style={{ marginTop: 8 }}>
              One click creates the missing roles on your installed CLIs (missing CLIs
              show as unavailable, never break). In Agents you can set models and effort
              (low/medium/high/xhigh) per profile. Using another coding CLI (aichat, sgpt,
              mods, …)? Add it manually in Agents → New profile → Custom CLI with the full
              binary path.
            </p>
          </>
        )}

        {step === 4 && (
          <>
            <p className="field-hint">
              Start from a template (9 built-in), generate from a goal (validated preview,
              never auto-runs), or open the Plan → Approve → Implement → Review demo in{' '}
              <strong>Workflows</strong>. Schedules and PR watchers live under{' '}
              <strong>Automations</strong>.
            </p>
          </>
        )}

        {step === 5 && (
          <p className="field-hint">
            You are ready. Workflows run only when you press ▶ Run; approvals pause for
            your decision; schedules stay disabled until you trust them. Reopen this
            wizard anytime from the sidebar.
          </p>
        )}

        {message !== null && <Notice style={{ marginTop: 12 }}>{message}</Notice>}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            className="btn btn-ghost"
            disabled={step === 0}
            onClick={() => {
              setMessage(null);
              setStep((s) => Math.max(0, s - 1));
            }}
          >
            Back
          </button>
          {step < STEPS.length - 1 ? (
            <button
              className="btn btn-primary"
              onClick={() => {
                setMessage(null);
                setStep((s) => Math.min(STEPS.length - 1, s + 1));
              }}
            >
              Next
            </button>
          ) : (
            <button className="btn btn-primary" onClick={finish}>
              Finish setup
            </button>
          )}
          <button
            className="btn btn-ghost"
            style={{ marginLeft: 'auto' }}
            onClick={finish}
          >
            Skip
          </button>
        </div>
      </div>
    </Modal>
  );
}
