import { useEffect, useState } from 'react';
import { getBackend } from '../lib/backend';
import {
  createDefaultProfile,
  ADAPTERS,
  ADAPTER_LABELS,
  AGENT_SETUP_GUIDE,
  AGENT_SIGN_IN,
  BUILTIN_ADAPTERS,
  recommendedProfiles,
  supportsEffort,
  type AdapterKind,
  type AgentProfile,
} from '../lib/agents';
import { MCP_PRESETS, MCP_SETUP_GUIDE } from '../lib/integrations';
import { useAppStore } from '../store';
import { errorMessage } from '../lib/errors';
import { AgentPermissionsSettings } from './AgentPermissions';
import { Modal } from './Modal';
import { Notice, useNoticeMessage } from './Notice';
import { SetupCheckPanel } from './SetupCheck';

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
  ...BUILTIN_ADAPTERS.map((id) => ({
    id,
    name: ADAPTERS[id].name,
    blurb: ADAPTERS[id].notes,
    steps: [
      `Install the CLI and verify \`${ADAPTERS[id].executable} --version\` in a terminal.`,
      AGENT_SIGN_IN[id],
    ],
  })),
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
  'Permissions',
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
  const [message, setMessage, messageVariant, messageEvent] = useNoticeMessage();
  const [busy, setBusy] = useState(false);
  const [assistanceProfileId, setAssistanceProfileId] = useState('');
  const [pickedAdapter, setPickedAdapter] = useState<AdapterKind | null>(null);
  const [modelDraft, setAssistanceModel] = useState<string | null>(null);
  const [assistanceEffort, setAssistanceEffort] = useState('high');
  const detectedAgents = BUILTIN_ADAPTERS.filter((id) =>
    tools.some((tool) => tool.id === id && tool.installed),
  );
  const assistanceAdapter = pickedAdapter ?? detectedAgents[0] ?? 'claude';
  const assistanceModel =
    modelDraft ??
    (assistanceAdapter === 'claude'
      ? 'fable'
      : assistanceAdapter === 'codex'
        ? 'gpt-6.1-sol'
        : '');

  useEffect(() => {
    let cancelled = false;
    void getBackend()
      .getSetting('workflow.assistanceProfileId')
      .then((id) => {
        if (!cancelled && id !== null && profiles.some((p) => p.id === id))
          setAssistanceProfileId(id);
      })
      .catch((err: unknown) => {
        if (!cancelled) setMessage(errorMessage(err), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [profiles, setMessage]);

  const existingAssistant =
    assistanceProfileId !== ''
      ? profiles.find((p) => p.id === assistanceProfileId)
      : profiles.find(
          (p) => p.role === 'workflowAssistance' && p.adapter === assistanceAdapter,
        );
  const missingProfiles = (): AgentProfile[] => {
    const recommended = recommendedProfiles(profiles).filter(
      (p) => p.role !== 'workflowAssistance',
    );
    if (detectedAgents.length === 0) return recommended;
    const usable = recommended.filter((p) =>
      detectedAgents.some((id) => id === p.adapter),
    );
    const covered = new Set(
      [...profiles, ...usable]
        .filter((p) => detectedAgents.some((id) => id === p.adapter))
        .map((p) => p.role),
    );
    for (const [role, label] of [
      ['planning', 'Planning'],
      ['implementation', 'Implementation'],
      ['fastReview', 'Fast review'],
      ['deepReview', 'Deep review'],
      ['workflowGenerator', 'Workflow generator'],
      ['generalPurpose', 'General purpose'],
    ] as const) {
      if (covered.has(role)) continue;
      const adapter = detectedAgents[0] ?? assistanceAdapter;
      usable.push({
        ...createDefaultProfile(adapter),
        name: `${ADAPTER_LABELS[adapter]} — ${label}`,
        role,
      });
    }
    return usable;
  };
  const needsProfiles = missingProfiles().length > 0 || existingAssistant === undefined;

  const installed = (id: string): boolean =>
    tools.some((t) => t.id === id && t.installed);

  const openGuide = (url: string): void => {
    void getBackend()
      .openExternalUrl(url)
      .catch((error: unknown) => setMessage(errorMessage(error), 'error'));
  };

  const finish = (): void => {
    void (async () => {
      try {
        if (assistanceProfileId !== '')
          await getBackend().setSetting(
            'workflow.assistanceProfileId',
            assistanceProfileId,
          );
        await getBackend().setSetting('onboarding.completed', '1');
        onClose();
      } catch (err) {
        setMessage(errorMessage(err), 'error');
      }
    })();
  };

  const seedProfiles = (): void => {
    setBusy(true);
    setMessage(null);
    const missing = missingProfiles();
    const assistant = existingAssistant ?? {
      ...createDefaultProfile(assistanceAdapter),
      name: `${ADAPTER_LABELS[assistanceAdapter]} — Workflow assistance`,
      role: 'workflowAssistance',
      ...(assistanceModel.trim() ? { model: assistanceModel.trim() } : {}),
      ...(supportsEffort(assistanceAdapter) ? { effort: assistanceEffort } : {}),
    };
    if (!existingAssistant) missing.push(assistant);
    void (async () => {
      try {
        for (const item of missing) {
          await getBackend().saveAgentProfile(item);
        }
        await getBackend().setSetting('workflow.assistanceProfileId', assistant.id);
        setAssistanceProfileId(assistant.id);
        await refreshAll();
        setMessage(
          missing.length === 0
            ? 'All recommended roles already have a profile.'
            : `Created ${missing.map((m) => m.name).join(', ')}. Tune model/effort in Agents anytime.`,
        );
      } catch (err) {
        setMessage(errorMessage(err), 'error');
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
              Orchevia runs visual workflows on your machine using the developer tools you
              connect. You sign in to each provider through its own CLI. Orchevia stores
              workflows and run history locally.
            </p>
            <p className="field-hint">
              Set up an agent now, or try <strong>Templates → First Workflow</strong> with
              a local command and an approval. You can return to this wizard anytime.
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
              Installed but still “Not found”? Orchevia reads your login shell’s PATH and
              also checks common install locations (nvm, fnm, ~/.local/bin, bun, cargo,
              pnpm, Homebrew). Otherwise paste the full binary path into the Agent
              Profile’s Executable field later, then use Refresh in Environment.
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
            <button
              className="btn btn-ghost"
              onClick={() => openGuide(AGENT_SETUP_GUIDE)}
            >
              Agent setup guide
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
            <h3 style={{ fontSize: 14 }}>MCP connections</h3>
            <p className="field-hint">
              Environment has setup recipes for{' '}
              {MCP_PRESETS.map((preset) => preset.name).join(', ')}. Jira works with
              Ticket steps. The other recipes expose tools for MCP Tool steps.
            </p>
            <p className="field-hint">
              After setup, open <strong>Environment</strong> to register a server and run
              <strong> Check server</strong>. Sign in through the tool or its launch
              environment.
            </p>
            <button className="btn" onClick={() => openGuide(MCP_SETUP_GUIDE)}>
              MCP setup guide
            </button>
          </>
        )}

        {step === 3 && (
          <>
            <p className="field-hint">
              AI Agent nodes <strong>require</strong> a profile — without one the workflow
              fails validation. Templates, samples, and the generator expect these roles:
              planning, implementation, fast + deep review, workflow generation and
              assistance.
            </p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {[
                'planning',
                'implementation',
                'fastReview',
                'deepReview',
                'workflowGenerator',
                'workflowAssistance',
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
            <div className="field">
              <label className="field-label" htmlFor="setup-assistance-profile">
                Default workflow assistance profile
              </label>
              <select
                id="setup-assistance-profile"
                className="input"
                value={assistanceProfileId}
                onChange={(e) => setAssistanceProfileId(e.target.value)}
              >
                <option value="">Configure a recommendation below</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.adapter})
                  </option>
                ))}
              </select>
              <span className="field-hint">
                Assistance arranges or improves an existing workflow through a reviewed
                preview. Existing profiles keep their settings.
              </span>
            </div>
            {assistanceProfileId === '' && (
              <div className="generator-row">
                <div className="field">
                  <label className="field-label" htmlFor="setup-assistance-cli">
                    Assistance CLI
                  </label>
                  <select
                    id="setup-assistance-cli"
                    className="input"
                    value={assistanceAdapter}
                    onChange={(e) => {
                      const adapter = e.target.value as AdapterKind;
                      setPickedAdapter(adapter);
                      setAssistanceModel(null);
                    }}
                  >
                    {BUILTIN_ADAPTERS.map((id) => (
                      <option key={id} value={id}>
                        {ADAPTER_LABELS[id]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="setup-assistance-model">
                    Assistance model
                  </label>
                  <input
                    id="setup-assistance-model"
                    className="input"
                    value={assistanceModel}
                    onChange={(e) => setAssistanceModel(e.target.value)}
                    placeholder="Blank uses CLI default"
                  />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="setup-assistance-effort">
                    Assistance effort
                  </label>
                  <select
                    id="setup-assistance-effort"
                    className="input"
                    disabled={!supportsEffort(assistanceAdapter)}
                    value={assistanceEffort}
                    onChange={(e) => setAssistanceEffort(e.target.value)}
                  >
                    {['low', 'medium', 'high', 'xhigh'].map((effort) => (
                      <option key={effort}>{effort}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              {!needsProfiles ? (
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
              {detectedAgents.length > 0
                ? 'Recommendations use the CLIs Orchevia detected. You can change their role and model in Agents.'
                : 'Install and re-detect an agent to use it in these recommendations, or create starter profiles for Claude Code and Codex.'}
            </p>
          </>
        )}

        {step === 4 && (
          <>
            <p className="field-hint">
              Claude Code and Codex run headless in workflows, so they cannot stop and ask
              for permission: a tool they are not allowed is refused, and the step fails.
              Choose what those two CLIs may do here or in Environment → Agent
              permissions. Muse Code, Gemini CLI, Antigravity and OpenCode use their own
              CLI settings.
            </p>
            <AgentPermissionsSettings idPrefix="setup-permissions" />
          </>
        )}

        {step === 5 && (
          <>
            <p className="field-hint">
              Start from a template, generate from a goal (validated preview, never
              auto-runs), or open the Plan → Approve → Implement → Review demo in{' '}
              <strong>Workflows</strong>. Schedules and PR watchers live under{' '}
              <strong>Automations</strong>.
            </p>
          </>
        )}

        {step === 6 && (
          <>
            <p className="field-hint">
              You are ready. Workflows run only when you press ▶ Run; approvals pause for
              your decision; schedules stay disabled until you trust them. Reopen this
              wizard anytime from the sidebar.
            </p>
            <h3 style={{ fontSize: 13, marginBottom: 4 }}>
              Check your agents (optional)
            </h3>
            <SetupCheckPanel profiles={profiles} />
          </>
        )}

        {message !== null && (
          <Notice
            variant={messageVariant}
            eventId={messageEvent}
            onDismiss={() => setMessage(null)}
          >
            {message}
          </Notice>
        )}

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
