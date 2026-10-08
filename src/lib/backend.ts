import {
  validateRunOptions,
  recoveryPlan,
  recoveryInvalidated,
  isEffectful,
  resultMetadata,
  replayGraph,
  reportedSpend,
  type RunOptions,
  type RecoveryChoice,
  type RecoveryPlan,
} from './run-controls';
import { errorMessage } from './errors';
import {
  projectScope,
  projectKey,
  projectContext,
  validatePreference,
  validateObservation,
  observeEdit,
} from './memory';
import {
  builtinTemplates,
  instantiateTemplateLocal,
  importTemplateDocument,
  validateTemplate,
} from './templates';
import { readLocal, writeLocal } from './storage';
import {
  encodeDocument,
  decodeDocument,
  type DocumentSession,
} from './workflow-document';
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
  structuredOutputConflict,
  composeAgentContext,
  renderPromptStrict,
  validateSessionProfile,
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
  WorkflowAssistance,
  InstantiationPreview,
  Preference,
  ProjectMemoryContext,
  StoredGeneration,
  WorkflowTemplate,
} from './generation';
import { prepareWatcherSave, validateWatcher, validateWatcherScope } from './scheduler';
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
  encodeWorkflowDocument(workflow: Workflow): Promise<DocumentSession>;
  decodeWorkflowDocument(
    json: string,
    base?: Workflow,
    nodeIds?: Record<string, string>,
  ): Promise<Workflow>;
  listWorkflows(): Promise<StoredWorkflow[]>;
  getWorkflow(id: string): Promise<StoredWorkflow | null>;
  saveWorkflow(workflow: Workflow): Promise<StoredWorkflow>;
  deleteWorkflow(id: string): Promise<boolean>;
  validateWorkflow(workflow: Workflow): Promise<ValidationIssue[]>;
  detectTools(): Promise<ToolStatus[]>;
  runWorkflow(
    workflowId: string,
    inputs?: Record<string, string>,
    options?: RunOptions,
  ): Promise<{ runId: string }>;
  previewRecovery(runId: string): Promise<RecoveryPlan>;
  recoverRun(
    runId: string,
    choices: Record<string, RecoveryChoice>,
    fingerprint: string,
    requestId: string,
  ): Promise<{ runId: string }>;
  continueSpendRun(runId: string, expectedPauseId: number, limit?: number): Promise<void>;
  cancelRun(runId: string): Promise<boolean>;
  approveRun(
    runId: string,
    approved: boolean,
    note?: string,
    expectedApprovalId?: number,
  ): Promise<void>;
  getRun(runId: string): Promise<StoredRun | null>;
  getRunWorkflow(runId: string): Promise<Workflow | null>;
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
  watcherScopeIssues(watcher: Watcher): Promise<string[]>;
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
    assistance?: WorkflowAssistance,
  ): Promise<GenerationPreview>;
  markGenerationStatus(id: string, status: string): Promise<void>;
  listGenerations(limit?: number): Promise<StoredGeneration[]>;
  getProjectMemoryContext(repoDir?: string): Promise<ProjectMemoryContext>;
  saveProjectPreference(
    repoDir: string,
    field: string,
    value: Preference['value'],
    note: string,
  ): Promise<Preference>;
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

  encodeWorkflowDocument(workflow: Workflow): Promise<DocumentSession> {
    return this.invoke('encode_workflow_document', { workflow });
  }
  decodeWorkflowDocument(
    json: string,
    base?: Workflow,
    nodeIds?: Record<string, string>,
  ): Promise<Workflow> {
    return this.invoke('decode_workflow_document', { json, base, nodeIds });
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
    options?: RunOptions,
  ): Promise<{ runId: string }> {
    return this.invoke('run_workflow', {
      workflowId,
      inputs: inputs ?? {},
      options: options ?? {},
    });
  }
  previewRecovery(runId: string): Promise<RecoveryPlan> {
    return this.invoke('preview_recovery', { runId });
  }
  recoverRun(
    runId: string,
    choices: Record<string, RecoveryChoice>,
    fingerprint: string,
    requestId: string,
  ): Promise<{ runId: string }> {
    return this.invoke('recover_run', { runId, choices, fingerprint, requestId });
  }
  continueSpendRun(
    runId: string,
    expectedPauseId: number,
    limit?: number,
  ): Promise<void> {
    return this.invoke('continue_spend_run', {
      runId,
      expectedPauseId,
      limit: limit ?? null,
    });
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
  getRun(runId: string): Promise<StoredRun | null> {
    return this.invoke('get_run', { runId });
  }
  getRunWorkflow(runId: string): Promise<Workflow | null> {
    return this.invoke('get_run_workflow', { runId });
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
  watcherScopeIssues(watcher: Watcher): Promise<string[]> {
    return this.invoke('watcher_scope_issues', { watcher });
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
    assistance?: WorkflowAssistance,
  ): Promise<GenerationPreview> {
    return this.invoke('generate_workflow', {
      profileId,
      goal,
      repoDir: repo?.dir ?? null,
      branch: repo?.branch ?? null,
      assistance: assistance ?? null,
    });
  }
  markGenerationStatus(id: string, status: string): Promise<void> {
    return this.invoke('mark_generation_status', { id, status });
  }
  listGenerations(limit = 50): Promise<StoredGeneration[]> {
    return this.invoke('list_generations', { limit });
  }
  getProjectMemoryContext(repoDir?: string): Promise<ProjectMemoryContext> {
    return this.invoke('get_project_memory_context', { repoDir: repoDir ?? null });
  }
  saveProjectPreference(
    repoDir: string,
    field: string,
    value: Preference['value'],
    note: string,
  ): Promise<Preference> {
    return this.invoke('save_project_preference', { repoDir, field, value, note });
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
  private preferences = new Map<string, Preference>();
  private observations = new Map<string, number>();
  private userTemplates = new Map<string, WorkflowTemplate>();
  private workflows = new Map<string, StoredWorkflow>();
  private runs: StoredRun[] = [];
  private results = new Map<string, StoredNodeResult[]>();
  private runWorkflows = new Map<string, Workflow>();
  private recoverySeeds = new Map<string, StoredNodeResult[]>();
  private recoveryRequests = new Map<
    string,
    { source: string; choices: Record<string, RecoveryChoice>; runId: string }
  >();
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

  async encodeWorkflowDocument(workflow: Workflow): Promise<DocumentSession> {
    return encodeDocument(workflow, [...this.profiles.values()]);
  }
  async decodeWorkflowDocument(
    json: string,
    base?: Workflow,
    nodeIds?: Record<string, string>,
  ): Promise<Workflow> {
    return decodeDocument(
      json,
      [...this.profiles.values()],
      await this.roleMapDefault(),
      base,
      nodeIds,
    );
  }
  private storageKey(): string {
    return 'orchevia.mock-backend.v1';
  }

  private load(): void {
    try {
      const raw = readLocal(this.storageKey());
      if (raw === null) return;
      const data = JSON.parse(raw) as {
        workflows: StoredWorkflow[];
        runs?: StoredRun[];
        results?: [string, StoredNodeResult[]][];
        runWorkflows?: [string, Workflow][];
        recoverySeeds?: [string, StoredNodeResult[]][];
        recoveryRequests?: [
          string,
          { source: string; choices: Record<string, RecoveryChoice>; runId: string },
        ][];
        counter?: number;
        profiles?: AgentProfile[];
        settings?: [string, string][];
        mcpServers?: McpServerConfig[];
        templates?: WorkflowTemplate[];
        preferences?: Preference[];
        observations?: [string, number][];
      };
      this.runs = data.runs ?? [];
      this.results = new Map(data.results ?? []);
      this.runWorkflows = new Map(data.runWorkflows ?? []);
      this.recoverySeeds = new Map(data.recoverySeeds ?? []);
      this.recoveryRequests = new Map(data.recoveryRequests ?? []);
      this.counter = data.counter ?? this.runs.length + 1;
      for (const run of this.runs)
        if (run.status === 'running') {
          run.status = 'failed';
          run.finishedAt = new Date().toISOString();
          for (const row of this.results.get(run.id) ?? []) {
            if (row.status !== 'running') continue;
            row.status = 'failed';
            row.finishedAt = run.finishedAt;
            row.error = 'Application restarted before this attempt completed.';
            row.durationMs = Math.max(
              0,
              Date.parse(row.finishedAt) - Date.parse(row.startedAt),
            );
          }
        }
      for (const p of data.preferences ?? []) {
        validatePreference(p);
        this.preferences.set(p.key, p);
      }
      this.observations = new Map(data.observations ?? []);
      for (const t of data.templates ?? []) this.userTemplates.set(t.id, t);
      for (const w of data.workflows) this.workflows.set(w.id, w);
      for (const p of data.profiles ?? []) this.profiles.set(p.id, p);
      for (const [key, value] of data.settings ?? []) this.settings.set(key, value);
      for (const s of data.mcpServers ?? []) this.mcpServers.set(s.id, s);
    } catch {
      // Corrupt dev storage: start fresh.
    }
  }

  private persist(): void {
    try {
      writeLocal(
        this.storageKey(),
        JSON.stringify({
          runs: this.runs,
          results: [...this.results.entries()],
          runWorkflows: [...this.runWorkflows.entries()],
          recoverySeeds: [...this.recoverySeeds.entries()],
          recoveryRequests: [...this.recoveryRequests.entries()],
          counter: this.counter,
          preferences: [...this.preferences.values()],
          observations: [...this.observations.entries()],
          templates: [...this.userTemplates.values()],
          workflows: [...this.workflows.values()],
          profiles: [...this.profiles.values()],
          settings: [...this.settings.entries()],
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
      this.removeRunHistory(run.id);
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
    options?: RunOptions,
  ): Promise<{ runId: string }> {
    const wf = this.workflows.get(workflowId);
    if (wf === undefined) throw new Error(`Unknown workflow '${workflowId}'.`);
    const runOptions = options ?? {};
    validateRunOptions(wf.definition, runOptions);
    const structural = validateWorkflowLocal(wf.definition).filter(
      (i) => i.severity === 'error',
    );
    if (
      (runOptions.dryRun || typeof runOptions.spendLimitUsd === 'number') &&
      structural.length
    )
      throw new Error(structural.map((i) => i.message).join(' '));
    const effectiveInputs = { ...mockInputDefaults(wf.definition), ...(inputs ?? {}) };
    for (const input of wf.definition.inputs ?? []) {
      if (input.required && !(effectiveInputs[input.name] ?? '').trim())
        throw new Error(`Workflow input '${input.name}' is required.`);
    }
    const contextIssues = validateWorkflowLocal(wf.definition).filter(
      (issue) =>
        issue.severity === 'error' &&
        issue.code.startsWith('agent-') &&
        /session|context/.test(issue.code),
    );
    if (contextIssues.length)
      throw new Error(contextIssues.map((issue) => issue.message).join(' '));
    for (const node of wf.definition.nodes) {
      if (
        runOptions.dryRun ||
        node.type !== 'agent' ||
        node.config.sessionGroup === undefined
      )
        continue;
      const profile = this.profiles.get(node.config.agentProfileId ?? '');
      if (!profile) throw new Error('Unknown Agent Profile.');
      const errors = validateSessionProfile(profile);
      if (errors.length) throw new Error(errors.join(' '));
    }
    const runId = `run-mock-${String(this.counter++)}`;
    const run: StoredRun = {
      id: runId,
      workflowId,
      execution: { options: structuredClone(runOptions) },
      status: 'running',
      startedAt: new Date().toISOString(),
      inputs: { ...mockInputDefaults(wf.definition), ...(inputs ?? {}) },
    };
    this.runs.unshift(run);
    this.results.set(runId, []);
    const snapshot = structuredClone(wf.definition);
    this.runWorkflows.set(runId, snapshot);
    // Simulate async execution node by node.
    this.persist();
    void this.simulate(snapshot, runId);
    return { runId };
  }

  private async simulate(workflow: Workflow, runId: string): Promise<void> {
    try {
      await this.simulateInner(workflow, runId);
    } catch (error) {
      const run = this.runs.find((r) => r.id === runId);
      if (run?.status === 'running') {
        run.status = 'failed';
        run.finishedAt = new Date().toISOString();
        this.pushResult(runId, 'run', 'failed', errorMessage(error));
      }
    } finally {
      this.persist();
    }
  }
  private async simulateInner(workflow: Workflow, runId: string): Promise<void> {
    // Static reachability includes every condition branch. Only disconnected
    // nodes are skipped here; approval replay preserves their existing rows.
    const reachable = new Set<string>();
    const start = workflow.nodes.find((node) => node.type === 'start');
    const pending = start ? [start.id] : [];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined || reachable.has(id)) continue;
      reachable.add(id);
      for (const edge of workflow.edges) {
        if (edge.source === id) pending.push(edge.target);
      }
    }
    for (const node of workflow.nodes) {
      if (
        !reachable.has(node.id) &&
        !(this.results.get(runId) ?? []).some((row) => row.nodeId === node.id)
      ) {
        this.pushResult(runId, node.id, 'skipped', '');
      }
    }
    for (;;) {
      const run = this.runs.find((r) => r.id === runId);
      if (run === undefined || run.status !== 'running') return;
      const results = this.results.get(runId) ?? [];
      const graph = replayGraph(workflow, results);
      if (graph.error) throw new Error(graph.error);
      for (const id of graph.skipped) this.pushResult(runId, id, 'skipped', '');
      const nodeId = graph.ready[0];
      if (nodeId === undefined) break;
      const node = workflow.nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      const execution = run.execution;
      const choice = execution?.recoveryChoices?.[nodeId];
      const spend = reportedSpend(workflow, results, execution?.options.dryRun);
      if (
        typeof execution?.options.spendLimitUsd === 'number' &&
        spend.reportedUsd >= execution.options.spendLimitUsd &&
        isEffectful(node.type) &&
        choice !== 'reuse' &&
        choice !== 'skip'
      ) {
        const pause = this.pushResult(runId, '__spend_guard', 'guardPaused', '');
        execution.spendPause = { id: pause.id, reportedUsd: spend.reportedUsd };
        run.status = 'paused';
        this.persist();
        return;
      }
      if (isEffectful(node.type) && choice === 'skip') {
        this.pushResult(runId, nodeId, 'skipped', '');
        continue;
      }
      if (isEffectful(node.type) && choice === 'reuse') {
        const visit = graph.visits.get(nodeId) ?? 0;
        const seed = this.recoverySeeds.get(runId)?.filter((r) => r.nodeId === nodeId)[
          visit
        ];
        if (!seed)
          throw new Error('No reusable result for this visit; choose replay instead.');
        const row = this.pushResult(runId, nodeId, 'succeeded', seed.stdout);
        row.stderr = seed.stderr;
        row.durationMs = 0;
        const metadata = resultMetadata(seed);
        delete metadata.agentSession;
        delete metadata.agentUsage;
        delete metadata.agentActivity;
        row.structuredJson = JSON.stringify({
          ...metadata,
          reusedFrom: { runId: seed.runId, resultId: seed.id },
        });
        continue;
      }
      if (isEffectful(node.type) && execution?.options.dryRun) {
        const offset = results.filter(
          (r) =>
            r.nodeId === nodeId && ['succeeded', 'failed', 'retrying'].includes(r.status),
        ).length;
        const policy = node.config.retry;
        const attempts = Math.min(10, Math.max(1, policy?.maxAttempts ?? 1));
        for (let attempt = 1; attempt <= attempts; attempt++) {
          const fixture = execution.options.fixtures?.[nodeId]?.[offset + attempt - 1];
          if (!fixture) {
            const row = this.pushResult(runId, nodeId, 'failed', '');
            row.error =
              'Missing fixture for this visit/attempt. No real tool was executed.';
            break;
          }
          const status =
            fixture.status === 'succeeded'
              ? 'succeeded'
              : attempt === attempts
                ? 'failed'
                : 'retrying';
          const row = this.pushResult(runId, nodeId, status, fixture.stdout ?? '');
          row.stderr = fixture.stderr ?? '';
          row.attempt = attempt;
          row.durationMs = 0;
          row.exitCode = fixture.exitCode ?? (status === 'succeeded' ? 0 : 1);
          row.structuredJson = JSON.stringify({ ...fixture.structured, simulated: true });
          if (status !== 'retrying') break;
          const delay = Math.min(
            60000,
            (policy?.delayMs ?? 0) * (policy?.backoff ? 2 ** (attempt - 1) : 1),
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (this.runs.find((r) => r.id === runId)?.status !== 'running') return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        continue;
      }
      if (node.type === 'approval') {
        const seed = this.recoverySeeds.get(runId)?.filter((r) => r.nodeId === nodeId)[
          graph.visits.get(nodeId) ?? 0
        ];
        if (seed) {
          const row = this.pushResult(runId, nodeId, 'approved', seed.stdout);
          row.structuredJson = JSON.stringify({
            reusedFrom: { runId: seed.runId, resultId: seed.id },
          });
          continue;
        }
        const fixtures = execution?.options.dryRun
          ? execution.options.fixtures?.[nodeId]
          : undefined;
        if (fixtures) {
          const fixture = fixtures[graph.visits.get(nodeId) ?? 0];
          if (!fixture) throw new Error('Missing approval fixture for this visit.');
          if (fixture.status !== 'paused') {
            this.pushResult(runId, nodeId, fixture.status, fixture.stdout ?? '');
            continue;
          }
        }
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
        if (node.type === 'ticket') {
          const key = renderPromptStrict(
            node.config.ticketKey ?? '',
            mockVariables(workflow, results, run.inputs ?? {}),
          );
          if ('error' in key) {
            const row = this.pushResult(runId, nodeId, 'failed', '');
            row.error = key.error;
            run.status = 'failed';
            run.finishedAt = new Date().toISOString();
            return;
          }
          const row = this.pushResult(
            runId,
            nodeId,
            'succeeded',
            `Mock ticket ${key.rendered} (browser mock, no remote lookup).`,
          );
          row.structuredJson = JSON.stringify({
            simulated: true,
            ticket: {
              key: key.rendered,
              title: `Mock ticket ${key.rendered}`,
              description: 'Simulated ticket details.',
              status: 'Mock',
              url: '',
              acceptanceCriteria: [],
            },
          });
        } else {
          this.pushResult(
            runId,
            nodeId,
            'succeeded',
            `mock-integration$ ${node.type} node (browser mock, no processes spawned).`,
          );
        }
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
        try {
          const rows = this.results.get(runId) ?? [];
          const run = this.runs.find((r) => r.id === runId);
          const vars = mockVariables(
            workflow,
            rows.filter((row) => row.id !== live.id),
            run?.inputs ?? {},
          );
          const rendered = renderPromptStrict(node.config.prompt ?? '', vars);
          if ('error' in rendered) throw new Error(rendered.error);
          const prompt = composeAgentContext(
            rendered.rendered,
            node.config.contextRefs ?? [],
            node.config.contextMaxChars,
            rows,
          );
          if (node.config.sessionGroup !== undefined) {
            const errors = validateSessionProfile(profile);
            if (errors.length) throw new Error(errors.join(' '));
            const group = renderPromptStrict(node.config.sessionGroup, vars);
            if ('error' in group) throw new Error(group.error);
            if (
              !group.rendered.trim() ||
              Array.from(group.rendered).length > 256 ||
              /[\0\r\n]/.test(group.rendered)
            )
              throw new Error(
                'Session group must be 1-256 characters without line breaks.',
              );
            // Browser-only approximation: normalize path components, not filesystem symlinks.
            const dir =
              profile.workingDirMode === 'profile'
                ? profile.workingDir
                : profile.workingDirMode === 'inherit'
                  ? ''
                  : (node.config.workingDir ?? workflow.defaults?.repoDir);
            const key = JSON.stringify([
              Object.fromEntries(
                Object.entries(profile).sort(([a], [b]) => a.localeCompare(b)),
              ),
              mockDirectory(dir ?? ''),
              group.rendered,
            ]);
            const previous = rows
              .filter((row) => row.id !== live.id)
              .slice()
              .reverse()
              .map((row) => {
                try {
                  return {
                    row,
                    data: JSON.parse(row.structuredJson ?? '{}') as {
                      agentSession?: {
                        key: string;
                        id: string;
                        usable: boolean;
                        turn: number;
                      };
                    },
                  };
                } catch {
                  return { row, data: {} };
                }
              })
              .find((entry) => entry.data.agentSession?.key === key);
            const prior = previous?.data.agentSession;
            const reused =
              previous?.row.status === 'succeeded' &&
              prior?.usable === true &&
              prior.turn > 0 &&
              prior.turn < (node.config.sessionMaxTurns ?? 4);
            live.structuredJson = JSON.stringify({
              simulated: true,
              agentSession: {
                key,
                group: group.rendered,
                id: reused ? prior.id : `mock-session-${String(this.counter++)}`,
                turn: reused ? prior.turn + 1 : 1,
                reused,
                usable: true,
              },
            });
          }
          this.completeResult(
            live,
            'succeeded',
            `mock-agent$ ${profile.adapter} "${prompt}"\nHello from Orchevia (browser mock, profile '${profile.name}').`,
          );
        } catch (error) {
          this.completeResult(live, 'failed', '');
          live.error = errorMessage(error);
          const run = this.runs.find((r) => r.id === runId);
          if (run) {
            run.status = 'failed';
            run.finishedAt = new Date().toISOString();
          }
          this.persist();
          return;
        }
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
    this.persist();
    return result;
  }

  private completeResult(result: StoredNodeResult, status: string, stdout: string): void {
    result.status = status;
    result.stdout = stdout;
    result.finishedAt = new Date().toISOString();
    if (status === 'succeeded') result.exitCode = 0;
    const severity = ['P0', 'P1', 'P2', 'P3'].find((level) =>
      new RegExp(`(?<![a-zA-Z0-9_])${level}(?![a-zA-Z0-9_])`).test(stdout),
    );
    if (severity) {
      const data: unknown = JSON.parse(result.structuredJson ?? '{}');
      result.structuredJson = JSON.stringify({
        ...(typeof data === 'object' && data !== null ? data : {}),
        severity,
      });
    }
  }

  private pushResult(
    runId: string,
    nodeId: string,
    status: string,
    stdout: string,
  ): StoredNodeResult {
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
    this.persist();
    return result;
  }

  async previewRecovery(runId: string): Promise<RecoveryPlan> {
    const run = this.runs.find((r) => r.id === runId);
    if (!run || run.status !== 'failed')
      throw new Error('Only failed runs can be recovered.');
    const workflow = this.runWorkflows.get(runId);
    if (!workflow) throw new Error('Run snapshot is unavailable.');
    return recoveryPlan(run, workflow, this.results.get(runId) ?? []);
  }
  async recoverRun(
    runId: string,
    choices: Record<string, RecoveryChoice>,
    fingerprint: string,
    requestId: string,
  ): Promise<{ runId: string }> {
    if (!requestId.trim() || requestId.length > 200)
      throw new Error('Recovery request id is required (up to 200 characters).');
    const plan = await this.previewRecovery(runId);
    if (
      plan.fingerprint !== fingerprint ||
      Object.keys(choices).length !== plan.nodes.length
    )
      throw new Error('Recovery plan changed or a step decision is missing.');
    for (const node of plan.nodes)
      if (!node.choices.includes(choices[node.nodeId] ?? ('invalid' as RecoveryChoice)))
        throw new Error(`Invalid recovery decision for '${node.label}'.`);
    const source = this.runs.find((r) => r.id === runId);
    const workflow = this.runWorkflows.get(runId);
    if (!source || source.status !== 'failed' || !workflow)
      throw new Error('Source run is unavailable.');
    const rows = this.results.get(runId) ?? [];
    const changed = Object.entries(choices)
      .filter(([, choice]) => choice !== 'reuse')
      .map(([id]) => id);
    const expanded = recoveryPlan(source, workflow, rows, changed);
    if (expanded.nodes.some((n) => n.affected && choices[n.nodeId] === 'reuse'))
      throw new Error('Cannot reuse output that depends on replayed or skipped work.');
    const existing = this.recoveryRequests.get(requestId);
    if (existing) {
      if (
        existing.source !== runId ||
        Object.keys(existing.choices).length !== Object.keys(choices).length ||
        Object.entries(choices).some(([id, choice]) => existing.choices[id] !== choice)
      )
        throw new Error('Recovery request already used with different decisions.');
      return { runId: existing.runId };
    }
    const childId = `run-mock-${String(this.counter++)}`;
    const execution = {
      options: structuredClone(source.execution?.options ?? {}),
      recoveredFrom: runId,
      recoveryChoices: { ...choices },
    };
    this.runs.unshift({
      id: childId,
      workflowId: source.workflowId,
      status: 'running',
      startedAt: new Date().toISOString(),
      inputs: { ...source.inputs },
      execution,
    });
    this.results.set(childId, []);
    this.runWorkflows.set(childId, structuredClone(workflow));
    const invalidated = recoveryInvalidated(workflow, rows, changed);
    this.recoverySeeds.set(
      childId,
      structuredClone(
        rows.filter(
          (r) =>
            (r.status === 'succeeded' && choices[r.nodeId] === 'reuse') ||
            (r.status === 'approved' &&
              !invalidated.has(r.nodeId) &&
              workflow.nodes.some((n) => n.id === r.nodeId && n.type === 'approval')),
        ),
      ),
    );
    this.recoveryRequests.set(requestId, {
      source: runId,
      choices: { ...choices },
      runId: childId,
    });
    this.persist();
    void this.simulate(workflow, childId);
    return { runId: childId };
  }
  async continueSpendRun(
    runId: string,
    expectedPauseId: number,
    limit?: number,
  ): Promise<void> {
    const run = this.runs.find((r) => r.id === runId);
    const execution = run?.execution;
    const pause = execution?.spendPause;
    if (run?.status !== 'paused' || !pause || pause.id !== expectedPauseId)
      throw new Error('Run is not paused at this spend guard.');
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= pause.reportedUsd))
      throw new Error('New spend limit must exceed the current reported total.');
    const workflow = this.runWorkflows.get(runId);
    if (!workflow) throw new Error('Run snapshot is unavailable.');
    if (limit === undefined) delete execution.options.spendLimitUsd;
    else execution.options.spendLimitUsd = limit;
    delete execution.spendPause;
    run.status = 'running';
    delete run.finishedAt;
    this.pushResult(runId, '__spend_guard', 'guardContinued', '');
    this.persist();
    void this.simulate(workflow, runId);
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
    this.persist();
    return true;
  }

  async approveRun(
    runId: string,
    approved: boolean,
    note?: string,
    expectedApprovalId?: number,
  ): Promise<void> {
    const run = this.runs.find((r) => r.id === runId);
    if (
      run === undefined ||
      run.status !== 'paused' ||
      run.execution?.spendPause !== undefined
    ) {
      throw new Error(`Run '${runId}' is not paused.`);
    }
    const list = this.results.get(runId) ?? [];
    const paused = [...list].reverse().find((r) => r.status === 'paused');
    if (paused === undefined) throw new Error('No pending approval.');
    if (expectedApprovalId !== undefined && paused.id !== expectedApprovalId) {
      throw new Error('Approval changed. Refresh the run before deciding.');
    }
    this.pushResult(runId, paused.nodeId, approved ? 'approved' : 'rejected', note ?? '');
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

  async getRun(runId: string): Promise<StoredRun | null> {
    return structuredClone(this.runs.find((r) => r.id === runId) ?? null);
  }
  async getRunWorkflow(runId: string): Promise<Workflow | null> {
    const run = this.runs.find((r) => r.id === runId);
    if (run === undefined) return null;
    return structuredClone(
      this.runWorkflows.get(runId) ??
        this.workflows.get(run.workflowId)?.definition ??
        null,
    );
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
    this.removeRunHistory(runId);
    this.persist();
    return true;
  }

  private removeRunHistory(runId: string): void {
    this.results.delete(runId);
    this.runWorkflows.delete(runId);
    this.recoverySeeds.delete(runId);
    for (const [requestId, request] of this.recoveryRequests) {
      if (request.runId === runId) this.recoveryRequests.delete(requestId);
    }
  }

  async clearFinishedRuns(): Promise<{ removed: number; kept: number }> {
    const kept = this.runs.filter((r) => r.status === 'running' || r.status === 'paused');
    const removed = this.runs.length - kept.length;
    const keepIds = new Set(kept.map((r) => r.id));
    for (const id of [...this.results.keys()]) {
      if (!keepIds.has(id)) {
        this.removeRunHistory(id);
      }
    }
    this.runs = kept;
    this.persist();
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
        notes:
          'Uses `claude -p --output-format stream-json --verbose` with the prompt on stdin, so runs report tokens and USD. Model via `--model`.',
      },
      {
        id: 'codex',
        displayName: 'Codex',
        defaultExecutable: 'codex',
        supportsModelFlag: true,
        supportsSessionResume: true,
        notes:
          'Uses `codex exec --json -` with the prompt on stdin, so runs report tokens. Model via `--model`. Non-interactive.',
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
    return [...this.profiles.values()].sort((a, b) => {
      // SQLite uses BINARY name order; locale collation chooses different defaults.
      const encoder = new TextEncoder();
      const left = encoder.encode(a.name);
      const right = encoder.encode(b.name);
      for (let i = 0; i < Math.min(left.length, right.length); i++) {
        const difference = (left[i] ?? 0) - (right[i] ?? 0);
        if (difference !== 0) return difference;
      }
      return left.length - right.length;
    });
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
    // Mirrors agents.rs build_agent_command: Claude/Codex read the prompt from
    // stdin, structured unless the profile's own arguments pick a format.
    const structured =
      profile.adapter !== 'custom' && structuredOutputConflict(profile) === null;
    const args: string[] =
      profile.adapter === 'claude'
        ? [
            '-p',
            '--output-format',
            ...(structured ? ['stream-json', '--verbose'] : ['text']),
          ]
        : profile.adapter === 'codex'
          ? structured
            ? ['exec', '--json']
            : ['exec']
          : [];
    if ((profile.model ?? '').trim() !== '') {
      args.push('--model', (profile.model ?? '').trim());
    }
    const effort = (profile.effort ?? '').trim().toLowerCase();
    if (effort !== '' && profile.adapter === 'claude') args.push('--effort', effort);
    if (effort !== '' && profile.adapter === 'codex') {
      args.push('-c', `model_reasoning_effort="${effort}"`);
    }
    if (profile.adapter === 'codex' && !structured) args.push('-');
    args.push(...profile.extraArgs);
    if (profile.adapter === 'codex' && structured) args.push('-');
    if (profile.adapter === 'custom') args.push(effectivePrompt);
    const stdinNote =
      profile.adapter === 'custom'
        ? []
        : [`<prompt via stdin, ${String(Array.from(effectivePrompt).length)} chars>`];
    return {
      executable: exe,
      args,
      preview: [
        exe,
        ...args.map((a) => (a.includes(' ') ? `'${a}'` : a)),
        ...stdinNote,
      ].join(' '),
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
    return [...this.watchers.values()].map((watcher) => ({ ...watcher }));
  }

  async saveWatcher(watcher: Watcher): Promise<Watcher> {
    const errors = validateWatcher(watcher);
    if (errors.length > 0) throw new Error(`Invalid watcher: ${errors.join('; ')}`);
    if (watcher.enabled && !this.workflows.has(watcher.workflowId))
      throw new Error(`Unknown workflow '${watcher.workflowId}'.`);
    if (watcher.enabled) {
      const scopeIssues = await this.watcherScopeIssues(watcher);
      if (scopeIssues.length > 0) throw new Error(scopeIssues.join('; '));
    }
    const saved = prepareWatcherSave(watcher, this.watchers.get(watcher.id));
    this.watchers.set(watcher.id, saved);
    return { ...saved };
  }

  async watcherScopeIssues(watcher: Watcher): Promise<string[]> {
    const workflow = this.workflows.get(watcher.workflowId)?.definition;
    if (workflow === undefined) return [`Unknown workflow '${watcher.workflowId}'.`];
    try {
      return validateWatcherScope(workflow, watcher, [...this.profiles.values()]);
    } catch (err: unknown) {
      return [errorMessage(err)];
    }
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
    this.validateSettingKey(key);
    return this.settings.get(key) ?? null;
  }

  private validateSettingKey(key: string): void {
    if (
      ![
        'background.mode',
        'notifications.os',
        'scheduler.intervalSecs',
        'ui.theme',
        'onboarding.completed',
        'workflow.assistanceProfileId',
      ].includes(key)
    )
      throw new Error(`Setting '${key}' is not user-configurable.`);
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.validateSettingKey(key);
    if (key === 'scheduler.intervalSecs') {
      if (!/^\d+$/.test(value)) throw new Error('Interval must be a number.');
      const secs = Number(value);
      if (secs < 30 || secs > 3600)
        throw new Error('Scheduler interval must be 30–3600 s.');
    }
    if (new TextEncoder().encode(value).length > 200)
      throw new Error('Setting value too long.');
    this.settings.set(key, value);
    this.persist();
  }

  async diagnosticsBundle(): Promise<string> {
    return '{"mock": true, "note": "Diagnostics need the desktop app."}';
  }

  async roleMapDefault(): Promise<Record<string, string>> {
    const roles: Record<string, string> = {};
    for (const p of await this.listAgentProfiles())
      if (p.role && !Object.hasOwn(roles, p.role)) roles[p.role] = p.id;
    for (const p of this.preferences.values()) {
      if (
        !p.enabled ||
        p.scope !== '*' ||
        !['manual', 'accepted'].includes(p.source) ||
        typeof p.value !== 'string' ||
        !this.profiles.has(p.value)
      )
        continue;
      const role =
        /^role\.(planning|implementation|fastReview|deepReview|workflowGenerator)\.profile$/.exec(
          p.key,
        )?.[1];
      if (role) roles[role] = p.value;
    }
    return roles;
  }
  async listTemplates(): Promise<{
    builtin: WorkflowTemplate[];
    user: WorkflowTemplate[];
  }> {
    return {
      builtin: builtinTemplates(),
      user: structuredClone([...this.userTemplates.values()]),
    };
  }
  async saveUserTemplate(template: WorkflowTemplate): Promise<WorkflowTemplate> {
    validateTemplate(template);
    this.userTemplates.set(template.id, structuredClone(template));
    this.persist();
    return structuredClone(template);
  }
  async saveWorkflowAsTemplate(
    workflowId: string,
    name: string,
    category?: string,
  ): Promise<WorkflowTemplate> {
    const stored = this.workflows.get(workflowId);
    if (!stored) throw new Error(`Unknown workflow '${workflowId}'.`);
    return this.saveUserTemplate({
      id: 'user-' + crypto.randomUUID(),
      version: 1,
      name,
      category: category ?? 'general',
      description: `Saved from workflow '${stored.name}'.`,
      workflow: structuredClone(stored.definition),
    });
  }
  async deleteUserTemplate(id: string): Promise<boolean> {
    const deleted = this.userTemplates.delete(id);
    this.persist();
    return deleted;
  }
  private findTemplate(id: string, builtin: boolean): WorkflowTemplate {
    const t = builtin
      ? builtinTemplates().find((t) => t.id === id)
      : this.userTemplates.get(id);
    if (!t) throw new Error(`Unknown template '${id}'.`);
    return t;
  }
  async exportTemplate(id: string, builtin: boolean): Promise<string> {
    const t = this.findTemplate(id, builtin);
    validateTemplate(t);
    return JSON.stringify(
      {
        ...t,
        workflow: JSON.parse(
          (await this.encodeWorkflowDocument(t.workflow)).json,
        ) as unknown,
      },
      null,
      2,
    );
  }
  async importTemplate(json: string): Promise<WorkflowTemplate> {
    const template = importTemplateDocument(json, await this.listAgentProfiles());
    template.id = 'user-' + crypto.randomUUID();
    return this.saveUserTemplate(template);
  }
  async instantiateTemplate(
    id: string,
    builtin: boolean,
    roleMap?: Record<string, string>,
  ): Promise<InstantiationPreview> {
    return instantiateTemplateLocal(
      this.findTemplate(id, builtin),
      roleMap ?? (await this.roleMapDefault()),
    );
  }

  async generateWorkflow(): Promise<GenerationPreview> {
    this.automationUnsupported();
  }

  async markGenerationStatus(): Promise<void> {}

  async listGenerations(): Promise<StoredGeneration[]> {
    return [];
  }

  async getProjectMemoryContext(repoDir?: string): Promise<ProjectMemoryContext> {
    return projectContext(
      [...this.preferences.values()],
      repoDir?.trim() ? projectScope(repoDir) : undefined,
    );
  }
  async saveProjectPreference(
    repoDir: string,
    field: string,
    value: Preference['value'],
    note: string,
  ): Promise<Preference> {
    const scope = projectScope(repoDir);
    return this.savePreference({
      key: projectKey(scope, field),
      scope,
      value,
      source: 'manual',
      enabled: true,
      note,
    });
  }
  async listPreferences(): Promise<Preference[]> {
    return structuredClone(
      [...this.preferences.values()].sort((a, b) => a.key.localeCompare(b.key)),
    );
  }
  private checkPreference(preference: Preference): void {
    validatePreference(preference);
    const previous = this.preferences.get(preference.key);
    if (
      previous &&
      previous.scope !== preference.scope &&
      (previous.scope.startsWith('repo:') || preference.scope.startsWith('repo:'))
    )
      throw new Error('Project preference key collision; nothing imported.');
  }
  async savePreference(preference: Preference): Promise<Preference> {
    this.checkPreference(preference);
    this.preferences.set(preference.key, structuredClone(preference));
    this.persist();
    return structuredClone(preference);
  }
  async deletePreference(key: string): Promise<boolean> {
    const deleted = this.preferences.delete(key);
    this.persist();
    return deleted;
  }
  async resetMemory(): Promise<void> {
    this.preferences.clear();
    this.observations.clear();
    this.persist();
  }
  async exportMemory(): Promise<string> {
    return JSON.stringify(await this.listPreferences(), null, 2);
  }
  async importMemory(json: string): Promise<number> {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length > 200)
      throw new Error('Invalid preferences JSON (max 200).');
    const preferences = parsed.map((p: unknown) => {
      if (p === null || typeof p !== 'object' || Array.isArray(p))
        throw new Error('Preference must be an object.');
      return {
        scope: '*',
        source: 'accepted',
        enabled: true,
        note: '',
        ...p,
      } as Preference;
    });
    const keys = new Set<string>();
    for (const p of preferences) {
      this.checkPreference(p);
      if (keys.has(p.key)) throw new Error('Duplicate preference key in import.');
      keys.add(p.key);
    }
    for (const p of preferences) this.preferences.set(p.key, structuredClone(p));
    this.persist();
    return preferences.length;
  }
  async observeEdits(observations: EditObservation[]): Promise<Preference[]> {
    const limited = observations.slice(0, 20);
    for (const o of limited) validateObservation(o);
    const fresh: Preference[] = [];
    for (const o of limited) {
      const suggestion = observeEdit(
        this.observations,
        [...this.preferences.values()],
        o,
      );
      if (suggestion) {
        await this.savePreference(suggestion);
        fresh.push(suggestion);
      }
    }
    this.persist();
    return fresh;
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
  const visits = new Map<string, number>();
  for (const r of priorResults) {
    vars[`node.${r.nodeId}`] = r.stdout;
    vars[`node.${r.nodeId}.output`] = r.stdout;
    vars[`node.${r.nodeId}.status`] = r.status;
    if (r.exitCode !== undefined) vars[`node.${r.nodeId}.exitCode`] = String(r.exitCode);
    if (['succeeded', 'failed', 'approved', 'rejected'].includes(r.status))
      visits.set(r.nodeId, (visits.get(r.nodeId) ?? 0) + 1);
    try {
      const data = JSON.parse(r.structuredJson ?? '{}') as {
        severity?: unknown;
        ticket?: Record<string, unknown>;
      };
      if (typeof data.severity === 'string')
        vars[`node.${r.nodeId}.severity`] = data.severity;
      if (r.status === 'succeeded' && data.ticket) {
        for (const field of ['key', 'title', 'description', 'status'])
          vars[`ticket.${field}`] =
            typeof data.ticket[field] === 'string' ? data.ticket[field] : '';
        vars['ticket.url'] =
          typeof data.ticket.browseUrl === 'string'
            ? data.ticket.browseUrl
            : typeof data.ticket.url === 'string'
              ? data.ticket.url
              : '';
        vars['ticket.acceptanceCriteria'] = Array.isArray(data.ticket.acceptanceCriteria)
          ? data.ticket.acceptanceCriteria
              .filter((item: unknown) => typeof item === 'string')
              .join('\n')
          : '';
      }
    } catch {
      /* Malformed metadata supplies no structured aliases. */
    }
  }
  for (const [id, count] of visits) vars[`node.${id}.visits`] = String(count);
  return vars;
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

function mockDirectory(dir: string): string {
  const parts: string[] = [];
  for (const part of dir.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part !== '..' || !dir.startsWith('/')) parts.push(part);
  }
  return `${dir.startsWith('/') ? '/' : ''}${parts.join('/')}`;
}
