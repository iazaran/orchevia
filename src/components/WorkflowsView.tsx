import { useEffect, useState } from 'react';
import { ADAPTER_LABELS, createDefaultProfile, type AdapterKind } from '../lib/agents';
import { getBackend } from '../lib/backend';
import {
  applyAssistancePreview,
  assistanceChanges,
  assistanceRepoDir,
  resolveAssistanceProfile,
  type AssistanceMode,
  describeGeneratedStep,
  parseInputDeclarations,
  resolveGeneratorProfile,
  summarizeGenerationExplanation,
  type GenerationPreview,
  type ProjectMemoryContext,
} from '../lib/generation';
import {
  createAgentDemoWorkflow,
  createCommitPrWorkflow,
  createEmptyWorkflow,
  createReviewLoopDemoWorkflow,
  createReviewWorkflow,
  type Workflow,
  type StoredWorkflow,
} from '../lib/workflow';
import { selectActiveWorkflow, useAppStore } from '../store';
import { confirmDialog } from './ConfirmDialog';
import { DirPicker } from './DirPicker';
import { BranchPicker } from './BranchPicker';
import { NodeInspector } from './NodeInspector';
import { WorkflowCanvas } from './WorkflowCanvas';
import { CloseButton } from './CloseButton';
import { Notice } from './Notice';
import { Modal } from './Modal';
import { readLocal, writeLocal } from '../lib/storage';
import { errorMessage } from '../lib/errors';

function explainGenerationError(raw: string): string {
  if (raw.includes('Ticket nodes need a ticketKey')) {
    return (
      'The AI proposed Ticket steps (great for Jira flows), but no Jira MCP server ' +
      'or ticket key is configured, so the proposal was rejected. Either: (1) set up ' +
      'Jira in Environment → MCP servers (Fill Jira example) and retry, or (2) rephrase ' +
      'the goal without tickets — e.g. “implement in branch X, review with Codex”. ' +
      `Details: ${raw}`
    );
  }
  if (raw.includes('was not found on PATH')) {
    return `${raw} Tip: launch Orchevia from a terminal once, or set the full binary path in the Agent Profile.`;
  }
  if (/not a model|unrecognized_model|unknown model/i.test(raw)) {
    return (
      'The generator profile names a model your installed CLI does not recognize. ' +
      'Open Agents → that profile → Model: clear it (blank = CLI default, always valid) ' +
      'or type a name from `<cli> --help`. Orchevia passes the string through verbatim — ' +
      'only the CLI decides what exists. ' +
      `Details: ${raw}`
    );
  }
  return raw;
}

function roleMappingMessage(role: string): string {
  return `Role '${role}' has no Agent Profile mapping.`;
}

/// Max generator-goal length in characters — mirrors `MAX_GOAL_CHARS` in the
/// desktop backend (which also counts the inputs/repair context appended here).
const MAX_GOAL_CHARS = 12_000;

export function WorkflowsView(): React.JSX.Element {
  const workflows = useAppStore((s) => s.workflows);
  const active = useAppStore(selectActiveWorkflow);
  const selectWorkflow = useAppStore((s) => s.selectWorkflow);
  const saveActiveWorkflow = useAppStore((s) => s.saveActiveWorkflow);
  const workflowSaveStates = useAppStore((s) => s.workflowSaveStates);
  const retryWorkflowSave = useAppStore((s) => s.retryWorkflowSave);
  const deleteWorkflow = useAppStore((s) => s.deleteWorkflow);
  const activeSaveState = active === null ? undefined : workflowSaveStates[active.id];
  const refreshWorkflows = useAppStore((s) => s.refreshWorkflows);
  const refreshRuns = useAppStore((s) => s.refreshRuns);
  const setView = useAppStore((s) => s.setView);
  const selectRun = useAppStore((s) => s.selectRun);
  const validation = useAppStore((s) => s.validation);
  const setValidation = useAppStore((s) => s.setValidation);
  const profiles = useAppStore((s) => s.profiles);
  const overlayRunId = useAppStore((s) => s.overlayRunId);
  const overlayWorkflow = useAppStore((s) => s.overlayWorkflow);
  const selectedNodeId = useAppStore((s) => s.selectedNodeId);
  const refreshRunOverlay = useAppStore((s) => s.refreshRunOverlay);
  const overlayResults = useAppStore((s) => s.overlayResults);
  const showRunOverlay = useAppStore((s) => s.showRunOverlay);
  const [showSamples, setShowSamples] = useState(false);
  const [runMessage, setRunMessage] = useState<string | null>(null);
  useEffect(() => {
    if (overlayRunId === null) return;
    const timer = setInterval(() => {
      void refreshRunOverlay().catch((err: unknown) => setRunMessage(errorMessage(err)));
    }, 1500);
    return () => clearInterval(timer);
  }, [overlayRunId, refreshRunOverlay]);
  const [starting, setStarting] = useState(false);
  const [dismissedValidation, setDismissedValidation] = useState<string | null>(null);
  const [inputState, setInputState] = useState<{
    workflowId: string | null;
    values: Record<string, string>;
    shown: boolean;
    expanded: Record<string, boolean>;
  }>({ workflowId: null, values: {}, shown: false, expanded: {} });
  const inputValues = inputState.workflowId === active?.id ? inputState.values : {};
  const showInputs = inputState.workflowId === active?.id && inputState.shown;
  const expandedInputs = inputState.workflowId === active?.id ? inputState.expanded : {};
  const [goal, setGoal] = useState('');
  const [genRepoDir, setGenRepoDir] = useState<string>(
    () => readLocal('orchevia.genRepo.v1') ?? '',
  );
  const [genBranch, setGenBranch] = useState('');
  const [detectingGenBranch, setDetectingGenBranch] = useState(false);
  const [genRepoMsg, setGenRepoMsg] = useState<string | null>(null);
  const [memoryContext, setMemoryContext] = useState<ProjectMemoryContext | null>(null);
  const [memoryDirectory, setMemoryDirectory] = useState<string | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [assistanceBase, setAssistanceBase] = useState<Workflow | null>(null);
  const [assistanceMode, setAssistanceMode] = useState<AssistanceMode>('optimize');
  const [generatorAdapter, setGeneratorAdapter] = useState<AdapterKind>('claude');
  const [advancedProfileId, setAdvancedProfileId] = useState('');
  const [showAdvancedProfile, setShowAdvancedProfile] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [acceptingPreview, setAcceptingPreview] = useState(false);
  const [showGoalInputs, setShowGoalInputs] = useState(false);
  const [goalInputs, setGoalInputs] = useState<string>(
    () => readLocal('orchevia.genInputs.v1') ?? '',
  );
  const [genElapsed, setGenElapsed] = useState(0);
  const [lastGenError, setLastGenError] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  useEffect(() => {
    if (!showGenerator) return;
    let cancelled = false;
    // Debounce typed repository paths and discard stale responses.
    const timer = setTimeout(() => {
      setMemoryLoading(true);
      setMemoryError(null);
      setMemoryContext(null);
      void getBackend()
        .getProjectMemoryContext(genRepoDir.trim() || undefined)
        .then((context) => {
          if (!cancelled) {
            setMemoryContext(context);
            setMemoryDirectory(genRepoDir.trim());
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setMemoryError(errorMessage(error));
            setMemoryDirectory(genRepoDir.trim());
          }
        })
        .finally(() => {
          if (!cancelled) setMemoryLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [showGenerator, genRepoDir]);

  const assistanceTargetId = assistanceBase?.id;
  useEffect(() => {
    if (!showGenerator || assistanceTargetId === undefined) return;
    let cancelled = false;
    void getBackend()
      .getSetting('workflow.assistanceProfileId')
      .then((id) => {
        if (!cancelled && id !== null && profiles.some((p) => p.id === id))
          setAdvancedProfileId(id);
      })
      .catch((err: unknown) => {
        if (!cancelled) setGenError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [showGenerator, assistanceTargetId, profiles]);

  const closeGenerator = (): void => {
    if (generating || acceptingPreview) return;
    setShowGenerator(false);
    setAssistanceBase(null);
    setPreview(null);
    setGenError(null);
    setLastGenError(null);
    setRepairHint('');
    setRepairRound(0);
  };
  const [repairHint, setRepairHint] = useState('');
  const [repairRound, setRepairRound] = useState(0);
  const [preview, setPreview] = useState<GenerationPreview | null>(null);
  const refreshLibrary = useAppStore((s) => s.refreshLibrary);
  const knownFolders = useAppStore((s) => s.knownFolders);
  const [commitPrDir, setCommitPrDir] = useState('');
  const [commitPrBranch, setCommitPrBranch] = useState('');
  const [commitPrError, setCommitPrError] = useState<string | null>(null);
  useEffect(() => {
    if (!generating) return;
    const started = Date.now();
    const timer = setInterval(() => {
      setGenElapsed(Math.round((Date.now() - started) / 1000));
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, [generating]);
  const refreshProfiles = useAppStore((s) => s.refreshProfiles);
  const activeId = active?.id;
  const validationKey = validation.map((i) => i.code + (i.nodeId ?? '')).join('|');
  const validationIdentity = JSON.stringify([activeId, validationKey]);
  const validationHidden = dismissedValidation === validationIdentity;

  const { inputs: declaredInputs, problems: inputProblems } =
    parseInputDeclarations(goalInputs);

  const createWorkflow = (): void => {
    const wf = createEmptyWorkflow(`Untitled ${String(workflows.length + 1)}`);
    updateActiveWorkflowAfterCreate(wf);
  };

  /** Demo: Plan → Approve → Implement → Review. Maps roles to profiles by name. */
  const createDemoWorkflow = (): void => {
    const byRole = (role: string): string => {
      const found = profiles.find((p) => p.role === role);
      if (found !== undefined) return found.id;
      // Fall back to adapter defaults so the graph is still meaningful;
      // validation will flag unmapped profiles until the user edits them.
      if (role === 'deepReview') {
        return profiles.find((p) => p.adapter === 'codex')?.id ?? 'missing-codex-profile';
      }
      return profiles.find((p) => p.adapter === 'claude')?.id ?? 'missing-claude-profile';
    };
    const wf = createAgentDemoWorkflow({
      plan: byRole('planning'),
      implement: byRole('implementation'),
      review: byRole('deepReview'),
    });
    updateActiveWorkflowAfterCreate(wf);
  };

  /** Review-loop demo: parallel reviews + condition-guarded fix cycle. */
  const createLoopDemoWorkflow = (): void => {
    const codex =
      profiles.find((p) => p.adapter === 'codex')?.id ?? 'missing-codex-profile';
    const claude =
      profiles.find((p) => p.adapter === 'claude')?.id ?? 'missing-claude-profile';
    const wf = createReviewLoopDemoWorkflow({
      implement: profiles.find((p) => p.role === 'implementation')?.id ?? claude,
      reviewA: profiles.find((p) => p.role === 'fastReview')?.id ?? claude,
      reviewB: profiles.find((p) => p.role === 'deepReview')?.id ?? codex,
    });
    updateActiveWorkflowAfterCreate(wf);
  };

  /** PR review demo: load PR → parallel reviews → condition → draft note. */
  const createReviewDemoWorkflow = (): void => {
    const codex =
      profiles.find((p) => p.adapter === 'codex')?.id ?? 'missing-codex-profile';
    const claude =
      profiles.find((p) => p.adapter === 'claude')?.id ?? 'missing-claude-profile';
    const wf = createReviewWorkflow({
      fastReview: profiles.find((p) => p.role === 'fastReview')?.id ?? claude,
      deepReview: profiles.find((p) => p.role === 'deepReview')?.id ?? codex,
    });
    updateActiveWorkflowAfterCreate(wf);
  };

  /** Native commit/PR quick flow: Start → status → commit → draft PR → End. */
  const createCommitPrDemoWorkflow = (): void => {
    const dir = commitPrDir.trim() !== '' ? commitPrDir.trim() : (knownFolders[0] ?? '');
    if (dir === '') {
      setCommitPrError('Pick a repository directory first (type it or Browse…).');
      return;
    }
    setCommitPrError(null);
    updateActiveWorkflowAfterCreate(createCommitPrWorkflow(dir, commitPrBranch.trim()));
    setShowSamples(false);
  };

  const openJsonEditor = (): void => {
    if (active === null) return;
    setJsonBase(active.definition);
    setJsonError(null);
    setJsonModal(true);
    setJsonBusy(true);
    void getBackend()
      .encodeWorkflowDocument(active.definition)
      .then((session) => {
        setJsonText(session.json);
        setJsonIds(session.nodeIds);
        setJsonMode('simple');
      })
      .catch((err: unknown) => {
        setJsonMode('raw');
        setJsonText(JSON.stringify(active.definition, null, 2));
        setJsonError(errorMessage(err));
      })
      .finally(() => setJsonBusy(false));
  };
  const switchJsonMode = (mode: 'simple' | 'raw'): void => {
    setJsonBusy(true);
    void getBackend()
      .decodeWorkflowDocument(jsonText, jsonBase ?? undefined, jsonIds)
      .then(async (wf) => {
        setJsonBase(wf);
        if (mode === 'raw') setJsonText(JSON.stringify(wf, null, 2));
        else {
          const session = await getBackend().encodeWorkflowDocument(wf);
          setJsonText(session.json);
          setJsonIds(session.nodeIds);
        }
        setJsonMode(mode);
        setJsonError(null);
      })
      .catch((err: unknown) => setJsonError(errorMessage(err)))
      .finally(() => setJsonBusy(false));
  };
  const saveJsonEditor = (): void => {
    void (async () => {
      try {
        const backend = getBackend();
        const parsed = await backend.decodeWorkflowDocument(
          jsonText,
          jsonBase ?? undefined,
          jsonIds,
        );
        const issues = await backend.validateWorkflow(parsed);
        const blocking = issues.filter((issue) => issue.severity === 'error');
        if (blocking.length > 0) {
          const ok = await confirmDialog({
            title: `Save with ${String(blocking.length)} validation error${blocking.length === 1 ? '' : 's'}?`,
            message: `${blocking[0]?.message ?? 'Validation failed.'} The workflow saves anyway but cannot run until fixed.`,
            confirmLabel: 'Save anyway',
          });
          if (!ok) return;
        }
        const stored = await saveActiveWorkflow(parsed);
        if (!stored)
          throw new Error(
            'Workflow is no longer editable. Close JSON and select a saved workflow.',
          );
        await refreshWorkflows();
        selectWorkflow(stored.id);
        setValidation(issues);
        setJsonModal(false);
        setRunMessage(
          issues.length === 0
            ? `Saved '${stored.name}' from JSON — validation clean.`
            : `Saved '${stored.name}' from JSON with ${String(issues.length)} validation note${issues.length === 1 ? '' : 's'}.`,
        );
      } catch (err) {
        setJsonError(errorMessage(err));
      }
    })();
  };

  const updateActiveWorkflowAfterCreate = (wf: StoredWorkflow['definition']): void => {
    void getBackend()
      .saveWorkflow(wf)
      .then((stored) => {
        void refreshWorkflows().then(() => {
          selectWorkflow(stored.id);
        });
      })
      .catch((err: unknown) => {
        setRunMessage(errorMessage(err));
      });
  };

  const runActive = (): void => {
    if (active === null || starting) return;
    const declaredInputs = active.definition.inputs ?? [];
    // Warm the form with defaults on first open.
    if (!showInputs && declaredInputs.length > 0) {
      const seeded: Record<string, string> = {};
      for (const input of declaredInputs) {
        seeded[input.name] = inputValues[input.name] ?? input.default ?? '';
      }
      setInputState({
        workflowId: active.id,
        values: seeded,
        shown: true,
        expanded: expandedInputs,
      });
      return;
    }
    setRunMessage(null);
    setStarting(true);
    void (async () => {
      try {
        await saveActiveWorkflow();
        const backend = getBackend();
        const issues = await backend.validateWorkflow(active.definition);
        const blocking = issues.filter((i) => i.severity === 'error');
        if (blocking.length > 0) {
          setRunMessage(`Cannot run: ${blocking[0]?.message ?? 'validation failed.'}`);
          return;
        }
        const inputs = Object.fromEntries(
          declaredInputs.map((input) => [
            input.name,
            inputValues[input.name] ?? input.default ?? '',
          ]),
        );
        const { runId } = await backend.runWorkflow(active.id, inputs);
        await refreshRuns();
        await selectRun(runId);
        setView('runs');
      } catch (err) {
        setRunMessage(errorMessage(err));
      } finally {
        setStarting(false);
      }
    })();
  };

  const deleteActive = (): void => {
    if (active === null) return;
    const name = active.name;
    const id = active.id;
    void confirmDialog({
      title: `Delete '${name}'?`,
      message:
        'Deleting removes this workflow and its run history. Cancel running or paused runs first.',
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      void deleteWorkflow(id)
        .then(() => refreshWorkflows())
        .catch((err: unknown) => {
          setRunMessage(errorMessage(err));
        });
    });
  };

  const startRepair = (): void => {
    if (generating || acceptingPreview) return;
    if (repairRound >= 3) {
      const msg =
        '3 repair rounds used — edit the goal or inputs and press Generate for a fresh attempt, or finish the workflow by hand.';
      setRunMessage(msg);
      setGenError(msg);
      return;
    }
    const problems = [...(preview?.blocking ?? [])];
    if (lastGenError !== null && !problems.includes(lastGenError)) {
      problems.push(lastGenError);
    }
    const hint = repairHint.trim();
    if (problems.length === 0 && hint === '') {
      const msg = 'Nothing to repair yet — describe the problem in the hint field first.';
      setRunMessage(msg);
      setGenError(msg);
      return;
    }
    const lines = problems.map((item) => `- ${item}`);
    if (hint !== '') lines.push(`User guidance: ${hint}`);
    setRepairHint('');
    setRepairRound((r) => r + 1);
    generateFromGoal(lines.join('\n'));
  };

  const generateFromGoal = (repairFeedback: string | null = null): void => {
    if (generating || acceptingPreview) return;
    if (goal.trim() === '' && assistanceBase === null) {
      setRunMessage('Describe the goal first.');
      setGenError('Describe the goal first.');
      return;
    }
    if (goal.length > MAX_GOAL_CHARS) {
      const msg = `That goal is ${String(goal.length)} characters — shorten it below ${String(MAX_GOAL_CHARS)} (inputs and repair context count too).`;
      setRunMessage(msg);
      setGenError(msg);
      return;
    }
    const repoDir = genRepoDir.trim();
    const branch = genBranch.trim();
    if (repairFeedback === null) setRepairRound(0);
    setGenElapsed(0);
    setGenerating(true);
    setRunMessage(null);
    setGenError(null);
    setLastGenError(null);
    setPreview(null);
    // Pick the AI, Orchevia handles the rest: reuse the generator profile for
    // this AI when one exists, otherwise create it on the spot.
    void (async () => {
      try {
        const backend = getBackend();
        let profileId = advancedProfileId;
        if (profileId === '') {
          const existing = await backend.listAgentProfiles();
          profileId =
            (assistanceBase === null
              ? resolveGeneratorProfile(existing, generatorAdapter)
              : resolveAssistanceProfile(existing, generatorAdapter)) ?? '';
        }
        if (profileId === '') {
          const fresh = {
            ...createDefaultProfile(generatorAdapter),
            name: `${ADAPTER_LABELS[generatorAdapter]} — ${assistanceBase === null ? 'Generator' : 'Workflow assistance'}`,
            role: assistanceBase === null ? 'workflowGenerator' : 'workflowAssistance',
          };
          const saved = await backend.saveAgentProfile(fresh);
          await refreshProfiles();
          profileId = saved.id;
          setRunMessage(
            `Created '${saved.name}' for generation. Tune its model/effort in Agents anytime.`,
          );
        }
        const { inputs: declared, problems } = parseInputDeclarations(
          assistanceBase === null ? goalInputs : '',
        );
        if (problems.length > 0) {
          setRunMessage(`Fix the inputs list first: ${problems[0] ?? ''}`);
          return;
        }
        writeLocal('orchevia.genInputs.v1', goalInputs);
        if (repoDir !== '') writeLocal('orchevia.genRepo.v1', repoDir);
        let fullGoal =
          goal.trim() ||
          (assistanceMode === 'arrange'
            ? 'Arrange this workflow for readability.'
            : 'Improve this workflow using repository instructions and relevant run evidence.');
        if (declared.length > 0) {
          const lines = declared.map((d) =>
            d.default !== undefined ? `${d.name} (default: ${d.default})` : d.name,
          );
          fullGoal +=
            '\n\nAvailable workflow inputs — reference ONLY these as {{input.NAME}} ' +
            'and declare each one you use in top-level "inputs": ' +
            lines.join(', ');
        }
        if (repairFeedback !== null && repairFeedback !== '') {
          fullGoal +=
            '\n\nRepair round: the previous proposal had these problems. Fix EVERY item and keep everything else valid:\n' +
            repairFeedback;
        }
        let savedBase: Workflow | null = null;
        if (assistanceBase !== null) {
          const state = useAppStore.getState();
          const current = state.workflows.find((w) => w.id === assistanceBase.id);
          if (state.activeWorkflowId !== assistanceBase.id || current === undefined)
            throw new Error(
              'Select the workflow used for assistance before requesting another preview.',
            );
          const saved = await saveActiveWorkflow(current.definition);
          if (!saved) throw new Error('The workflow is no longer editable.');
          savedBase = structuredClone(saved.definition);
          setAssistanceBase(savedBase);
        }
        const result = await backend.generateWorkflow(
          profileId,
          fullGoal,
          {
            ...((savedBase?.defaults?.repoDir ?? repoDir) === ''
              ? {}
              : { dir: savedBase?.defaults?.repoDir ?? repoDir }),
            ...((savedBase?.defaults?.branch ?? branch) === ''
              ? {}
              : { branch: savedBase?.defaults?.branch ?? branch }),
          },
          savedBase === null
            ? undefined
            : { workflowId: savedBase.id, mode: assistanceMode },
        );
        setPreview(result);
      } catch (err) {
        const mapped = explainGenerationError(errorMessage(err));
        setLastGenError(mapped);
        setGenError(mapped);
        setRunMessage(mapped);
      } finally {
        setGenerating(false);
        setGenElapsed(0);
      }
    })();
  };

  const acceptPreview = (): void => {
    if (preview === null || acceptingPreview) return;
    // Role-mapping messages are auto-fixable (profiles get created below);
    // anything else blocks.
    const roleMsgs = new Set(preview.unmappedRoles.map(roleMappingMessage));
    const hard = preview.blocking.filter((b) => !roleMsgs.has(b));
    if (hard.length > 0) {
      setRunMessage(`Cannot accept: ${hard[0] ?? 'validation failed.'}`);
      return;
    }
    // Merge user-declared inputs (before-generate box wins on conflicts).
    const { inputs: declared } = parseInputDeclarations(
      assistanceBase === null ? goalInputs : '',
    );
    const mergedInputs = [...(preview.workflow.inputs ?? [])];
    for (const d of declared) {
      const entry = {
        name: d.name,
        ...(d.default !== undefined ? { default: d.default } : {}),
        required: d.required,
      };
      const ix = mergedInputs.findIndex((i) => i.name === d.name);
      if (ix >= 0) mergedInputs[ix] = { ...mergedInputs[ix], ...entry };
      else mergedInputs.push(entry);
    }
    const missingRoles = [...preview.unmappedRoles];
    setAcceptingPreview(true);
    void (async () => {
      try {
        const backend = getBackend();
        if (assistanceBase !== null) {
          const current = useAppStore
            .getState()
            .workflows.find((w) => w.id === assistanceBase.id);
          if (
            useAppStore.getState().activeWorkflowId !== assistanceBase.id ||
            current === undefined
          )
            throw new Error('Select the original workflow before applying assistance.');
          applyAssistancePreview(assistanceBase, current.definition, preview.workflow);
          const persisted = await backend.getWorkflow(assistanceBase.id);
          if (persisted === null)
            throw new Error('The original workflow no longer exists.');
          applyAssistancePreview(assistanceBase, persisted.definition, preview.workflow);
        }
        const created: string[] = [];
        // Auto-wire the MCP server when there is exactly one enabled choice:
        // ticket/mcp nodes without a server get it, so Jira flows accept
        // immediately when the user has their server configured.
        let autoServer: string | null = null;
        try {
          const servers = await backend.listMcpServers();
          const enabled = servers.filter((s) => s.enabled);
          if (enabled.length === 1 && enabled[0] !== undefined) {
            autoServer = enabled[0].id;
          }
        } catch {
          autoServer = null;
        }
        let workflow: Workflow = {
          ...structuredClone(preview.workflow),
          inputs: mergedInputs,
        };
        if (assistanceBase !== null) {
          const state = useAppStore.getState();
          const current = state.workflows.find((w) => w.id === assistanceBase.id);
          if (state.activeWorkflowId !== assistanceBase.id || current === undefined)
            throw new Error('Select the original workflow before applying assistance.');
          workflow = applyAssistancePreview(assistanceBase, current.definition, workflow);
        }
        if (autoServer !== null && assistanceBase === null) {
          for (const node of workflow.nodes) {
            if (
              (node.type === 'ticket' || node.type === 'mcp') &&
              (node.config.mcpServerId ?? '').trim() === ''
            ) {
              node.config.mcpServerId = autoServer;
            }
          }
        }
        for (const role of missingRoles) {
          const fresh = {
            ...createDefaultProfile(generatorAdapter),
            name: `${ADAPTER_LABELS[generatorAdapter]} — ${role}`,
            role,
          };
          const saved = await backend.saveAgentProfile(fresh);
          created.push(saved.name);
          for (const node of workflow.nodes) {
            if (node.type === 'agent' && node.config.agentRole === role) {
              node.config.agentProfileId = saved.id;
              delete node.config.agentRole;
            }
          }
        }
        if (created.length > 0) await refreshProfiles();
        if (assistanceBase !== null) {
          const persisted = await backend.getWorkflow(assistanceBase.id);
          if (persisted === null)
            throw new Error('The original workflow no longer exists.');
          applyAssistancePreview(assistanceBase, persisted.definition, workflow);
          // Check after every setup await, immediately before the store captures this save.
          const state = useAppStore.getState();
          const current = state.workflows.find((w) => w.id === assistanceBase.id);
          if (
            state.activeWorkflowId !== assistanceBase.id ||
            state.overlayRunId !== null ||
            current === undefined
          )
            throw new Error(
              'Select the original editable workflow before applying assistance.',
            );
          workflow = applyAssistancePreview(assistanceBase, current.definition, workflow);
        }
        const stored =
          assistanceBase === null
            ? await backend.saveWorkflow(workflow)
            : await saveActiveWorkflow(workflow);
        if (!stored) throw new Error('The workflow is no longer editable.');
        await backend
          .markGenerationStatus(preview.generationId, 'accepted')
          .catch(() => {});
        void refreshLibrary();
        await refreshWorkflows();
        const currentState = useAppStore.getState();
        if (
          assistanceBase === null ||
          (currentState.activeWorkflowId === assistanceBase.id &&
            currentState.overlayRunId === null)
        )
          selectWorkflow(stored.id);
        if (created.length > 0) {
          setRunMessage(
            `Accepted. Created profiles for missing roles: ${created.join(', ')}. Tune model/effort in Agents anytime.`,
          );
        }
        const notes: string[] = [];
        if (created.length > 0) {
          notes.push(`created profiles for missing roles: ${created.join(', ')}`);
        }
        if (autoServer !== null && assistanceBase === null) {
          notes.push('wired your MCP server into ticket/MCP nodes');
        }
        setPreview(null);
        setGoal('');
        setRepairHint('');
        setRepairRound(0);
        // Back to the canvas: the new workflow is selected and ready to edit.
        setShowGenerator(false);
        setAssistanceBase(null);
        setRunMessage(
          notes.length > 0
            ? `Accepted '${stored.name}' (${notes.join('; ')}).`
            : `Accepted '${stored.name}' — open on the canvas for editing.`,
        );
      } catch (err) {
        setRunMessage(errorMessage(err));
        setGenError(errorMessage(err));
      } finally {
        setAcceptingPreview(false);
      }
    })();
  };

  const discardPreview = (): void => {
    if (acceptingPreview) return;
    if (preview !== null) {
      void getBackend()
        .markGenerationStatus(preview.generationId, 'discarded')
        .catch(() => {});
    }
    setPreview(null);
  };

  const [templateModal, setTemplateModal] = useState(false);
  const [jsonMode, setJsonMode] = useState<'simple' | 'raw'>('simple');
  const [jsonBase, setJsonBase] = useState<Workflow | null>(null);
  const [jsonIds, setJsonIds] = useState<Record<string, string>>({});
  const [jsonBusy, setJsonBusy] = useState(false);
  const [jsonModal, setJsonModal] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [templateCategory, setTemplateCategory] = useState('general');

  const openSaveAsTemplate = (): void => {
    if (active === null) return;
    setTemplateName(`${active.name} (template)`);
    setTemplateCategory('general');
    setTemplateModal(true);
  };

  const saveAsTemplate = (): void => {
    if (active === null) return;
    if (templateName.trim() === '') {
      setRunMessage('Give the template a name first.');
      return;
    }
    const name = templateName.trim();
    const category = templateCategory.trim() === '' ? 'general' : templateCategory.trim();
    void saveActiveWorkflow(active.definition)
      .then((stored) => {
        if (!stored) throw new Error('The workflow is no longer editable.');
        return getBackend().saveWorkflowAsTemplate(stored.id, name, category);
      })
      .then(() => {
        setTemplateModal(false);
        setRunMessage(`Saved template '${name}' — find it under Templates → Mine.`);
        void refreshLibrary();
      })
      .catch((err: unknown) => {
        setRunMessage(errorMessage(err));
      });
  };

  return (
    <>
      <div className="topbar workflow-topbar">
        <h1>Workflows</h1>
        <span className="topbar-sub">
          Design, then run — execution is always explicit.
        </span>
        <fieldset
          className="topbar-actions"
          style={{ border: 0, margin: 0, marginLeft: 'auto', padding: 0, minWidth: 0 }}
          disabled={overlayRunId !== null}
        >
          <button className="btn" onClick={createWorkflow}>
            + New
          </button>
          <button
            className="btn"
            title="Ready-made sample workflows to explore and adapt"
            onClick={() => {
              setShowSamples(true);
            }}
          >
            Samples…
          </button>
          {active !== null && overlayRunId === null && (
            <>
              <span
                role="status"
                aria-live="polite"
                className={`workflow-save-status${activeSaveState?.status === 'error' ? ' save-error' : ''}`}
                title={
                  activeSaveState?.error ?? 'Workflow and graph edits save automatically.'
                }
              >
                {activeSaveState?.status === 'saving'
                  ? 'Saving…'
                  : activeSaveState?.status === 'error'
                    ? `Save failed: ${activeSaveState.error ?? 'Please retry.'}`
                    : 'Saved'}
              </span>
              {activeSaveState?.status === 'error' && (
                <button
                  className="btn"
                  onClick={() => {
                    void retryWorkflowSave(active.id).catch((err: unknown) => {
                      setRunMessage(errorMessage(err));
                    });
                  }}
                >
                  Retry save
                </button>
              )}
            </>
          )}
          <button
            className="btn"
            title="Draft a workflow from a goal using your own local AI CLI"
            onClick={() => {
              setAssistanceBase(null);
              setPreview(null);
              setShowGenerator(true);
            }}
          >
            ✦ Generate
          </button>
          <button
            className="btn"
            disabled={active === null}
            title="Arrange or improve this workflow using a configured local CLI; review before applying"
            onClick={() => {
              if (active === null) return;
              setAssistanceBase(structuredClone(active.definition));
              setAssistanceMode('optimize');
              setGenRepoDir(assistanceRepoDir(active.definition));
              setGenBranch(active.definition.defaults?.branch ?? '');
              setGoal('');
              setPreview(null);
              setGenError(null);
              setLastGenError(null);
              setShowAdvancedProfile(true);
              setAdvancedProfileId('');
              setShowGenerator(true);
            }}
          >
            ✦ Assist
          </button>
          <button className="btn" onClick={openSaveAsTemplate} disabled={active === null}>
            Save as template
          </button>
          <button
            className="btn btn-ghost"
            onClick={openJsonEditor}
            disabled={active === null}
            title="View and edit this workflow as raw JSON"
          >
            JSON
          </button>
          <button
            className="btn btn-primary"
            onClick={runActive}
            disabled={active === null || starting}
          >
            {starting ? 'Starting…' : '▶ Run'}
          </button>
          <button
            className="btn btn-ghost"
            onClick={deleteActive}
            disabled={active === null}
            title="Delete this workflow (asks first)"
          >
            Delete
          </button>
        </fieldset>
      </div>
      {runMessage !== null && (
        <div style={{ padding: '12px 20px 0' }}>
          <Notice
            variant="warn"
            role="alert"
            onDismiss={() => {
              setRunMessage(null);
            }}
          >
            <span>{runMessage}</span>
          </Notice>
        </div>
      )}
      {showInputs && (active.definition.inputs ?? []).length > 0 && (
        <div style={{ padding: '12px 20px 0' }}>
          <div className="notice" role="form" aria-label="Workflow inputs">
            <strong>Run inputs:</strong>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                gap: 10,
                marginTop: 8,
              }}
            >
              {(active.definition.inputs ?? []).map((input) => {
                const value = inputValues[input.name] ?? input.default ?? '';
                const expanded = expandedInputs[input.name] === true || value.length > 80;
                return (
                  <div key={input.name} className="field" style={{ marginBottom: 0 }}>
                    <label className="field-label" htmlFor={`run-input-${input.name}`}>
                      {input.label ?? input.name}
                      {input.required === true ? ' *' : ''}
                    </label>
                    {expanded ? (
                      <textarea
                        id={`run-input-${input.name}`}
                        className="textarea"
                        rows={4}
                        value={value}
                        placeholder={input.default ?? ''}
                        onChange={(e) => {
                          const value = e.target.value;
                          setInputState((state) => ({
                            ...state,
                            values: { ...state.values, [input.name]: value },
                          }));
                        }}
                      />
                    ) : (
                      <input
                        id={`run-input-${input.name}`}
                        className="input"
                        value={value}
                        placeholder={input.default ?? ''}
                        onChange={(e) => {
                          const value = e.target.value;
                          setInputState((state) => ({
                            ...state,
                            values: { ...state.values, [input.name]: value },
                          }));
                        }}
                      />
                    )}
                    <button
                      className="btn btn-ghost"
                      style={{
                        alignSelf: 'flex-start',
                        padding: '2px 8px',
                        fontSize: 12,
                      }}
                      aria-expanded={expanded}
                      title={
                        expanded ? 'Collapse to a single line' : 'Expand for long text'
                      }
                      onClick={() => {
                        setInputState((state) => ({
                          ...state,
                          expanded: { ...state.expanded, [input.name]: !expanded },
                        }));
                      }}
                    >
                      {expanded ? 'Collapse ▲' : 'Expand ▼'}
                    </button>
                  </div>
                );
              })}
            </div>
            <button
              className="btn btn-primary"
              style={{ marginLeft: 8 }}
              onClick={() => {
                setInputState((state) => ({ ...state, shown: false }));
                runActive();
              }}
            >
              ▶ Run with inputs
            </button>{' '}
            <button
              className="btn btn-ghost"
              onClick={() => {
                setInputState((state) => ({ ...state, shown: false }));
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {overlayRunId !== null && (
        <div style={{ padding: '12px 20px 0' }}>
          <Notice>
            Read-only snapshot of run {overlayRunId} on canvas ({overlayResults.length}{' '}
            results).{' '}
            <button
              className="btn btn-ghost"
              onClick={() => {
                void showRunOverlay(null);
              }}
            >
              Edit saved workflow
            </button>
          </Notice>
        </div>
      )}
      {showGenerator && (
        <Modal
          label={assistanceBase === null ? 'Generate workflow' : 'Assist workflow'}
          onClose={closeGenerator}
          closeLabel="Close generator"
          closeDisabled={generating || acceptingPreview}
          onBackdrop={closeGenerator}
          maxWidth={780}
        >
          <div>
            <h3 style={{ marginTop: 0, paddingRight: 40 }}>
              {assistanceBase === null
                ? 'Generate workflow'
                : `Assist: ${assistanceBase.name}`}
            </h3>
            {assistanceBase !== null && (
              <div className="field">
                <label className="field-label" htmlFor="assistance-mode">
                  Assistance task
                </label>
                <select
                  id="assistance-mode"
                  className="input"
                  value={assistanceMode}
                  disabled={generating || acceptingPreview}
                  onChange={(e) => {
                    setAssistanceMode(e.target.value as AssistanceMode);
                    setPreview(null);
                  }}
                >
                  <option value="optimize">Optimize workflow</option>
                  <option value="arrange">Arrange layout only</option>
                </select>
                <span className="field-hint">
                  Uses the saved workflow, repository instructions, accepted project
                  playbook and latest run from the same repository. Review the proposal
                  before applying.
                </span>
              </div>
            )}
            <div className="generator-panel" role="form" aria-label="Generate workflow">
              <div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <strong>
                    <label htmlFor="gen-goal">
                      {assistanceBase === null
                        ? 'Describe what you want to do'
                        : 'Developer instructions (optional)'}
                    </label>
                  </strong>
                  <span
                    className="field-hint"
                    aria-live="polite"
                    title="Long goals are fine — the limit covers your text plus the inputs/repair context appended below"
                  >
                    {String(goal.length)} / {String(MAX_GOAL_CHARS)}
                  </span>
                </div>
                <div className="field-hint">
                  Pick an AI — Orchevia drafts with it (creating a profile if you don’t
                  have one) and shows a preview. Never auto-runs, and Orchevia itself has
                  no built-in AI.
                </div>
              </div>
              <textarea
                id="gen-goal"
                className="textarea generator-input"
                rows={4}
                placeholder="Implement DEV-6012 with Claude, review with Codex, draft PR… (be specific: branches, commands, acceptance criteria)"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
              <details className="gen-context" open>
                <summary>
                  Repository context (optional) — the AI inspects it before drafting
                </summary>
                <fieldset
                  disabled={assistanceBase !== null || generating || acceptingPreview}
                  style={{ border: 0, padding: 0, margin: 0 }}
                >
                  <DirPicker
                    id="gen-repo-dir"
                    label="Repository directory"
                    value={genRepoDir}
                    placeholder={knownFolders[0] ?? '/path/to/repo'}
                    onChange={setGenRepoDir}
                  />
                </fieldset>
                <details>
                  <summary className="field-hint">Included project memory</summary>
                  {memoryLoading || memoryDirectory !== genRepoDir.trim() ? (
                    <p className="field-hint">Loading project memory…</p>
                  ) : memoryError ? (
                    <Notice variant="warn">{memoryError}</Notice>
                  ) : (
                    <pre className="log-block" style={{ maxHeight: 220 }}>
                      {memoryContext?.text ||
                        'No applicable accepted memory. Explicit goal instructions take precedence.'}
                    </pre>
                  )}
                </details>
                <div className="field" style={{ marginBottom: 0 }}>
                  <fieldset
                    disabled={assistanceBase !== null || generating || acceptingPreview}
                    style={{ border: 0, padding: 0, margin: 0 }}
                  >
                    <BranchPicker
                      id="gen-branch"
                      label="Branch (optional)"
                      repoDir={genRepoDir}
                      value={genBranch}
                      placeholder="feature/my-work (optional)"
                      onChange={setGenBranch}
                      action={
                        <button
                          className="btn btn-ghost"
                          style={{ padding: '2px 8px', fontSize: 12 }}
                          disabled={detectingGenBranch || genRepoDir.trim() === ''}
                          title="Fill in the current branch of the repository above"
                          onClick={() => {
                            const dir = genRepoDir.trim();
                            if (dir === '') {
                              setGenRepoMsg('Set the repository directory first.');
                              return;
                            }
                            setDetectingGenBranch(true);
                            setGenRepoMsg(null);
                            void getBackend()
                              .gitCurrentBranch(dir)
                              .then((branch) => {
                                setGenBranch(branch);
                              })
                              .catch((err: unknown) => {
                                setGenRepoMsg(errorMessage(err));
                              })
                              .finally(() => {
                                setDetectingGenBranch(false);
                              });
                          }}
                        >
                          {detectingGenBranch ? 'Detecting…' : 'Detect current'}
                        </button>
                      }
                    />
                  </fieldset>
                  <span className="field-hint">
                    Grounded drafts: the AI reads this repo (never writes), wires node
                    working directories, and the accepted workflow keeps these as its
                    defaults.
                  </span>
                  {genRepoMsg !== null && (
                    <span className="field-hint" style={{ marginTop: 4 }}>
                      {genRepoMsg}
                    </span>
                  )}
                </div>
              </details>
              <div>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setShowGoalInputs((v) => !v);
                  }}
                  aria-expanded={showGoalInputs}
                  title="Name the {{input.*}} variables up front so the AI references real ones"
                  disabled={assistanceBase !== null}
                >
                  {showGoalInputs
                    ? 'Hide inputs'
                    : declaredInputs.length > 0
                      ? `Inputs… (${String(declaredInputs.length)} declared)`
                      : 'Inputs… (optional)'}
                </button>
              </div>
              {showGoalInputs && assistanceBase === null && (
                <div className="field" style={{ marginTop: 8, maxWidth: 640 }}>
                  <label className="field-label" htmlFor="gen-inputs">
                    Workflow inputs (one per line: NAME or NAME=default)
                  </label>
                  <textarea
                    id="gen-inputs"
                    className="textarea"
                    rows={3}
                    value={goalInputs}
                    onChange={(e) => {
                      setGoalInputs(e.target.value);
                    }}
                    placeholder={'KEY\nTASK\nbranch=feature/my-work'}
                  />
                  <span className="field-hint">
                    Declared here, referenced by the AI as {'{{input.NAME}}'}, and merged
                    into the workflow on Accept — even if the AI forgets to declare them.
                  </span>
                  {inputProblems.length > 0 && (
                    <Notice variant="error" style={{ marginTop: 8 }}>
                      {inputProblems[0]}
                    </Notice>
                  )}
                </div>
              )}
              {genError !== null && (
                <Notice
                  variant="error"
                  style={{ marginTop: 8 }}
                  onDismiss={() => {
                    setGenError(null);
                  }}
                  dismissLabel="Dismiss generation error"
                >
                  <span>{genError}</span>
                </Notice>
              )}
              <div className="generator-row">
                <select
                  className="input generator-profile"
                  aria-label="AI for generation"
                  value={generatorAdapter}
                  onChange={(e) => {
                    setGeneratorAdapter(e.target.value as AdapterKind);
                  }}
                >
                  <option value="claude">Claude Code</option>
                  <option value="codex">Codex</option>
                </select>
                <button
                  className="btn btn-primary btn-generate"
                  disabled={generating || acceptingPreview}
                  onClick={() => generateFromGoal()}
                >
                  {generating
                    ? `Generating… ${String(genElapsed)}s`
                    : assistanceBase === null
                      ? '✦ Generate'
                      : assistanceMode === 'arrange'
                        ? 'Preview arrangement'
                        : 'Preview improvements'}
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setShowAdvancedProfile((v) => !v);
                  }}
                  title="Optional: force one exact profile instead of auto-pick"
                >
                  {showAdvancedProfile ? 'Hide profile picker' : 'Pick exact profile…'}
                </button>
              </div>
              {generating && (
                <div className="generation-progress" role="status" aria-live="polite">
                  <span className="generation-spinner" aria-hidden="true" />
                  <div>
                    <strong>Drafting your workflow · {String(genElapsed)}s</strong>
                    <p>
                      {genElapsed < 30
                        ? 'Your local AI is reading the request and available tools.'
                        : genElapsed < 90
                          ? 'Complex workflows can take a few minutes. The CLI is still working.'
                          : 'Still waiting for the local CLI. You can keep this window open; the preview will appear here.'}
                    </p>
                    <small>
                      Generation never starts a run. You review every step first.
                    </small>
                  </div>
                </div>
              )}
              {showAdvancedProfile && (
                <div className="generator-row">
                  <select
                    className="input generator-profile"
                    aria-label="Exact generator profile (optional override)"
                    value={advancedProfileId}
                    onChange={(e) => {
                      setAdvancedProfileId(e.target.value);
                    }}
                  >
                    <option value="">— Auto (recommended) —</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.adapter})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {(lastGenError !== null ||
                (preview !== null && preview.blocking.length > 0)) && (
                <div className="generator-row" style={{ alignItems: 'flex-end' }}>
                  <div
                    className="field"
                    style={{ marginBottom: 0, flex: 1, minWidth: 220 }}
                  >
                    <label className="field-label" htmlFor="gen-repair-hint">
                      Repair hint (sent with the blocking items)
                    </label>
                    <input
                      id="gen-repair-hint"
                      className="input generator-profile"
                      placeholder="e.g. use agent nodes instead of shell commands…"
                      value={repairHint}
                      onChange={(e) => {
                        setRepairHint(e.target.value);
                      }}
                    />
                  </div>
                  <button
                    className="btn"
                    disabled={generating || acceptingPreview}
                    title="Send the failure + your hint back to the AI for another attempt (max 3 rounds)"
                    onClick={startRepair}
                  >
                    {repairRound > 0
                      ? `Ask AI to fix (round ${String(repairRound + 1)}/3)`
                      : 'Ask AI to fix it'}
                  </button>
                </div>
              )}
            </div>
            {preview !== null && (
              <Notice variant="warn" className="preview-scroll" style={{ marginTop: 12 }}>
                <strong>Proposed: {preview.proposalName}</strong>
                {assistanceBase !== null && (
                  <details className="preview-details" open>
                    <summary>Review changes to the current workflow</summary>
                    <pre className="log-block" style={{ maxHeight: 260 }}>
                      {assistanceChanges(assistanceBase, preview.workflow)}
                    </pre>
                  </details>
                )}
                <p className="preview-summary">
                  {summarizeGenerationExplanation(preview.explanation) ||
                    'Review the proposed steps and required setup before accepting.'}
                </p>
                {preview.explanation.length > 220 && (
                  <details className="preview-details">
                    <summary>Read full generator explanation</summary>
                    <p>{preview.explanation}</p>
                  </details>
                )}
                <div className="tool-version">
                  {preview.workflow.nodes.length} steps · {preview.riskLabels.length} risk
                  {preview.riskLabels.length === 1 ? '' : 's'} ·{' '}
                  {preview.riskyNodes.length} steps can execute tools
                </div>
                {preview.riskLabels.length > 0 && (
                  <details className="preview-details">
                    <summary>Review risks and executable steps</summary>
                    <p>{preview.riskLabels.join(' · ')}</p>
                    <p>{preview.riskyNodes.join(' · ')}</p>
                  </details>
                )}
                {preview.blocking.length > 0 && (
                  <Notice
                    variant="error"
                    className="blocked-scroll"
                    style={{ marginTop: 8 }}
                  >
                    <strong>
                      ⚠ Blocked ({preview.blocking.length}) — resolve or ask the AI to
                      fix:
                    </strong>
                    <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                      {preview.blocking.map((b, i) => (
                        <li key={`${String(i)}-${b.slice(0, 24)}`}>{b}</li>
                      ))}
                    </ol>
                  </Notice>
                )}
                {preview.setupNeeded.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <strong className="field-hint">
                      Before running, complete setup ({preview.setupNeeded.length}):
                    </strong>
                    <ul className="preview-checklist">
                      {preview.setupNeeded.map((s, i) => (
                        <li key={`${String(i)}-${s.slice(0, 24)}`}>{s}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {preview.repairs.length > 0 && (
                  <details style={{ marginTop: 8 }}>
                    <summary className="field-hint" style={{ cursor: 'pointer' }}>
                      Compiler notes and auto-fixes ({preview.repairs.length})
                    </summary>
                    <ul className="preview-checklist">
                      {preview.repairs.map((r, i) => (
                        <li key={`${String(i)}-${r.slice(0, 24)}`}>{r}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {preview.unavailable.length > 0 && (
                  <div className="tool-version" style={{ marginTop: 8 }}>
                    Missing: {preview.unavailable.join('; ')}
                  </div>
                )}
                <details style={{ marginTop: 8 }}>
                  <summary className="field-hint" style={{ cursor: 'pointer' }}>
                    Proposed steps ({preview.workflow.nodes.length})
                  </summary>
                  <ol className="preview-steps">
                    {preview.workflow.nodes.map((n) => {
                      const detail = describeGeneratedStep(n, profiles);
                      return (
                        <li key={n.id}>
                          <span className="status-pill status-paused">{n.type}</span>{' '}
                          {n.label ?? n.id}
                          {detail !== '' && (
                            <span className="preview-step-detail" title={detail}>
                              {detail}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                </details>
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  {(() => {
                    const roleMsgs = new Set(
                      preview.unmappedRoles.map(roleMappingMessage),
                    );
                    const hard = preview.blocking.filter((b) => !roleMsgs.has(b));
                    const autoCreatable = preview.unmappedRoles.length;
                    return (
                      <button
                        className="btn btn-primary"
                        disabled={hard.length > 0 || acceptingPreview}
                        title={
                          hard.length > 0
                            ? 'Resolve the blocking items above (or ask the AI to fix them)'
                            : autoCreatable > 0
                              ? 'Missing role profiles are created automatically, then the workflow opens on the canvas'
                              : 'Open the workflow on the canvas for editing'
                        }
                        onClick={acceptPreview}
                      >
                        {acceptingPreview
                          ? 'Applying…'
                          : hard.length > 0
                            ? 'Accept & edit'
                            : autoCreatable > 0
                              ? `Create ${String(autoCreatable)} profile${autoCreatable === 1 ? '' : 's'} & accept`
                              : assistanceBase === null
                                ? 'Accept & edit'
                                : 'Apply reviewed changes'}
                      </button>
                    );
                  })()}
                  {preview.blocking.length > 0 && (
                    <button
                      className="btn"
                      disabled={generating || acceptingPreview}
                      title="Send the blocking items + your hint back to the AI (max 3 rounds)"
                      onClick={startRepair}
                    >
                      Ask AI to fix
                      {repairRound > 0 ? ` (round ${String(repairRound + 1)}/3)` : ''}
                    </button>
                  )}
                  <button
                    className="btn"
                    disabled={acceptingPreview}
                    onClick={() => generateFromGoal()}
                  >
                    Retry
                  </button>
                  <button
                    className="btn btn-ghost"
                    disabled={acceptingPreview}
                    onClick={discardPreview}
                  >
                    Discard
                  </button>
                </div>
                <span className="field-hint">
                  Never auto-runs. Review every proposed step before applying it to the
                  canvas.
                </span>
              </Notice>
            )}
          </div>
        </Modal>
      )}
      {showSamples && (
        <Modal
          label="Sample workflows"
          onClose={() => {
            setShowSamples(false);
          }}
          closeLabel="Close samples"
          onBackdrop={() => {
            setShowSamples(false);
          }}
        >
          <div>
            <h3 style={{ marginTop: 0 }}>Sample workflows</h3>
            <p className="field-hint">
              Starting points that use your Agent Profiles — created as editable copies,
              never run automatically. For full flows (ticket → draft PR), see Templates.
            </p>
            {(
              [
                {
                  name: 'Plan → Implement → Review',
                  detail:
                    'Claude plans, you approve the plan, Claude implements, Codex reviews.',
                  make: createDemoWorkflow,
                },
                {
                  name: 'Review loop (max 2 cycles)',
                  detail:
                    'Parallel Claude + Codex reviews with a condition-guarded fix cycle.',
                  make: createLoopDemoWorkflow,
                },
                {
                  name: 'Review pull request',
                  detail:
                    'Load a PR, review in parallel, post a draft note when actionable.',
                  make: createReviewDemoWorkflow,
                },
              ] as const
            ).map((sample) => (
              <div key={sample.name} className="tool-card" style={{ marginBottom: 8 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <strong>{sample.name}</strong>
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      setShowSamples(false);
                      sample.make();
                    }}
                  >
                    Create
                  </button>
                </div>
                <p className="field-hint" style={{ marginBottom: 0 }}>
                  {sample.detail}
                </p>
              </div>
            ))}
            <div className="tool-card" style={{ marginTop: 4, marginBottom: 8 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <strong>Commit + PR quick flow</strong>
                <button className="btn btn-primary" onClick={createCommitPrDemoWorkflow}>
                  Create
                </button>
              </div>
              <p className="field-hint" style={{ marginBottom: 8 }}>
                Start → status → commit (asks commitMessage) → draft PR (asks prTitle) →
                End. Press Run, fill the two inputs, and walk away.
              </p>
              {commitPrError !== null && (
                <Notice variant="error" style={{ marginBottom: 8 }}>
                  {commitPrError}
                </Notice>
              )}
              <DirPicker
                id="samples-commitpr-dir"
                label="Repository directory"
                value={commitPrDir}
                placeholder={knownFolders[0] ?? '/path/to/repo'}
                onChange={setCommitPrDir}
              />
              <BranchPicker
                id="samples-commitpr-branch"
                label="Current branch (used as PR head)"
                repoDir={commitPrDir}
                value={commitPrBranch}
                placeholder="feature/my-work"
                onChange={setCommitPrBranch}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button
                className="btn"
                onClick={() => {
                  setShowSamples(false);
                }}
              >
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}
      <div className="view workflows-layout" style={{ padding: 0 }}>
        <div className="wf-list" aria-label="Workflow list">
          {workflows.length === 0 && (
            <p className="field-hint">No workflows yet — create one to begin.</p>
          )}
          {workflows.map((w) => (
            <button
              key={w.id}
              className={`wf-card${w.id === active?.id ? ' selected' : ''}`}
              onClick={() => {
                selectWorkflow(w.id);
              }}
            >
              <div className="wf-card-name">{w.name}</div>
              <div className="wf-card-meta">
                {w.definition.nodes.length} nodes · {w.definition.edges.length} edges
              </div>
            </button>
          ))}
        </div>
        {overlayWorkflow !== null ? (
          <WorkflowCanvas key={overlayRunId} workflow={overlayWorkflow} readOnly />
        ) : active !== null ? (
          <WorkflowCanvas key={active.id} workflow={active.definition} />
        ) : (
          <div className="canvas-wrap">
            <div className="empty-state">
              <h2>No workflow selected</h2>
              <p>Create a workflow or pick one from the list.</p>
            </div>
          </div>
        )}
        {overlayWorkflow !== null ? (
          <aside className="inspector">
            <h2>Run node</h2>
            <p className="field-hint">
              Saved configuration and output; this view is read-only.
            </p>
            {selectedNodeId === null ? (
              <p>Select a node to inspect its result.</p>
            ) : (
              <>
                <h3>
                  {overlayWorkflow.nodes.find((n) => n.id === selectedNodeId)?.label ??
                    selectedNodeId}
                </h3>
                <details>
                  <summary>Configuration</summary>
                  <pre className="log-block" style={{ maxHeight: 240, overflow: 'auto' }}>
                    {JSON.stringify(
                      overlayWorkflow.nodes.find((n) => n.id === selectedNodeId)?.config,
                      null,
                      2,
                    )}
                  </pre>
                </details>
                {overlayResults
                  .filter((r) => r.nodeId === selectedNodeId)
                  .map((r) => (
                    <details key={r.id} open>
                      <summary>{r.status}</summary>
                      <pre
                        className="log-block"
                        style={{ maxHeight: 300, overflow: 'auto' }}
                      >
                        {r.stdout}
                        {r.stderr}
                        {r.error}
                      </pre>
                    </details>
                  ))}
              </>
            )}
          </aside>
        ) : (
          <NodeInspector />
        )}
      </div>
      {jsonModal && active !== null && (
        <Modal
          label="Edit workflow as JSON"
          onClose={() => {
            setJsonModal(false);
          }}
          closeLabel="Close JSON editor"
          onBackdrop={() => {
            setJsonModal(false);
          }}
          maxWidth={760}
        >
          <div>
            <h3 style={{ marginTop: 0 }}>Edit “{active.name}” as JSON</h3>
            <p className="field-hint">
              {jsonMode === 'simple'
                ? 'Simple document: readable keys, configuration and connections.'
                : 'Advanced runtime definition, including IDs and positions.'}{' '}
              Shape-checked on save; semantic validation runs too — errors ask before
              saving.
            </p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button
                className="btn"
                disabled={jsonBusy || jsonMode === 'simple'}
                onClick={() => switchJsonMode('simple')}
              >
                Simple JSON
              </button>
              <button
                className="btn"
                disabled={jsonBusy || jsonMode === 'raw'}
                onClick={() => switchJsonMode('raw')}
              >
                Advanced JSON
              </button>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="wf-json">
                Workflow JSON
              </label>
              <textarea
                id="wf-json"
                className="textarea"
                rows={18}
                value={jsonText}
                onChange={(e) => {
                  setJsonText(e.target.value);
                  setJsonError(null);
                }}
                spellCheck={false}
              />
            </div>
            {jsonError !== null && (
              <Notice variant="error" style={{ marginBottom: 12 }}>
                {jsonError}
              </Notice>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-primary"
                disabled={jsonBusy}
                onClick={saveJsonEditor}
              >
                Save JSON
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setJsonModal(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}
      {templateModal && active !== null && (
        <Modal
          label="Save workflow as template"
          onClose={() => {
            setTemplateModal(false);
          }}
          closeLabel="Close save as template"
          onBackdrop={() => {
            setTemplateModal(false);
          }}
          maxWidth={480}
        >
          <div>
            <h3 style={{ marginTop: 0 }}>Save “{active.name}” as template</h3>
            <p className="field-hint">
              Concrete profile references become portable role references where possible.
              Lands in Templates → Mine.
            </p>
            <div className="field">
              <label className="field-label" htmlFor="tpl-name">
                Template name
              </label>
              <input
                id="tpl-name"
                className="input"
                value={templateName}
                onChange={(e) => {
                  setTemplateName(e.target.value);
                }}
                placeholder={`${active.name} (template)`}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="tpl-category">
                Category
              </label>
              <input
                id="tpl-category"
                className="input"
                value={templateCategory}
                onChange={(e) => {
                  setTemplateCategory(e.target.value);
                }}
                placeholder="general"
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-primary"
                disabled={templateName.trim() === ''}
                onClick={saveAsTemplate}
              >
                Save template
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setTemplateModal(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}
      {validation.length > 0 && active !== null && !validationHidden && (
        <div className="validation-bar" aria-live="polite">
          <div
            style={{ display: 'flex', justifyContent: 'flex-end', pointerEvents: 'auto' }}
          >
            <CloseButton
              variant="ghost"
              label="Dismiss validation messages"
              title="Dismiss (reappears when validation changes)"
              onClose={() => {
                setDismissedValidation(validationIdentity);
              }}
            >
              Dismiss ✕
            </CloseButton>
          </div>
          {validation.slice(0, 4).map((issue) => (
            <div
              key={issue.code + (issue.nodeId ?? '')}
              className={`validation-item ${issue.severity}`}
            >
              <strong>{issue.severity === 'error' ? 'Error' : 'Warning'}:</strong>{' '}
              {issue.message}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
