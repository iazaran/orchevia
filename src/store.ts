import type { ReactNode } from 'react';
import { newId } from './lib/workflow';
import { commandEdits } from './lib/memory';
import { create } from 'zustand';
import { getBackend } from './lib/backend';
import type { AdapterInfo, AgentProfile } from './lib/agents';
import type { GitHubState, McpServerConfig } from './lib/integrations';
import type { Preference, StoredGeneration, WorkflowTemplate } from './lib/generation';
import type { Notification, NotificationPrefs, Schedule, Watcher } from './lib/scheduler';
import type {
  RunStatus,
  StoredNodeResult,
  StoredRun,
  StoredWorkflow,
  ToolStatus,
  ValidationIssue,
  Workflow,
} from './lib/workflow';
import { errorMessage } from './lib/errors';

export interface UiNotice {
  id: string;
  content: ReactNode;
  variant?: 'info' | 'warn' | 'error';
  role?: 'status' | 'alert' | 'form';
  dismissLabel?: string;
  onDismiss?: () => void;
  group?: string;
}

export type View =
  | 'workflows'
  | 'runs'
  | 'inbox'
  | 'environment'
  | 'agents'
  | 'automations'
  | 'templates'
  | 'memory'
  | 'usage';

export interface WorkflowSaveState {
  status: 'saving' | 'saved' | 'error';
  error: string | null;
}

interface AppState {
  view: View;
  workflows: StoredWorkflow[];
  activeWorkflowId: string | null;
  selectedNodeId: string | null;
  validation: ValidationIssue[];
  workflowSaveStates: Record<string, WorkflowSaveState>;
  runs: StoredRun[];
  activeRunId: string | null;
  runResults: Record<string, StoredNodeResult[]>;
  /** Run status seen when each cached result list was requested. A terminal
   * status that still matches the run means the cached results are final. */
  runResultStatus: Record<string, RunStatus>;
  tools: ToolStatus[];
  adapters: AdapterInfo[];
  profiles: AgentProfile[];
  knownFolders: string[];
  mcpServers: McpServerConfig[];
  githubState: GitHubState | null;
  schedules: Schedule[];
  watchers: Watcher[];
  notifications: Notification[];
  notificationSnapshotLoaded: boolean;
  seenNotificationIds: number[];
  notificationPrefs: NotificationPrefs | null;
  backgroundMode: boolean;
  builtinTemplates: WorkflowTemplate[];
  userTemplates: WorkflowTemplate[];
  preferences: Preference[];
  generations: StoredGeneration[];
  selectedEdgeId: string | null;
  overlayRunId: string | null;
  overlayWorkflow: Workflow | null;
  overlayResults: StoredNodeResult[];
  loading: boolean;
  error: string | null;
  uiNotices: UiNotice[];
  pushUiNotice: (notice: Omit<UiNotice, 'id'>) => void;
  removeUiNotice: (id: string) => void;

  setView: (view: View) => void;
  refreshAll: () => Promise<void>;
  refreshWorkflows: () => Promise<void>;
  refreshRuns: () => Promise<void>;
  refreshTools: () => Promise<void>;
  refreshProfiles: () => Promise<void>;
  refreshIntegrations: () => Promise<void>;
  refreshAutomations: () => Promise<void>;
  refreshNotifications: () => Promise<void>;
  refreshLibrary: () => Promise<void>;
  selectWorkflow: (id: string | null) => void;
  selectNode: (id: string | null) => void;
  selectEdge: (id: string | null) => void;
  openRunOnCanvas: (runId: string) => Promise<boolean>;
  refreshRunOverlay: () => Promise<void>;
  showRunOverlay: (runId: string | null) => Promise<void>;
  updateActiveWorkflow: (workflow: Workflow) => void;
  saveActiveWorkflow: (definition?: Workflow) => Promise<StoredWorkflow | undefined>;
  deleteWorkflow: (id: string) => Promise<boolean>;
  retryWorkflowSave: (id: string) => Promise<StoredWorkflow | undefined>;
  setValidation: (issues: ValidationIssue[]) => void;
  selectRun: (id: string | null) => Promise<void>;
  setError: (message: string | null) => void;
}

let navigationSequence = 0;
let runsRefreshSequence = 0;
let workflowRefreshSequence = 0;
let runSelectionSequence = 0;
let notificationRefreshSequence = 0;
const workflowSaves = new Map<
  string,
  { promise: Promise<StoredWorkflow>; token: symbol; definition: Workflow }
>();
const workflowSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const deletingWorkflows = new Set<string>();
export const useAppStore = create<AppState>()((set, get) => ({
  view: 'workflows',
  workflows: [],
  activeWorkflowId: null,
  selectedNodeId: null,
  validation: [],
  workflowSaveStates: {},
  runs: [],
  activeRunId: null,
  runResults: {},
  runResultStatus: {},
  tools: [],
  adapters: [],
  profiles: [],
  knownFolders: [],
  mcpServers: [],
  githubState: null,
  schedules: [],
  watchers: [],
  notifications: [],
  notificationSnapshotLoaded: false,
  seenNotificationIds: [],
  notificationPrefs: null,
  backgroundMode: false,
  builtinTemplates: [],
  userTemplates: [],
  preferences: [],
  generations: [],
  selectedEdgeId: null,
  overlayRunId: null,
  overlayWorkflow: null,
  overlayResults: [],
  loading: false,
  error: null,
  uiNotices: [],
  pushUiNotice: (notice) => {
    set((current) => ({
      uiNotices: [
        ...current.uiNotices.filter((n) => !notice.group || n.group !== notice.group),
        { ...notice, id: newId('notice') },
      ],
    }));
  },
  removeUiNotice: (id) => {
    set((current) => ({ uiNotices: current.uiNotices.filter((n) => n.id !== id) }));
  },

  setView: (view) => {
    navigationSequence++;
    set({ view });
  },

  refreshAll: async () => {
    set({ loading: true, error: null });
    try {
      await Promise.all([
        get().refreshWorkflows(),
        get().refreshRuns(),
        get().refreshTools(),
        get().refreshProfiles(),
        get().refreshIntegrations(),
        get().refreshAutomations(),
        get().refreshNotifications(),
        get().refreshLibrary(),
      ]);
    } catch (err) {
      set({ error: errorMessage(err) });
    } finally {
      set({ loading: false });
    }
  },

  refreshWorkflows: async () => {
    const request = ++workflowRefreshSequence;
    const backend = getBackend();
    const before = new Map(get().workflows.map((w) => [w.id, w.definition]));
    const listed = await backend.listWorkflows();
    if (request !== workflowRefreshSequence) return;
    const current = get();
    const workflows = listed.map((stored) => {
      const draft = current.workflows.find((w) => w.id === stored.id);
      const status = current.workflowSaveStates[stored.id]?.status;
      return draft &&
        (status === 'saving' ||
          status === 'error' ||
          (before.has(stored.id) && before.get(stored.id) !== draft.definition))
        ? draft
        : stored;
    });
    // Failed/new local drafts remain available even when absent from a backend list.
    for (const draft of current.workflows) {
      const status = current.workflowSaveStates[draft.id]?.status;
      if (
        (status === 'saving' || status === 'error') &&
        !workflows.some((w) => w.id === draft.id)
      )
        workflows.push(draft);
    }
    const { activeWorkflowId } = current;
    const stillExists = workflows.some((w) => w.id === activeWorkflowId);
    set({
      workflows,
      activeWorkflowId: stillExists ? activeWorkflowId : (workflows[0]?.id ?? null),
    });
  },

  refreshRuns: async () => {
    const backend = getBackend();
    const request = ++runsRefreshSequence;
    const runs = await backend.listRuns(100);
    if (request === runsRefreshSequence) set({ runs });
  },

  refreshTools: async () => {
    const backend = getBackend();
    const tools = await backend.detectTools();
    set({ tools });
  },

  refreshProfiles: async () => {
    const backend = getBackend();
    try {
      const [profiles, adapters, knownFolders] = await Promise.all([
        backend.listAgentProfiles(),
        backend.listAdapters(),
        backend.listKnownFolders(20).catch(() => [] as string[]),
      ]);
      set({ profiles, adapters, knownFolders });
    } catch {
      // Browser mock before profiles exist, or Tauri command missing in
      // older builds: profiles simply stay empty.
    }
  },

  refreshIntegrations: async () => {
    const backend = getBackend();
    try {
      const [mcpServers, githubState] = await Promise.all([
        backend.listMcpServers(),
        backend.githubState(),
      ]);
      set({ mcpServers, githubState });
    } catch {
      // Mock or older backend: leave previous values.
    }
  },

  refreshAutomations: async () => {
    const backend = getBackend();
    try {
      const [schedules, watchers, prefs, background] = await Promise.all([
        backend.listSchedules().catch(() => [] as Schedule[]),
        backend.listWatchers().catch(() => [] as Watcher[]),
        backend.getNotificationPrefs().catch(() => null),
        backend.getSetting('background.mode').catch(() => null),
      ]);
      set({
        schedules,
        watchers,
        notificationPrefs: prefs,
        backgroundMode: background === '1',
      });
    } catch {
      // Mock backend: stay empty.
    }
  },

  refreshNotifications: async () => {
    const backend = getBackend();
    const request = ++notificationRefreshSequence;
    try {
      const notifications = await backend.listNotifications(100);
      if (request !== notificationRefreshSequence) return;
      const current = get();
      const seen = new Set(current.seenNotificationIds);
      const incoming = notifications.filter((n) => !n.read && !seen.has(n.id));
      for (const notification of notifications) seen.add(notification.id);
      set({
        notifications,
        seenNotificationIds: [...seen],
        notificationSnapshotLoaded: true,
      });
      // The first snapshot belongs to Inbox history; never replay it as popups.
      if (current.notificationSnapshotLoaded) {
        for (const notification of incoming.sort((a, b) => a.id - b.id)) {
          get().pushUiNotice({
            content: `${notification.title}: ${notification.body}`,
            variant:
              notification.kind === 'failure'
                ? 'error'
                : notification.kind === 'success'
                  ? 'info'
                  : 'warn',
          });
        }
      }
    } catch {
      // Mock backend: stay empty.
    }
  },

  refreshLibrary: async () => {
    const backend = getBackend();
    try {
      const [templates, preferences, generations] = await Promise.all([
        backend.listTemplates().catch(() => ({ builtin: [], user: [] })),
        backend.listPreferences().catch(() => [] as Preference[]),
        backend.listGenerations(50).catch(() => [] as StoredGeneration[]),
      ]);
      set({
        builtinTemplates: templates.builtin,
        userTemplates: templates.user,
        preferences,
        generations,
      });
    } catch {
      // Mock backend: stay empty.
    }
  },

  selectWorkflow: (id) => {
    navigationSequence++;
    set({
      overlayRunId: null,
      overlayWorkflow: null,
      overlayResults: [],
      activeWorkflowId: id,
      selectedNodeId: null,
      selectedEdgeId: null,
      validation: [],
    });
  },

  selectNode: (id) => {
    set({ selectedNodeId: id, selectedEdgeId: null });
  },

  selectEdge: (id) => {
    set({ selectedEdgeId: id, selectedNodeId: null });
  },

  openRunOnCanvas: async (runId) => {
    const request = ++navigationSequence;
    const backend = getBackend();
    const [run, workflow, results] = await Promise.all([
      backend.getRun(runId),
      backend.getRunWorkflow(runId),
      backend.getRunResults(runId),
    ]);
    if (run === null || workflow === null)
      throw new Error(`Unknown run '${runId}' or its saved workflow is unavailable.`);
    if (request !== navigationSequence) return false;
    set({
      view: 'workflows',
      activeRunId: runId,
      activeWorkflowId: run.workflowId,
      overlayRunId: runId,
      overlayWorkflow: workflow,
      overlayResults: results,
      selectedNodeId: null,
      selectedEdgeId: null,
      validation: [],
      runs: [run, ...get().runs.filter((r) => r.id !== run.id)],
    });
    return true;
  },
  refreshRunOverlay: async () => {
    const { overlayRunId } = get();
    if (overlayRunId === null) return;
    const results = await getBackend().getRunResults(overlayRunId);
    if (get().overlayRunId === overlayRunId) set({ overlayResults: results });
  },
  showRunOverlay: async (runId) => {
    if (runId === null) {
      navigationSequence++;
      set({ overlayRunId: null, overlayWorkflow: null, overlayResults: [] });
      return;
    }
    await get().openRunOnCanvas(runId);
  },

  updateActiveWorkflow: (workflow) => {
    if (get().overlayRunId !== null) return;
    const { workflows, activeWorkflowId } = get();
    if (
      deletingWorkflows.has(workflow.id) ||
      workflow.id !== activeWorkflowId ||
      !workflows.some((w) => w.id === workflow.id)
    )
      return;
    set({
      workflows: workflows.map((w) =>
        w.id === workflow.id ? { ...w, name: workflow.name, definition: workflow } : w,
      ),
      workflowSaveStates: {
        ...get().workflowSaveStates,
        [workflow.id]: { status: 'saving', error: null },
      },
    });
    clearTimeout(workflowSaveTimers.get(workflow.id));
    workflowSaveTimers.set(
      workflow.id,
      setTimeout(() => {
        workflowSaveTimers.delete(workflow.id);
        void persistWorkflow(workflow.id).catch(() => {});
      }, 350),
    );
  },

  saveActiveWorkflow: async (definition) => {
    const { activeWorkflowId, overlayRunId } = get();
    if (overlayRunId !== null || activeWorkflowId === null) return;
    if (definition !== undefined) {
      if (definition.id !== activeWorkflowId) return;
      get().updateActiveWorkflow(definition);
    }
    return persistWorkflow(activeWorkflowId);
  },

  deleteWorkflow: async (id) => {
    if (deletingWorkflows.has(id)) return false;
    deletingWorkflows.add(id);
    clearTimeout(workflowSaveTimers.get(id));
    workflowSaveTimers.delete(id);
    try {
      // A write already running cannot be cancelled. Wait for the entire queue
      // before deleting, and block fresh writes while the deletion is pending.
      await workflowSaves.get(id)?.promise.catch(() => {});
      const deleted = await getBackend().deleteWorkflow(id);
      if (!deleted)
        throw new Error(
          'Workflow could not be deleted. Check whether it has an active run.',
        );
      workflowRefreshSequence++;
      const current = get();
      const workflows = current.workflows.filter((w) => w.id !== id);
      const workflowSaveStates = Object.fromEntries(
        Object.entries(current.workflowSaveStates).filter(
          ([workflowId]) => workflowId !== id,
        ),
      );
      set({
        workflows,
        workflowSaveStates,
        ...(current.activeWorkflowId === id
          ? {
              activeWorkflowId: workflows[0]?.id ?? null,
              selectedNodeId: null,
              selectedEdgeId: null,
              validation: [],
            }
          : {}),
      });
      return true;
    } catch (err: unknown) {
      set({
        workflowSaveStates: {
          ...get().workflowSaveStates,
          [id]: {
            status: 'error',
            error: 'Deletion failed; draft retained. ' + errorMessage(err),
          },
        },
      });
      throw err;
    } finally {
      deletingWorkflows.delete(id);
    }
  },

  retryWorkflowSave: async (id) => persistWorkflow(id),

  setValidation: (validation) => {
    set({ validation });
  },

  selectRun: async (id) => {
    const request = ++runSelectionSequence;
    set({ activeRunId: id });
    if (id === null) return;
    const backend = getBackend();
    const status = get().runs.find((run) => run.id === id)?.status;
    const results = await backend.getRunResults(id);
    if (request !== runSelectionSequence || get().activeRunId !== id) return;
    const { runResults, runResultStatus } = get();
    // Identical results keep their identity so views and findings do not redo work.
    const cached = runResults[id];
    set({
      runResults:
        cached !== undefined && sameNodeResults(cached, results)
          ? runResults
          : { ...runResults, [id]: results },
      runResultStatus:
        status === undefined ? runResultStatus : { ...runResultStatus, [id]: status },
    });
  },

  setError: (error) => {
    set({ error });
  },
}));

/** Every field of every row matches (output, attempts, usage, timing, recovery). */
export function sameNodeResults(a: StoredNodeResult[], b: StoredNodeResult[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index];
    if (right === undefined) return false;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if (
        !Object.is(
          (left as unknown as Record<string, unknown>)[key],
          (right as unknown as Record<string, unknown>)[key],
        )
      )
        return false;
    }
    return true;
  });
}

export function selectActiveWorkflow(state: AppState): StoredWorkflow | null {
  return state.workflows.find((w) => w.id === state.activeWorkflowId) ?? null;
}

/** All editor mutations share this queue, including saves after changing views. */
async function persistWorkflow(id: string): Promise<StoredWorkflow | undefined> {
  if (deletingWorkflows.has(id)) return;
  clearTimeout(workflowSaveTimers.get(id));
  workflowSaveTimers.delete(id);
  const active = useAppStore.getState().workflows.find((w) => w.id === id);
  if (active === undefined) return;
  const workflow = active.definition;
  const pending = workflowSaves.get(id);
  if (pending?.definition === workflow) return pending.promise;
  const backend = getBackend();
  const navigation = navigationSequence;
  const token = Symbol();
  const status = (state: WorkflowSaveState): void => {
    useAppStore.setState((current) => ({
      workflowSaveStates: { ...current.workflowSaveStates, [id]: state },
    }));
  };
  status({ status: 'saving', error: null });
  const saving: Promise<StoredWorkflow> = (async () => {
    await pending?.promise.catch(() => {});
    const previous = await backend.getWorkflow(id);
    const before = previous ? structuredClone(previous.definition) : null;
    const stored = await backend.saveWorkflow(workflow);
    const validation = await backend.validateWorkflow(workflow).catch((err: unknown) => {
      useAppStore.setState({
        error: 'Workflow saved. Validation failed: ' + errorMessage(err),
      });
      return null;
    });
    const current = useAppStore.getState();
    const unchanged = current.workflows.find((w) => w.id === id)?.definition === workflow;
    if (unchanged && workflowSaves.get(id)?.token === token) {
      useAppStore.setState({
        workflows: current.workflows.map((w) => (w.id === stored.id ? stored : w)),
        ...(validation !== null &&
        navigation === navigationSequence &&
        current.activeWorkflowId === id &&
        current.overlayRunId === null
          ? { validation }
          : {}),
      });
      status({ status: 'saved', error: null });
      current.pushUiNotice({ content: 'Saved', group: `workflow-save:${id}` });
    }
    if (before && stored.definition.defaults?.repoDir?.trim()) {
      try {
        const context = await backend.getProjectMemoryContext(
          stored.definition.defaults.repoDir,
        );
        const observations = commandEdits(before, stored.definition, context.scope);
        if (observations.length) {
          await backend.observeEdits(observations);
          await useAppStore.getState().refreshLibrary();
        }
      } catch (err: unknown) {
        useAppStore.setState({
          error: 'Workflow saved. Memory observation failed: ' + errorMessage(err),
        });
      }
    }
    return stored;
  })();
  workflowSaves.set(id, { promise: saving, token, definition: workflow });
  try {
    return await saving;
  } catch (err: unknown) {
    if (
      workflowSaves.get(id)?.token === token &&
      useAppStore.getState().workflows.find((w) => w.id === id)?.definition === workflow
    ) {
      status({ status: 'error', error: errorMessage(err) });
      useAppStore
        .getState()
        .pushUiNotice({ content: 'Save failed: ' + errorMessage(err), variant: 'error' });
    }
    throw err;
  } finally {
    if (workflowSaves.get(id)?.token === token) workflowSaves.delete(id);
  }
}
