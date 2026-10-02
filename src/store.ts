import { commandEdits } from './lib/memory';
import { create } from 'zustand';
import { getBackend } from './lib/backend';
import type { AdapterInfo, AgentProfile } from './lib/agents';
import type { GitHubState, McpServerConfig } from './lib/integrations';
import type { Preference, StoredGeneration, WorkflowTemplate } from './lib/generation';
import type { Notification, NotificationPrefs, Schedule, Watcher } from './lib/scheduler';
import type {
  StoredNodeResult,
  StoredRun,
  StoredWorkflow,
  ToolStatus,
  ValidationIssue,
  Workflow,
} from './lib/workflow';
import { errorMessage } from './lib/errors';

export type View =
  | 'workflows'
  | 'runs'
  | 'inbox'
  | 'environment'
  | 'agents'
  | 'automations'
  | 'templates'
  | 'memory';

interface AppState {
  view: View;
  workflows: StoredWorkflow[];
  activeWorkflowId: string | null;
  selectedNodeId: string | null;
  validation: ValidationIssue[];
  runs: StoredRun[];
  activeRunId: string | null;
  runResults: Record<string, StoredNodeResult[]>;
  tools: ToolStatus[];
  adapters: AdapterInfo[];
  profiles: AgentProfile[];
  knownFolders: string[];
  mcpServers: McpServerConfig[];
  githubState: GitHubState | null;
  schedules: Schedule[];
  watchers: Watcher[];
  notifications: Notification[];
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
  setValidation: (issues: ValidationIssue[]) => void;
  selectRun: (id: string | null) => Promise<void>;
  setError: (message: string | null) => void;
}

let navigationSequence = 0;
export const useAppStore = create<AppState>()((set, get) => ({
  view: 'workflows',
  workflows: [],
  activeWorkflowId: null,
  selectedNodeId: null,
  validation: [],
  runs: [],
  activeRunId: null,
  runResults: {},
  tools: [],
  adapters: [],
  profiles: [],
  knownFolders: [],
  mcpServers: [],
  githubState: null,
  schedules: [],
  watchers: [],
  notifications: [],
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
    const backend = getBackend();
    const workflows = await backend.listWorkflows();
    const { activeWorkflowId } = get();
    const stillExists = workflows.some((w) => w.id === activeWorkflowId);
    set({
      workflows,
      activeWorkflowId: stillExists ? activeWorkflowId : (workflows[0]?.id ?? null),
    });
  },

  refreshRuns: async () => {
    const backend = getBackend();
    const runs = await backend.listRuns(100);
    set({ runs });
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
    try {
      const notifications = await backend.listNotifications(100);
      set({ notifications });
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
    set({
      workflows: workflows.map((w) =>
        w.id === activeWorkflowId
          ? { ...w, name: workflow.name, definition: workflow }
          : w,
      ),
    });
  },

  saveActiveWorkflow: async (definition) => {
    if (get().overlayRunId !== null) return;
    const { workflows, activeWorkflowId } = get();
    const active = workflows.find((w) => w.id === activeWorkflowId);
    if (active === undefined) return;
    const backend = getBackend();
    const workflow = definition ?? active.definition;
    const previous = await backend.getWorkflow(workflow.id);
    const before = previous ? structuredClone(previous.definition) : null;
    const [stored, validation] = await Promise.all([
      backend.saveWorkflow(workflow),
      backend.validateWorkflow(workflow),
    ]);
    set({
      workflows: get().workflows.map((w) => (w.id === stored.id ? stored : w)),
      validation,
    });
    if (before && stored.definition.defaults?.repoDir?.trim()) {
      try {
        const context = await backend.getProjectMemoryContext(
          stored.definition.defaults.repoDir,
        );
        const observations = commandEdits(before, stored.definition, context.scope);
        if (observations.length) {
          await backend.observeEdits(observations);
          await get().refreshLibrary();
        }
      } catch (error: unknown) {
        set({
          error: 'Workflow saved. Memory observation failed: ' + errorMessage(error),
        });
      }
    }
    return stored;
  },

  setValidation: (validation) => {
    set({ validation });
  },

  selectRun: async (id) => {
    set({ activeRunId: id });
    if (id === null) return;
    const backend = getBackend();
    const results = await backend.getRunResults(id);
    set({ runResults: { ...get().runResults, [id]: results } });
  },

  setError: (error) => {
    set({ error });
  },
}));

export function selectActiveWorkflow(state: AppState): StoredWorkflow | null {
  return state.workflows.find((w) => w.id === state.activeWorkflowId) ?? null;
}
