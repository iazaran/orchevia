/**
 * Backend abstraction.
 *
 * In the Tauri desktop app, calls go to Rust commands via `@tauri-apps/api`.
 * In a plain browser (`pnpm dev` without Tauri), a local mock backed by
 * `localStorage` keeps the UI fully usable for development.
 */
/* eslint-disable @typescript-eslint/require-await -- MockBackend implements the
   async Backend interface with synchronous logic by design. */
import {
  composeSkillPrompt,
  effectiveExecutable,
  referencedVariables,
  validateProfile,
  type AdapterInfo,
  type AgentProfile,
  type AgentSkillInfo,
  type AdapterKind,
} from './agents';
import { evalCondition } from './conditions';
import type { GitHubState, McpServerConfig, McpToolInfo } from './integrations';
import type {
  EditObservation,
  GenerationPreview,
  InstantiationPreview,
  Preference,
  StoredGeneration,
  WorkflowTemplate,
} from './generation';
import type {
  GroupedFinding,
  Notification,
  NotificationPrefs,
  RiskCategory,
  Schedule,
  ScheduleKind,
  Watcher,
} from './scheduler';
import type {
  StoredNodeResult,
  StoredRun,
  StoredWorkflow,
  ToolStatus,
  ValidationIssue,
  Workflow,
} from './workflow';
import { createSampleWorkflow, validateWorkflowLocal } from './workflow';

export interface Backend {
  listWorkflows(): Promise<StoredWorkflow[]>;
  getWorkflow(id: string): Promise<StoredWorkflow | null>;
  saveWorkflow(workflow: Workflow): Promise<StoredWorkflow>;
  deleteWorkflow(id: string): Promise<boolean>;
  validateWorkflow(workflow: Workflow): Promise<ValidationIssue[]>;
  detectTools(): Promise<ToolStatus[]>;
  runWorkflow(
    workflowId: string,
    inputs?: Record<string, string>,
  ): Promise<{ runId: string }>;
  cancelRun(runId: string): Promise<boolean>;
  approveRun(
    runId: string,
    approved: boolean,
    note?: string,
    expectedApprovalId?: number,
  ): Promise<void>;
  listRuns(limit?: number): Promise<StoredRun[]>;
  getRunResults(runId: string): Promise<StoredNodeResult[]>;
  deleteRun(runId: string): Promise<boolean>;
  clearFinishedRuns(): Promise<{ removed: number; kept: number }>;
  previewCommand(executable: string, args: string[]): Promise<string>;
  listAdapters(): Promise<AdapterInfo[]>;
  listAgentProfiles(): Promise<AgentProfile[]>;
  listAgentSkills(adapter: AdapterKind, workingDir?: string): Promise<AgentSkillInfo[]>;
  saveAgentProfile(profile: AgentProfile): Promise<AgentProfile>;
  deleteAgentProfile(id: string): Promise<boolean>;
  previewAgentCommand(
    profileId: string,
    promptTemplate: string,
    workingDir?: string,
  ): Promise<{
    executable: string;
    args: string[];
    preview: string;
    referencedVariables: string[];
  }>;
  testAgentProfile(profileId: string): Promise<ToolStatus>;
  listKnownFolders(limit?: number): Promise<string[]>;
  listCustomModels(adapter: string): Promise<string[]>;
  saveCustomModels(adapter: string, models: string[]): Promise<string[]>;
  gitCurrentBranch(workingDir: string): Promise<string>;
  gitBranches(workingDir: string): Promise<{ current: string; branches: string[] }>;
  listMcpServers(): Promise<McpServerConfig[]>;
  saveMcpServer(server: McpServerConfig): Promise<McpServerConfig>;
  deleteMcpServer(id: string): Promise<boolean>;
  mcpListTools(serverId: string): Promise<McpToolInfo[]>;
  mcpEnvPresent(names: string[]): Promise<{ name: string; present: boolean }[]>;
  githubState(): Promise<GitHubState>;
  listSchedules(): Promise<Schedule[]>;
  saveSchedule(schedule: Schedule): Promise<Schedule>;
  deleteSchedule(id: string): Promise<boolean>;
  fireScheduleNow(id: string): Promise<{ runId: string }>;
  schedulePreview(
    kind: ScheduleKind,
    timezone: string,
    count?: number,
  ): Promise<string[]>;
  listWatchers(): Promise<Watcher[]>;
  saveWatcher(watcher: Watcher): Promise<Watcher>;
  deleteWatcher(id: string): Promise<boolean>;
  workflowRisks(workflow: Workflow): Promise<RiskCategory[]>;
  getRunFindings(runId: string): Promise<GroupedFinding[]>;
  listNotifications(limit?: number, unreadOnly?: boolean): Promise<Notification[]>;
  markNotificationRead(id: number): Promise<void>;
  markAllNotificationsRead(): Promise<void>;
  getNotificationPrefs(): Promise<NotificationPrefs>;
  setNotificationPrefs(prefs: NotificationPrefs): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  diagnosticsBundle(): Promise<string>;
  roleMapDefault(): Promise<Record<string, string>>;
  listTemplates(): Promise<{ builtin: WorkflowTemplate[]; user: WorkflowTemplate[] }>;
  saveUserTemplate(template: WorkflowTemplate): Promise<WorkflowTemplate>;
  saveWorkflowAsTemplate(
    workflowId: string,
    name: string,
    category?: string,
  ): Promise<WorkflowTemplate>;
  deleteUserTemplate(id: string): Promise<boolean>;
  exportTemplate(id: string, builtin: boolean): Promise<string>;
  importTemplate(json: string): Promise<WorkflowTemplate>;
  instantiateTemplate(
    id: string,
    builtin: boolean,
    roleMap?: Record<string, string>,
  ): Promise<InstantiationPreview>;
  generateWorkflow(
    profileId: string,
    goal: string,
    repo?: { dir?: string; branch?: string },
  ): Promise<GenerationPreview>;
  markGenerationStatus(id: string, status: string): Promise<void>;
  listGenerations(limit?: number): Promise<StoredGeneration[]>;
  listPreferences(): Promise<Preference[]>;
  savePreference(preference: Preference): Promise<Preference>;
  deletePreference(key: string): Promise<boolean>;
  resetMemory(): Promise<void>;
  exportMemory(): Promise<string>;
  importMemory(json: string): Promise<number>;
  observeEdits(observations: EditObservation[]): Promise<Preference[]>;
}

function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  );
}

class TauriBackend implements Backend {
  private async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  }

  listWorkflows(): Promise<StoredWorkflow[]> {
    return this.invoke('list_workflows');
  }
  getWorkflow(id: string): Promise<StoredWorkflow | null> {
    return this.invoke('get_workflow', { id });
  }
  saveWorkflow(workflow: Workflow): Promise<StoredWorkflow> {
    return this.invoke('save_workflow', { workflow });
  }
  deleteWorkflow(id: string): Promise<boolean> {
    return this.invoke('delete_workflow', { id });
  }
  validateWorkflow(workflow: Workflow): Promise<ValidationIssue[]> {
    return this.invoke('validate_workflow_cmd', { workflow });
  }
  detectTools(): Promise<ToolStatus[]> {
    return this.invoke('detect_tools');
  }
  runWorkflow(
    workflowId: string,
    inputs?: Record<string, string>,
  ): Promise<{ runId: string }> {
    return this.invoke('run_workflow', { workflowId, inputs: inputs ?? {} });
  }
  cancelRun(runId: string): Promise<boolean> {
    return this.invoke('cancel_run', { runId });
  }
  approveRun(
    runId: string,
    approved: boolean,
    note?: string,
    expectedApprovalId?: number,
  ): Promise<void> {
    return this.invoke('approve_run', {
      runId,
      approved,
      note: note ?? null,
      expectedApprovalId: expectedApprovalId ?? null,
    });
  }
  listRuns(limit = 50): Promise<StoredRun[]> {
    return this.invoke('list_runs', { limit });
  }
  getRunResults(runId: string): Promise<StoredNodeResult[]> {
    return this.invoke('get_run_results', { runId });
  }
  deleteRun(runId: string): Promise<boolean> {
    return this.invoke('delete_run', { runId });
  }
  clearFinishedRuns(): Promise<{ removed: number; kept: number }> {
    return this.invoke('clear_finished_runs');
  }
  previewCommand(executable: string, args: string[]): Promise<string> {
    return this.invoke('preview_command', { executable, args });
  }
  listAdapters(): Promise<AdapterInfo[]> {
    return this.invoke('list_adapters');
  }
  listAgentProfiles(): Promise<AgentProfile[]> {
    return this.invoke('list_agent_profiles');
  }
  listAgentSkills(adapter: AdapterKind, workingDir?: string): Promise<AgentSkillInfo[]> {
    return this.invoke('list_agent_skills', { adapter, workingDir });
  }
  saveAgentProfile(profile: AgentProfile): Promise<AgentProfile> {
    return this.invoke('save_agent_profile', { profile });
  }
  deleteAgentProfile(id: string): Promise<boolean> {
    return this.invoke('delete_agent_profile', { id });
  }
  previewAgentCommand(
    profileId: string,
    promptTemplate: string,
    workingDir?: string,
  ): Promise<{
    executable: string;
    args: string[];
    preview: string;
    referencedVariables: string[];
  }> {
    return this.invoke('preview_agent_command', {
      profileId,
      promptTemplate,
      workingDir,
    });
  }
  testAgentProfile(profileId: string): Promise<ToolStatus> {
    return this.invoke('test_agent_profile', { profileId });
  }
  listKnownFolders(limit = 20): Promise<string[]> {
    return this.invoke('list_known_folders', { limit });
  }
  listCustomModels(adapter: string): Promise<string[]> {
    return this.invoke('list_custom_models', { adapter });
  }
  saveCustomModels(adapter: string, models: string[]): Promise<string[]> {
    return this.invoke('save_custom_models', { adapter, models });
  }
  gitCurrentBranch(workingDir: string): Promise<string> {
    return this.invoke('git_current_branch', { workingDir });
  }
  gitBranches(workingDir: string): Promise<{ current: string; branches: string[] }> {
    return this.invoke('git_branches', { workingDir });
  }
  listMcpServers(): Promise<McpServerConfig[]> {
    return this.invoke('list_mcp_servers');
  }
  saveMcpServer(server: McpServerConfig): Promise<McpServerConfig> {
    return this.invoke('save_mcp_server', { server });
  }
  deleteMcpServer(id: string): Promise<boolean> {
    return this.invoke('delete_mcp_server', { id });
  }
  mcpListTools(serverId: string): Promise<McpToolInfo[]> {
    return this.invoke('mcp_list_tools', { serverId });
  }
  mcpEnvPresent(names: string[]): Promise<{ name: string; present: boolean }[]> {
    return this.invoke('mcp_env_present', { names });
  }
  githubState(): Promise<GitHubState> {
    return this.invoke('github_state');
  }
  listSchedules(): Promise<Schedule[]> {
    return this.invoke('list_schedules');
  }
  saveSchedule(schedule: Schedule): Promise<Schedule> {
    return this.invoke('save_schedule', { schedule });
  }
  deleteSchedule(id: string): Promise<boolean> {
    return this.invoke('delete_schedule', { id });
  }
  fireScheduleNow(id: string): Promise<{ runId: string }> {
    return this.invoke('fire_schedule_now', { id });
  }
  schedulePreview(kind: ScheduleKind, timezone: string, count = 3): Promise<string[]> {
    return this.invoke('schedule_preview', { kind, timezone, count });
  }
  listWatchers(): Promise<Watcher[]> {
    return this.invoke('list_watchers');
  }
  saveWatcher(watcher: Watcher): Promise<Watcher> {
    return this.invoke('save_watcher', { watcher });
  }
  deleteWatcher(id: string): Promise<boolean> {
    return this.invoke('delete_watcher', { id });
  }
  workflowRisks(workflow: Workflow): Promise<RiskCategory[]> {
    return this.invoke('workflow_risks', { workflow });
  }
  getRunFindings(runId: string): Promise<GroupedFinding[]> {
    return this.invoke('get_run_findings', { runId });
  }
  listNotifications(limit = 50, unreadOnly = false): Promise<Notification[]> {
    return this.invoke('list_notifications', { limit, unreadOnly });
  }
  markNotificationRead(id: number): Promise<void> {
    return this.invoke('mark_notification_read', { id });
  }
  markAllNotificationsRead(): Promise<void> {
    return this.invoke('mark_all_notifications_read');
  }
  getNotificationPrefs(): Promise<NotificationPrefs> {
    return this.invoke('get_notification_prefs');
  }
  setNotificationPrefs(prefs: NotificationPrefs): Promise<void> {
    return this.invoke('set_notification_prefs', { prefs });
  }
  getSetting(key: string): Promise<string | null> {
    return this.invoke('get_setting', { key });
  }
  setSetting(key: string, value: string): Promise<void> {
    return this.invoke('set_setting', { key, value });
  }
  diagnosticsBundle(): Promise<string> {
    return this.invoke('diagnostics_bundle');
  }
  roleMapDefault(): Promise<Record<string, string>> {
    return this.invoke('role_map_default');
  }
  listTemplates(): Promise<{ builtin: WorkflowTemplate[]; user: WorkflowTemplate[] }> {
    return this.invoke('list_templates');
  }
  saveUserTemplate(template: WorkflowTemplate): Promise<WorkflowTemplate> {
    return this.invoke('save_user_template', { template });
  }
  saveWorkflowAsTemplate(
    workflowId: string,
    name: string,
    category?: string,
  ): Promise<WorkflowTemplate> {
    return this.invoke('save_workflow_as_template', { workflowId, name, category });
  }
  deleteUserTemplate(id: string): Promise<boolean> {
    return this.invoke('delete_user_template', { id });
  }
  exportTemplate(id: string, builtin: boolean): Promise<string> {
    return this.invoke('export_template', { id, builtin });
  }
  importTemplate(json: string): Promise<WorkflowTemplate> {
    return this.invoke('import_template', { json });
  }
  instantiateTemplate(
    id: string,
    builtin: boolean,
    roleMap?: Record<string, string>,
  ): Promise<InstantiationPreview> {
    return this.invoke('instantiate_template', { id, builtin, roleMap });
  }
  generateWorkflow(
    profileId: string,
    goal: string,
    repo?: { dir?: string; branch?: string },
  ): Promise<GenerationPreview> {
    return this.invoke('generate_workflow', {
      profileId,
      goal,
      repoDir: repo?.dir ?? null,
      branch: repo?.branch ?? null,
    });
  }
  markGenerationStatus(id: string, status: string): Promise<void> {
    return this.invoke('mark_generation_status', { id, status });
  }
  listGenerations(limit = 50): Promise<StoredGeneration[]> {
    return this.invoke('list_generations', { limit });
  }
  listPreferences(): Promise<Preference[]> {
    return this.invoke('list_preferences');
  }
  savePreference(preference: Preference): Promise<Preference> {
    return this.invoke('save_preference', { preference });
  }
  deletePreference(key: string): Promise<boolean> {
    return this.invoke('delete_preference', { key });
  }
  resetMemory(): Promise<void> {
    return this.invoke('reset_memory');
  }
  exportMemory(): Promise<string> {
    return this.invoke('export_memory');
  }
  importMemory(json: string): Promise<number> {
    return this.invoke('import_memory', { json });
  }
  observeEdits(observations: EditObservation[]): Promise<Preference[]> {
    return this.invoke('observe_edits', { observations });
  }
}

/**
 * Browser-only development backend. Persists workflows in localStorage and
 * simulates command execution deterministically (no processes spawned).
 */
class MockBackend implements Backend {
  private workflows = new Map<string, StoredWorkflow>();
  private runs: StoredRun[] = [];
  private results = new Map<string, StoredNodeResult[]>();
  private runWorkflows = new Map<string, Workflow>();
  private profiles = new Map<string, AgentProfile>();
  private mcpServers = new Map<string, McpServerConfig>();
  private schedules = new Map<string, Schedule>();
  private watchers = new Map<string, Watcher>();
  private counter = 1;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    this.load();
    if (this.workflows.size === 0) {
      const sample = createSampleWorkflow();
      const now = new Date().toISOString();
      this.workflows.set(sample.id, {
        id: sample.id,
        name: sample.name,
        definition: sample,
        createdAt: now,
        updatedAt: now,
      });
      this.persist();
    }
  }

  private storageKey(): string {
    return 'orchevia.mock-backend.v1';
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(this.storageKey());
      if (raw === null) return;
      const data = JSON.parse(raw) as {
        workflows: StoredWorkflow[];
        profiles?: AgentProfile[];
        mcpServers?: McpServerConfig[];
      };
      for (const w of data.workflows) this.workflows.set(w.id, w);
      for (const p of data.profiles ?? []) this.profiles.set(p.id, p);
      for (const s of data.mcpServers ?? []) this.mcpServers.set(s.id, s);
    } catch {
      // Corrupt dev storage: start fresh.
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(
        this.storageKey(),
        JSON.stringify({
          workflows: [...this.workflows.values()],
          profiles: [...this.profiles.values()],
          mcpServers: [...this.mcpServers.values()],
        }),
      );
    } catch {
      // Storage full/blocked: non-fatal in dev.
    }
  }

  async listWorkflows(): Promise<StoredWorkflow[]> {
    return [...this.workflows.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  async getWorkflow(id: string): Promise<StoredWorkflow | null> {
    return this.workflows.get(id) ?? null;
  }

  async saveWorkflow(workflow: Workflow): Promise<StoredWorkflow> {
    const now = new Date().toISOString();
    const existing = this.workflows.get(workflow.id);
    const stored: StoredWorkflow = {
      id: workflow.id,
      name: workflow.name,
      definition: workflow,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.workflows.set(workflow.id, stored);
    this.persist();
    return stored;
  }

  async deleteWorkflow(id: string): Promise<boolean> {
    if (
      this.runs.some(
        (run) =>
          run.workflowId === id && (run.status === 'running' || run.status === 'paused'),
      )
    ) {
      throw new Error(
        `Workflow '${id}' has running or paused runs; cancel them before deleting.`,
      );
    }
    const removed = this.workflows.delete(id);
    for (const run of this.runs.filter((run) => run.workflowId === id)) {
      this.results.delete(run.id);
      this.runWorkflows.delete(run.id);
    }
    this.runs = this.runs.filter((run) => run.workflowId !== id);
    this.persist();
    return removed;
  }

  async validateWorkflow(workflow: Workflow): Promise<ValidationIssue[]> {
    return validateWorkflowLocal(workflow);
  }

  async detectTools(): Promise<ToolStatus[]> {
    return [
      {
        id: 'git',
        displayName: 'Git',
        installed: true,
        version: 'git version 2.x (mock)',
      },
      { id: 'gh', displayName: 'GitHub CLI', installed: false },
      { id: 'claude', displayName: 'Claude Code', installed: false },
      { id: 'codex', displayName: 'Codex', installed: false },
    ];
  }

  async runWorkflow(
    workflowId: string,
    inputs?: Record<string, string>,
  ): Promise<{ runId: string }> {
    const wf = this.workflows.get(workflowId);
    if (wf === undefined) throw new Error(`Unknown workflow '${workflowId}'.`);
    const runId = `run-mock-${String(this.counter++)}`;
    const run: StoredRun = {
      id: runId,
      workflowId,
      status: 'running',
      startedAt: new Date().toISOString(),
      inputs: { ...mockInputDefaults(wf.definition), ...(inputs ?? {}) },
    };
    this.runs.unshift(run);
    this.results.set(runId, []);
    const snapshot = structuredClone(wf.definition);
    this.runWorkflows.set(runId, snapshot);
    // Simulate async execution node by node.
    void this.simulate(snapshot, runId);
    return { runId };
  }

  private async simulate(workflow: Workflow, runId: string): Promise<void> {
    for (;;) {
      const run = this.runs.find((r) => r.id === runId);
      if (run === undefined || run.status !== 'running') return;
      const results = this.results.get(runId) ?? [];
      const completed = new Set(
        results
          .filter((r) => r.status === 'succeeded' || r.status === 'approved')
          .map((r) => r.nodeId),
      );
      const nodeId = orderOf(workflow, results, run.inputs ?? {}).find(
        (id) => !completed.has(id),
      );
      if (nodeId === undefined) break;
      const node = workflow.nodes.find((n) => n.id === nodeId);
      if (node === undefined) continue;
      if (node.type === 'approval') {
        run.status = 'paused';
        this.pushResult(runId, nodeId, 'paused', 'Waiting for human approval (mock).');
        return;
      }
      if (node.type === 'condition') {
        const outcome =
          node.config.condition === undefined ||
          evalCondition(
            node.config.condition,
            mockVariables(workflow, results, run.inputs ?? {}),
          );
        this.pushResult(runId, nodeId, 'succeeded', String(outcome));
        continue;
      }
      if (
        node.type === 'git' ||
        node.type === 'github' ||
        node.type === 'ticket' ||
        node.type === 'mcp'
      ) {
        await new Promise((resolve) => {
          this.timers.set(runId, setTimeout(resolve, 350));
        });
        const stillRunning = this.runs.find((r) => r.id === runId)?.status === 'running';
        if (!stillRunning) return;
        this.pushResult(
          runId,
          nodeId,
          'succeeded',
          `mock-integration$ ${node.type} node (browser mock, no processes spawned).`,
        );
        continue;
      }
      if (node.type === 'agent') {
        const live = this.startResult(runId, nodeId, 'Agent is running (browser mock).');
        await new Promise((resolve) => {
          this.timers.set(runId, setTimeout(resolve, 350));
        });
        const stillRunning = this.runs.find((r) => r.id === runId)?.status === 'running';
        if (!stillRunning) return;
        const profileId = node.config.agentProfileId ?? '';
        const profile = this.profiles.get(profileId);
        if (profile === undefined) {
          this.completeResult(
            live,
            'failed',
            `Unknown Agent Profile '${profileId}' (mock).`,
          );
          const failed = this.runs.find((r) => r.id === runId);
          if (failed !== undefined) {
            failed.status = 'failed';
            failed.finishedAt = new Date().toISOString();
          }
          return;
        }
        this.completeResult(
          live,
          'succeeded',
          `mock-agent$ ${profile.adapter} "${node.config.prompt ?? ''}"\nHello from Orchevia (browser mock, profile '${profile.name}').`,
        );
        continue;
      }
      if (node.type === 'command') {
        const exe = node.config.executable ?? '';
        const prefix = `mock$ ${exe} ${(node.config.args ?? []).join(' ')}`;
        const live = this.startResult(runId, nodeId, prefix + '\n');
        await new Promise((resolve) => {
          this.timers.set(runId, setTimeout(resolve, 350));
        });
        if (this.runs.find((r) => r.id === runId)?.status !== 'running') return;
        this.completeResult(
          live,
          'succeeded',
          prefix + '\nHello from Orchevia (browser mock, no process spawned).',
        );
        continue;
      }
      await new Promise((resolve) => {
        this.timers.set(runId, setTimeout(resolve, 350));
      });
      const stillRunning = this.runs.find((r) => r.id === runId)?.status === 'running';
      if (!stillRunning) return;
      this.pushResult(runId, nodeId, 'succeeded', '');
    }
    const run = this.runs.find((r) => r.id === runId);
    if (run !== undefined && run.status === 'running') {
      run.status = 'succeeded';
      run.finishedAt = new Date().toISOString();
    }
  }

  private startResult(runId: string, nodeId: string, stdout: string): StoredNodeResult {
    const list = this.results.get(runId) ?? [];
    const result: StoredNodeResult = {
      id: list.length + 1,
      runId,
      nodeId,
      status: 'running',
      stdout,
      stderr: '',
      startedAt: new Date().toISOString(),
    };
    list.push(result);
    this.results.set(runId, list);
    return result;
  }

  private completeResult(result: StoredNodeResult, status: string, stdout: string): void {
    result.status = status;
    result.stdout = stdout;
    result.finishedAt = new Date().toISOString();
    if (status === 'succeeded') result.exitCode = 0;
  }

  private pushResult(
    runId: string,
    nodeId: string,
    status: string,
    stdout: string,
  ): void {
    const list = this.results.get(runId) ?? [];
    const result: StoredNodeResult = {
      id: list.length + 1,
      runId,
      nodeId,
      status,
      stdout,
      stderr: '',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    if (status === 'succeeded') {
      result.exitCode = 0;
    }
    list.push(result);
    this.results.set(runId, list);
  }

  async cancelRun(runId: string): Promise<boolean> {
    const timer = this.timers.get(runId);
    if (timer !== undefined) clearTimeout(timer);
    const run = this.runs.find((r) => r.id === runId);
    if (run === undefined || (run.status !== 'running' && run.status !== 'paused'))
      return false;
    for (const row of this.results.get(runId) ?? []) {
      if (row.status === 'running') {
        row.status = 'cancelled';
        row.finishedAt = new Date().toISOString();
      }
    }
    run.status = 'cancelled';
    run.finishedAt = new Date().toISOString();
    return true;
  }

  async approveRun(
    runId: string,
    approved: boolean,
    note?: string,
    expectedApprovalId?: number,
  ): Promise<void> {
    const run = this.runs.find((r) => r.id === runId);
    if (run === undefined || run.status !== 'paused') {
      throw new Error(`Run '${runId}' is not paused.`);
    }
    const list = this.results.get(runId) ?? [];
    const paused = [...list].reverse().find((r) => r.status === 'paused');
    if (paused === undefined) throw new Error('No pending approval.');
    if (expectedApprovalId !== undefined && paused.id !== expectedApprovalId) {
      throw new Error('Approval changed. Refresh the run before deciding.');
    }
    paused.status = approved ? 'approved' : 'rejected';
    if (note !== undefined && note !== '') paused.stdout = note;
    if (!approved) {
      run.status = 'failed';
      run.finishedAt = new Date().toISOString();
      return;
    }
    run.status = 'running';
    const workflow =
      this.runWorkflows.get(runId) ?? this.workflows.get(run.workflowId)?.definition;
    if (workflow === undefined) throw new Error('Workflow no longer exists.');
    void this.simulate(workflow, runId);
  }

  async listRuns(limit = 50): Promise<StoredRun[]> {
    return this.runs.slice(0, limit);
  }

  async getRunResults(runId: string): Promise<StoredNodeResult[]> {
    return this.results.get(runId) ?? [];
  }

  async deleteRun(runId: string): Promise<boolean> {
    const run = this.runs.find((r) => r.id === runId);
    if (run === undefined) return false;
    if (run.status === 'running' || run.status === 'paused') {
      throw new Error(
        `Run '${runId}' is still ${run.status}; cancel it before deleting.`,
      );
    }
    this.runs = this.runs.filter((r) => r.id !== runId);
    this.results.delete(runId);
    this.runWorkflows.delete(runId);
    return true;
  }

  async clearFinishedRuns(): Promise<{ removed: number; kept: number }> {
    const kept = this.runs.filter((r) => r.status === 'running' || r.status === 'paused');
    const removed = this.runs.length - kept.length;
    const keepIds = new Set(kept.map((r) => r.id));
    for (const id of [...this.results.keys()]) {
      if (!keepIds.has(id)) {
        this.results.delete(id);
        this.runWorkflows.delete(id);
      }
    }
    this.runs = kept;
    return { removed, kept: kept.length };
  }

  async previewCommand(executable: string, args: string[]): Promise<string> {
    return [executable, ...args.map((a) => (a.includes(' ') ? `'${a}'` : a))].join(' ');
  }

  async listAdapters(): Promise<AdapterInfo[]> {
    return [
      {
        id: 'claude',
        displayName: 'Claude Code',
        defaultExecutable: 'claude',
        supportsModelFlag: true,
        supportsSessionResume: true,
        notes: 'Uses `claude -p <prompt> --output-format text`.',
      },
      {
        id: 'codex',
        displayName: 'Codex',
        defaultExecutable: 'codex',
        supportsModelFlag: true,
        supportsSessionResume: false,
        notes: 'Uses `codex exec <prompt>`.',
      },
      {
        id: 'custom',
        displayName: 'Custom CLI',
        defaultExecutable: '',
        supportsModelFlag: true,
        supportsSessionResume: false,
        notes: 'Your own CLI: set the binary path, prompt goes last.',
      },
    ];
  }

  async listAgentProfiles(): Promise<AgentProfile[]> {
    return [...this.profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async listAgentSkills(
    _adapter: AdapterKind,
    _workingDir?: string,
  ): Promise<AgentSkillInfo[]> {
    // The browser mock has no native filesystem access. Names can still be entered manually.
    return [];
  }

  async saveAgentProfile(profile: AgentProfile): Promise<AgentProfile> {
    const errors = validateProfile(profile);
    if (errors.length > 0) throw new Error(`Invalid agent profile: ${errors.join('; ')}`);
    this.profiles.set(profile.id, profile);
    this.persist();
    return profile;
  }

  async deleteAgentProfile(id: string): Promise<boolean> {
    const removed = this.profiles.delete(id);
    this.persist();
    return removed;
  }

  async previewAgentCommand(
    profileId: string,
    promptTemplate: string,
  ): Promise<{
    executable: string;
    args: string[];
    preview: string;
    referencedVariables: string[];
  }> {
    const profile = this.profiles.get(profileId);
    if (profile === undefined) throw new Error(`Unknown Agent Profile '${profileId}'.`);
    const exe = effectiveExecutable(profile);
    const effectivePrompt = composeSkillPrompt(profile, promptTemplate);
    if (promptTemplate.trim() === '') throw new Error('Prompt must not be empty.');
    const args =
      profile.adapter === 'claude'
        ? ['-p', effectivePrompt, '--output-format', 'text']
        : profile.adapter === 'codex'
          ? ['exec']
          : [];
    if ((profile.model ?? '').trim() !== '') {
      args.push('--model', (profile.model ?? '').trim());
    }
    const effort = (profile.effort ?? '').trim().toLowerCase();
    if (effort !== '' && profile.adapter === 'claude') args.push('--effort', effort);
    if (effort !== '' && profile.adapter === 'codex') {
      args.push('-c', `model_reasoning_effort="${effort}"`);
    }
    if (profile.adapter === 'codex') args.push(effectivePrompt);
    args.push(...profile.extraArgs);
    if (profile.adapter === 'custom') args.push(effectivePrompt);
    return {
      executable: exe,
      args,
      preview: [exe, ...args.map((a) => (a.includes(' ') ? `'${a}'` : a))].join(' '),
      referencedVariables: referencedVariables(promptTemplate),
    };
  }

  async testAgentProfile(profileId: string): Promise<ToolStatus> {
    const profile = this.profiles.get(profileId);
    if (profile === undefined) throw new Error(`Unknown Agent Profile '${profileId}'.`);
    return {
      id: profile.id,
      displayName: `${profile.name} (${profile.adapter})`,
      installed: false,
    };
  }

  async listKnownFolders(): Promise<string[]> {
    return [];
  }

  private customModels = new Map<string, string[]>();

  async listCustomModels(adapter: string): Promise<string[]> {
    return [...(this.customModels.get(adapter) ?? [])];
  }

  async saveCustomModels(adapter: string, models: string[]): Promise<string[]> {
    const cleaned = [
      ...new Set(models.map((m) => m.trim()).filter((m) => m !== '')),
    ].slice(0, 50);
    this.customModels.set(adapter, cleaned);
    return cleaned;
  }

  async gitCurrentBranch(): Promise<string> {
    throw new Error('Branch detection needs the desktop app (browser mock).');
  }

  async gitBranches(): Promise<{ current: string; branches: string[] }> {
    throw new Error('Branch listing needs the desktop app (browser mock).');
  }

  async listMcpServers(): Promise<McpServerConfig[]> {
    return [...this.mcpServers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveMcpServer(server: McpServerConfig): Promise<McpServerConfig> {
    this.mcpServers.set(server.id, server);
    this.persist();
    return server;
  }

  async deleteMcpServer(id: string): Promise<boolean> {
    const removed = this.mcpServers.delete(id);
    this.persist();
    return removed;
  }

  async mcpListTools(): Promise<McpToolInfo[]> {
    return [{ name: 'example_tool', description: 'Mock tool (browser dev).' }];
  }

  async mcpEnvPresent(names: string[]): Promise<{ name: string; present: boolean }[]> {
    return names.map((name) => ({ name, present: false }));
  }

  async githubState(): Promise<GitHubState> {
    return { installed: false, authenticated: false };
  }

  private settings = new Map<string, string>();

  private automationUnsupported(): never {
    throw new Error('Automation APIs need the desktop app (browser mock).');
  }

  async listSchedules(): Promise<Schedule[]> {
    return [...this.schedules.values()];
  }

  async saveSchedule(schedule: Schedule): Promise<Schedule> {
    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  async deleteSchedule(id: string): Promise<boolean> {
    return this.schedules.delete(id);
  }

  async fireScheduleNow(): Promise<{ runId: string }> {
    this.automationUnsupported();
  }

  async schedulePreview(): Promise<string[]> {
    this.automationUnsupported();
  }

  async listWatchers(): Promise<Watcher[]> {
    return [...this.watchers.values()];
  }

  async saveWatcher(watcher: Watcher): Promise<Watcher> {
    this.watchers.set(watcher.id, watcher);
    return watcher;
  }

  async deleteWatcher(id: string): Promise<boolean> {
    return this.watchers.delete(id);
  }

  async workflowRisks(): Promise<RiskCategory[]> {
    return ['readOnly'];
  }

  async getRunFindings(): Promise<GroupedFinding[]> {
    return [];
  }

  async listNotifications(): Promise<Notification[]> {
    return [];
  }

  async markNotificationRead(): Promise<void> {}

  async markAllNotificationsRead(): Promise<void> {}

  async getNotificationPrefs(): Promise<NotificationPrefs> {
    return {
      onApproval: true,
      onFailure: true,
      onActionableFindings: true,
      onScheduledSuccess: false,
      onFeedbackNeedsAction: true,
    };
  }

  async setNotificationPrefs(): Promise<void> {}

  async getSetting(key: string): Promise<string | null> {
    return this.settings.get(key) ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
  }

  async diagnosticsBundle(): Promise<string> {
    return '{"mock": true, "note": "Diagnostics need the desktop app."}';
  }

  async roleMapDefault(): Promise<Record<string, string>> {
    return {};
  }

  async listTemplates(): Promise<{
    builtin: WorkflowTemplate[];
    user: WorkflowTemplate[];
  }> {
    return { builtin: [], user: [] };
  }

  async saveUserTemplate(): Promise<WorkflowTemplate> {
    this.automationUnsupported();
  }

  async saveWorkflowAsTemplate(): Promise<WorkflowTemplate> {
    this.automationUnsupported();
  }

  async deleteUserTemplate(): Promise<boolean> {
    this.automationUnsupported();
  }

  async exportTemplate(): Promise<string> {
    this.automationUnsupported();
  }

  async importTemplate(): Promise<WorkflowTemplate> {
    this.automationUnsupported();
  }

  async instantiateTemplate(): Promise<InstantiationPreview> {
    this.automationUnsupported();
  }

  async generateWorkflow(): Promise<GenerationPreview> {
    this.automationUnsupported();
  }

  async markGenerationStatus(): Promise<void> {}

  async listGenerations(): Promise<StoredGeneration[]> {
    return [];
  }

  async listPreferences(): Promise<Preference[]> {
    return [];
  }

  async savePreference(preference: Preference): Promise<Preference> {
    return preference;
  }

  async deletePreference(): Promise<boolean> {
    return false;
  }

  async resetMemory(): Promise<void> {}

  async exportMemory(): Promise<string> {
    return '[]';
  }

  async importMemory(): Promise<number> {
    return 0;
  }

  async observeEdits(): Promise<Preference[]> {
    return [];
  }
}

function mockInputDefaults(workflow: Workflow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const input of workflow.inputs ?? []) {
    if (input.default !== undefined) out[input.name] = input.default;
  }
  return out;
}

/**
 * Branch-aware mock order: walks from Start following first edges, except at
 * Condition nodes where the taken true/false edge is evaluated with the same
 * variable namespaces as the backend (workflow.*, input.*, node outputs).
 * This is a browser-dev approximation — the desktop engine is authoritative.
 */
function mockVariables(
  workflow: Workflow,
  priorResults: StoredNodeResult[],
  inputs: Record<string, string>,
): Record<string, string> {
  const vars: Record<string, string> = {
    'workflow.name': workflow.name,
    'workflow.id': workflow.id,
  };
  for (const input of workflow.inputs ?? []) {
    if (input.default !== undefined) vars[`input.${input.name}`] = input.default;
  }
  for (const [name, value] of Object.entries(inputs)) vars[`input.${name}`] = value;
  for (const r of priorResults) {
    vars[`node.${r.nodeId}`] = r.stdout;
    vars[`node.${r.nodeId}.output`] = r.stdout;
    vars[`node.${r.nodeId}.status`] = r.status;
    if (r.exitCode !== undefined) vars[`node.${r.nodeId}.exitCode`] = String(r.exitCode);
  }
  return vars;
}

function orderOf(
  workflow: Workflow,
  priorResults: StoredNodeResult[],
  inputs: Record<string, string>,
): string[] {
  const start = workflow.nodes.find((n) => n.type === 'start');
  if (start === undefined) return [];
  const vars = mockVariables(workflow, priorResults, inputs);
  const order: string[] = [];
  const visited = new Set<string>();
  let current: string | undefined = start.id;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    order.push(current);
    const node = workflow.nodes.find((n) => n.id === current);
    if (node?.type === 'end') break;
    const outgoing = workflow.edges.filter((e) => e.source === current);
    if (node?.type === 'condition' && node.config.condition !== undefined) {
      let branch = 'false';
      try {
        branch = evalCondition(node.config.condition, vars) ? 'true' : 'false';
      } catch {
        /* Upstream results may not exist yet; the path is recomputed after each node. */
      }
      const norm = (label?: string): string => (label ?? '').trim().toLowerCase();
      const aliases: Record<string, string[]> = {
        true: ['true', 'yes', 'on true'],
        false: ['false', 'no', 'on false'],
      };
      current =
        outgoing.find((e) => (aliases[branch] ?? []).includes(norm(e.label)))?.target ??
        outgoing[0]?.target;
      continue;
    }
    current = outgoing[0]?.target;
  }
  return order;
}

let cached: Backend | null = null;

export function getBackend(): Backend {
  if (cached === null) {
    cached = isTauri() ? new TauriBackend() : new MockBackend();
  }
  return cached;
}

/** Test hook: force a fresh mock backend. */
export function __setMockBackendForTests(): MockBackend {
  const mock = new MockBackend();
  cached = mock;
  return mock;
}
