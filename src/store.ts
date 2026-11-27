import type { ReactNode } from 'react';
import { newId } from './lib/workflow';
import { commandEdits } from './lib/memory';
import { create } from 'zustand';
import { getBackend } from './lib/backend';
import {
  PERMISSION_DEFAULT_SETTING,
  readPermissionDefault,
  type AdapterInfo,
  type AgentProfile,
  type AppPermissionDefault,
} from './lib/agents';
import type { GitHubState, McpServerConfig } from './lib/integrations';
import {
  ABILITIES_SETTING,
  NO_ABILITIES,
  serializeAbilities,
  storedAbilities,
  type AppAbilities,
  type HostAbilities,
} from './lib/abilities';
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
import type { UpdateCheck } from './lib/updates';
import type { TemplateDomain } from './lib/template-domains';

/** One CLI's detection: running, its result, or why it failed. */
export type HostAbilitiesState =
  | { kind: 'detecting'; previous: HostAbilities | null }
  | { kind: 'done'; abilities: HostAbilities }
  | { kind: 'error'; message: string };

function currentAbilities(state: HostAbilitiesState | undefined): HostAbilities | null {
  if (state?.kind === 'done') return state.abilities;
  if (state?.kind === 'detecting') return state.previous;
  return null;
}

export interface UiNotice {
  id: string;
  content: ReactNode;
  variant?: 'info' | 'warn' | 'error';
  role?: 'status' | 'alert' | 'form';
  dismissLabel?: string;
  onDismiss?: () => void;
  group?: string;
  /** Plain text of the message; the same text and variant again updates this notice. */
  text?: string;
  /** Bumped when the same message is published again, to restart its lifetime. */
  revision?: number;
}

export type WorkflowIntent =
  { kind: 'generate'; goal: string } | { kind: 'run' } | { kind: 'new' };

export type View =
  | 'home'
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
  /**
   * Runs still pending, running or waiting, however old. `runs` is the newest
   * 100; these keep Home and the sidebar count right when an older run still
   * works or waits. Merge with `mergeActiveRuns` (lib/dashboard).
   */
  activeRuns: StoredRun[];
  activeRunId: string | null;
  runResults: Record<string, StoredNodeResult[]>;
  /** Run status seen when each cached result list was requested. A terminal
   * status that still matches the run means the cached results are final. */
  runResultStatus: Record<string, RunStatus>;
  tools: ToolStatus[];
  adapters: AdapterInfo[];
  profiles: AgentProfile[];
  /** App-wide agent permission level; `null` until the user chooses. */
  agentPermissionDefault: AppPermissionDefault | null;
  /** What Claude Code steps may use from the user's own setup (Environment). */
  agentAbilities: AppAbilities;
  /** Last detection of each CLI's own setup, this session. */
  hostAbilities: Partial<Record<'claude' | 'codex', HostAbilitiesState>>;
  knownFolders: string[];
  /** Where folderless steps run (`<root>/<Workflow name>`); null until known. */
  workspaceRoot: string | null;
  /** The Templates filter, so Home's use-case tiles can open a domain. */
  templateDomain: TemplateDomain | 'all';
  setTemplateDomain: (domain: TemplateDomain | 'all') => void;
  /** The Templates search, so the command palette can open a template. */
  templateQuery: string;
  setTemplateQuery: (query: string) => void;
  /**
   * Something asked for from Home or the command palette that the Workflows
   * view does once when it opens: draft a goal, start the selected
   * workflow, or create a new one.
   */
  pendingIntent: WorkflowIntent | null;
  setPendingIntent: (intent: WorkflowIntent | null) => void;
  mcpServers: McpServerConfig[];
  githubState: GitHubState | null;
  schedules: Schedule[];
  watchers: Watcher[];
  notifications: Notification[];
  notificationSnapshotLoaded: boolean;
  seenNotificationIds: number[];
  notificationPrefs: NotificationPrefs | null;
  backgroundMode: boolean;
  /** Last update check (Environment → Updates and the app banner). */
  updateCheck: UpdateCheck | null;
  updateError: string | null;
  updateChecking: boolean;
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
  refreshActiveRuns: () => Promise<void>;
  refreshTools: () => Promise<void>;
  /** Read the workspace root again (after Environment changes it). */
  refreshWorkspaceRoot: () => Promise<void>;
  refreshProfiles: () => Promise<void>;
  /**
   * Switch `profiles` (their own level) back to following the app-wide agent
   * permission level, then save that level. Rejects with the backend error,
   * leaving the level unsaved if any profile could not be switched.
   */
  setAgentPermissionDefault: (
    level: AppPermissionDefault,
    profiles?: AgentProfile[],
  ) => Promise<void>;
  /** Save the app-wide abilities; rejects with the backend error. */
  setAgentAbilities: (abilities: AppAbilities) => Promise<void>;
  /** Run the CLI's listing commands to see what it brings (no prompt). */
  detectHostAbilities: (adapter: 'claude' | 'codex') => Promise<void>;
  refreshIntegrations: () => Promise<void>;
  refreshAutomations: () => Promise<void>;
  refreshNotifications: () => Promise<void>;
  /**
   * Ask GitHub for the latest release. With `announce`, a newer version is
   * recorded once in the Inbox (and as a desktop notification when enabled).
   */
  checkForUpdates: (announce: boolean) => Promise<void>;
  refreshLibrary: () => Promise<void>;
  selectWorkflow: (id: string | null) => void;
  selectNode: (id: string | null) => void;
  selectEdge: (id: string | null) => void;
  openRunOnCanvas: (runId: string) => Promise<boolean>;
  openRunInRuns: (runId: string) => Promise<boolean>;
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

/** Popup tone for a new Inbox entry. */
function noticeVariant(kind: string): 'info' | 'warn' | 'error' {
  if (['failure', 'schedule-blocked', 'schedule-failed', 'watcher-error'].includes(kind))
    return 'error';
  if (kind === 'success' || kind === 'schedule-started') return 'info';
  return 'warn';
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
  view: 'home',
  workflows: [],
  activeWorkflowId: null,
  selectedNodeId: null,
  validation: [],
  workflowSaveStates: {},
  runs: [],
  activeRuns: [],
  activeRunId: null,
  runResults: {},
  runResultStatus: {},
  tools: [],
  adapters: [],
  profiles: [],
  agentPermissionDefault: null,
  agentAbilities: NO_ABILITIES,
  hostAbilities: {},
  knownFolders: [],
  workspaceRoot: null,
  templateDomain: 'all',
  setTemplateDomain: (templateDomain) => {
    set({ templateDomain });
  },
  templateQuery: '',
  setTemplateQuery: (templateQuery) => {
    set({ templateQuery });
  },
  pendingIntent: null,
  setPendingIntent: (pendingIntent) => {
    set({ pendingIntent });
  },
  mcpServers: [],
  githubState: null,
  schedules: [],
  watchers: [],
  notifications: [],
  notificationSnapshotLoaded: false,
  seenNotificationIds: [],
  notificationPrefs: null,
  backgroundMode: false,
  updateCheck: null,
  updateError: null,
  updateChecking: false,
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
    const text =
      notice.text ?? (typeof notice.content === 'string' ? notice.content.trim() : '');
    // The same message again (Load after choosing a repository already loaded
    // it, a save that fails twice, a poll that keeps failing) updates the
    // visible one in place and restarts its lifetime: no stacked copies, and a
    // focused Dismiss button keeps its focus.
    const repeats = (n: UiNotice): boolean =>
      text !== '' && n.text === text && n.variant === notice.variant;
    const previous = get().uiNotices.find(repeats);
    const next: UiNotice = {
      ...notice,
      ...(text === '' ? {} : { text }),
      id: previous?.id ?? newId('notice'),
      ...(previous === undefined ? {} : { revision: (previous.revision ?? 0) + 1 }),
    };
    set((current) => {
      const kept = current.uiNotices.filter(
        (n) => n.id === next.id || !notice.group || n.group !== notice.group,
      );
      return {
        uiNotices:
          previous === undefined
            ? [...kept, next]
            : kept
                .filter((n) => n.id === next.id || !repeats(n))
                .map((n) => (n.id === next.id ? next : n)),
      };
    });
    // The previous copy's onDismiss is not called: after a remount it belongs
    // to an unmounted <Notice> whose owner just set this same message again.
  },
  removeUiNotice: (id) => {
    set((current) => ({ uiNotices: current.uiNotices.filter((n) => n.id !== id) }));
  },

  setView: (view) => {
    navigationSequence++;
    // A search the palette filled in lasts for that visit to Templates.
    set(
      get().view === 'templates' && view !== 'templates'
        ? { view, templateQuery: '' }
        : { view },
    );
  },

  refreshAll: async () => {
    set({ loading: true, error: null });
    try {
      await Promise.all([
        get().refreshWorkflows(),
        get().refreshRuns(),
        get().refreshTools(),
        get().refreshWorkspaceRoot(),
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
    if (request !== runsRefreshSequence) return;
    // A directly opened older run may sit outside the recent list. Retain the
    // selection across refreshes so polling cannot remove it from under Runs.
    const selected = get().activeRunId;
    if (selected !== null && !runs.some((run) => run.id === selected)) {
      try {
        const retained = await backend.getRun(selected);
        if (request !== runsRefreshSequence) return;
        if (get().activeRunId !== selected) {
          return;
        }
        set({ runs: retained === null ? runs : [retained, ...runs] });
      } catch {
        if (request !== runsRefreshSequence) return;
        // A transient fetch failure is not evidence that the selected run was
        // deleted. Keep its cached row instead of blanking its detail pane.
        const cached = get().runs.find((run) => run.id === selected);
        if (get().activeRunId === selected)
          set({ runs: cached === undefined ? runs : [cached, ...runs] });
      }
      return;
    }
    set({ runs });
  },

  refreshActiveRuns: async () => {
    const activeRuns = await getBackend().listActiveRuns();
    set({ activeRuns });
  },

  refreshTools: async () => {
    const backend = getBackend();
    const tools = await backend.detectTools();
    set({ tools });
  },

  refreshWorkspaceRoot: async () => {
    // Only shown as a hint: a backend without a home folder leaves it unknown.
    try {
      set({ workspaceRoot: await getBackend().workspaceRoot() });
    } catch {
      set({ workspaceRoot: null });
    }
  },

  refreshProfiles: async () => {
    const backend = getBackend();
    try {
      const [profiles, adapters, knownFolders, permissionDefault, abilities] =
        await Promise.all([
          backend.listAgentProfiles(),
          backend.listAdapters(),
          backend.listKnownFolders(20).catch(() => [] as string[]),
          backend.getSetting(PERMISSION_DEFAULT_SETTING).catch(() => null),
          backend.getSetting(ABILITIES_SETTING).catch(() => null),
        ]);
      set({
        profiles,
        adapters,
        knownFolders,
        agentPermissionDefault: readPermissionDefault(permissionDefault),
        agentAbilities: storedAbilities(abilities),
      });
    } catch {
      // Browser mock before profiles exist, or Tauri command missing in
      // older builds: profiles simply stay empty.
    }
  },

  setAgentPermissionDefault: async (level, profiles = []) => {
    const backend = getBackend();
    try {
      // Profiles first, the setting last: a failed save leaves the choice
      // unmade (so the question and its error stay on screen), and never
      // grants more than what was chosen.
      for (const profile of profiles)
        await backend.saveAgentProfile({ ...profile, permissionLevel: 'appDefault' });
      await backend.setSetting(PERMISSION_DEFAULT_SETTING, level);
      set({ agentPermissionDefault: level });
    } finally {
      await get().refreshProfiles();
    }
  },

  setAgentAbilities: async (abilities) => {
    await getBackend().setSetting(ABILITIES_SETTING, serializeAbilities(abilities));
    set({ agentAbilities: abilities });
  },

  detectHostAbilities: async (adapter) => {
    set((state) => ({
      hostAbilities: {
        ...state.hostAbilities,
        [adapter]: {
          kind: 'detecting',
          previous: currentAbilities(state.hostAbilities[adapter]),
        },
      },
    }));
    try {
      const abilities = await getBackend().detectAgentAbilities(adapter);
      set((state) => ({
        hostAbilities: { ...state.hostAbilities, [adapter]: { kind: 'done', abilities } },
      }));
    } catch (err) {
      set((state) => ({
        hostAbilities: {
          ...state.hostAbilities,
          [adapter]: { kind: 'error', message: errorMessage(err) },
        },
      }));
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
          // The update banner already shows new releases.
          if (notification.kind === 'update') continue;
          get().pushUiNotice({
            content: `${notification.title}: ${notification.body}`,
            variant: noticeVariant(notification.kind),
          });
        }
      }
    } catch {
      // Mock backend: stay empty.
    }
  },

  checkForUpdates: async (announce) => {
    if (get().updateChecking) return;
    set({ updateChecking: true });
    try {
      const backend = getBackend();
      const result = await backend.checkForUpdate();
      set({ updateCheck: result, updateError: null });
      if (announce && result.updateAvailable) {
        const created = await backend
          .recordUpdateNotice(result.latest.version)
          .catch(() => false);
        if (created) await get().refreshNotifications();
      }
    } catch (err) {
      set({ updateError: errorMessage(err) });
    } finally {
      set({ updateChecking: false });
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
      templateQuery: '',
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
  openRunInRuns: async (runId) => {
    // Inbox "Open run": show this exact run in Runs, not the canvas overlay.
    // Fetches by run ID so older runs outside listRuns(100) still resolve,
    // and runs whose workflow was deleted still open (the stored run row is
    // what Runs renders; its snapshot workflow loads like any selection).
    const request = ++navigationSequence;
    const selection = ++runSelectionSequence;
    const backend = getBackend();
    const run = await backend.getRun(runId);
    if (run === null) throw new Error(`Unknown run '${runId}'.`);
    if (request !== navigationSequence || selection !== runSelectionSequence)
      return false;
    // Load before mounting Runs: its mount refresh selects the run again and
    // would otherwise invalidate this navigation before Inbox can mark read.
    const results = await backend.getRunResults(runId);
    if (request !== navigationSequence || selection !== runSelectionSequence)
      return false;
    const { runResults, runResultStatus } = get();
    const cached = runResults[runId];
    // A pending recent-list/retention fetch must not remove this older run.
    runsRefreshSequence++;
    set({
      view: 'runs',
      templateQuery: '',
      activeRunId: runId,
      runs: [run, ...get().runs.filter((existing) => existing.id !== runId)],
      runResults:
        cached !== undefined && sameNodeResults(cached, results)
          ? runResults
          : { ...runResults, [runId]: results },
      runResultStatus: { ...runResultStatus, [runId]: run.status },
    });
    return true;
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
    runsRefreshSequence++;
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
