import { describe, expect, it } from 'vitest';
import { __setMockBackendForTests } from './backend';
import { createDefaultProfile } from './agents';
import {
  RISK_LABELS,
  fromLocalInputValue,
  oneTimeCompleted,
  oneTimeSpent,
  prepareScheduleSave,
  scheduleTrustError,
  toLocalInputValue,
  validateSchedule,
  workflowConsumesPrNumber,
  workflowRisks,
  type Schedule,
  type Watcher,
} from './scheduler';
import { createEmptyWorkflow } from './workflow';

const watcher: Watcher = {
  id: 'watch',
  name: 'Requested',
  workflowId: 'wf',
  kind: 'reviewRequested',
  repoDir: '/repo',
  enabled: false,
  checkIntervalSecs: 900,
};

describe('mock watcher saves', () => {
  it('rejects invalid intervals and missing enabled workflows like the desktop', async () => {
    const backend = __setMockBackendForTests();
    await expect(
      backend.saveWatcher({ ...watcher, checkIntervalSecs: 10 }),
    ).rejects.toThrow('interval');
    await expect(backend.saveWatcher({ ...watcher, enabled: true })).rejects.toThrow(
      'Unknown workflow',
    );
  });

  it('preserves checked revisions on an edit but resets the check when re-enabled', async () => {
    const backend = __setMockBackendForTests();
    const workflow = createEmptyWorkflow('Watcher');
    workflow.id = 'wf';
    await backend.saveWorkflow(workflow);
    await backend.saveWatcher({
      ...watcher,
      enabled: true,
      lastCheckedAt: '2026-10-05T13:21:24Z',
      lastHeadSha: 'a',
      lastResult: 'quiet',
    });
    const edited = await backend.saveWatcher({
      ...watcher,
      enabled: true,
      name: 'Renamed',
    });
    expect(edited.lastHeadSha).toBe('a');
    expect(edited.lastCheckedAt).toBe('2026-10-05T13:21:24Z');
    await backend.saveWatcher({ ...edited, enabled: false });
    const enabled = await backend.saveWatcher({ ...edited, enabled: true });
    expect(enabled.lastCheckedAt).toBeUndefined();
    expect(enabled.lastHeadSha).toBe('a');
  });

  it('resets old scope state when the watched repository changes', async () => {
    const backend = __setMockBackendForTests();
    const initial = await backend.saveWatcher({
      ...watcher,
      lastCheckedAt: '2026-10-05T13:21:24Z',
      lastHeadSha: 'a',
    });
    const changed = await backend.saveWatcher({ ...initial, repoDir: '/other' });
    expect(changed.lastHeadSha).toBeUndefined();
    expect(changed.lastCheckedAt).toBeUndefined();
  });
});

describe('watcher dispatch scope', () => {
  it('uses consumed PR inputs rather than declarations or escaped text', () => {
    const workflow = createEmptyWorkflow('Scanner');
    workflow.inputs = [{ name: 'prNumber' }];
    expect(workflowConsumesPrNumber(workflow)).toBe(false);
    workflow.nodes.push({
      id: 'consumer',
      type: 'mcp',
      position: { x: 0, y: 0 },
      config: { mcpArgs: { pr: String.raw`\{{input.prNumber}}` } },
    });
    expect(workflowConsumesPrNumber(workflow)).toBe(false);
    workflow.nodes.at(-1)!.config.mcpArgs = { pr: '{{input.prNumber}}' };
    expect(workflowConsumesPrNumber(workflow)).toBe(false);
    workflow.edges.push({
      id: 'consume',
      source: workflow.nodes[0]!.id,
      target: 'consumer',
    });
    expect(workflowConsumesPrNumber(workflow)).toBe(true);
  });
});

it('does not treat a literal condition right operand as a PR input', () => {
  const workflow = createEmptyWorkflow('Scanner');
  workflow.nodes.push({
    id: 'condition',
    type: 'condition',
    position: { x: 0, y: 0 },
    config: {},
  });
  workflow.edges.push({
    id: 'to-condition',
    source: workflow.nodes[0]!.id,
    target: 'condition',
  });
  workflow.nodes.at(-1)!.config.condition = {
    logic: 'and',
    clauses: [{ left: 'workflow.name', op: 'equals', right: 'input.prNumber' }],
  };
  expect(workflowConsumesPrNumber(workflow)).toBe(false);
  workflow.nodes.at(-1)!.config.condition!.clauses[0]!.right = '{{input.prNumber}}';
  expect(workflowConsumesPrNumber(workflow)).toBe(false);
});

it('rejects a watcher targeting a different repository from its native PR nodes', async () => {
  const backend = __setMockBackendForTests();
  const workflow = createEmptyWorkflow('Review');
  workflow.id = 'wf';
  workflow.nodes.push({
    id: 'pr',
    type: 'github',
    position: { x: 0, y: 0 },
    config: { workingDir: '/different', githubOp: { op: 'prDetails', number: 0 } },
  });
  await backend.saveWorkflow(workflow);
  await expect(backend.saveWatcher({ ...watcher, enabled: true })).rejects.toThrow(
    'repository',
  );
});

describe('schedule trust', () => {
  it('lists a full-access agent profile as its own risk and needs trust', async () => {
    const backend = __setMockBackendForTests();
    const profile = {
      ...createDefaultProfile('claude'),
      id: 'prof-full',
      permissionLevel: 'fullAccess' as const,
    };
    await backend.saveAgentProfile(profile);
    const workflow = createEmptyWorkflow('Unattended');
    workflow.id = 'wf-full';
    workflow.nodes.push({
      id: 'agent',
      type: 'agent',
      position: { x: 80, y: 200 },
      config: { agentProfileId: 'prof-full', prompt: 'Work' },
    });
    await backend.saveWorkflow(workflow);
    expect(await backend.workflowRisks(workflow)).toEqual([
      'readOnly',
      'localWrite',
      'externalTool',
      'fullAccessAgent',
    ]);
    const schedule: Schedule = {
      id: 'sched',
      name: 'Nightly',
      workflowId: 'wf-full',
      kind: { kind: 'daily', hour: 2, minute: 0 },
      timezone: 'UTC',
      enabled: true,
      trusted: false,
      missedPolicy: 'skip',
    };
    await expect(backend.saveSchedule(schedule)).rejects.toThrow(
      RISK_LABELS.fullAccessAgent,
    );
    await expect(backend.saveSchedule({ ...schedule, trusted: true })).resolves.toEqual({
      ...schedule,
      trusted: true,
    });
    // Disabled schedules never need trust; ordinary profiles add no full-access risk.
    await backend.saveAgentProfile({ ...profile, permissionLevel: 'cliSettings' });
    expect(workflowRisks(workflow, await backend.listAgentProfiles())).not.toContain(
      'fullAccessAgent',
    );
    expect(scheduleTrustError(createEmptyWorkflow('Read only'), [], false)).toBeNull();
  });
});

describe('schedule saves (mirror of Schedule::prepare_save)', () => {
  const stored: Schedule = {
    id: 's',
    name: 'Review PRs',
    workflowId: 'wf',
    kind: { kind: 'interval', everySecs: 3600 },
    timezone: 'local',
    enabled: true,
    trusted: true,
    missedPolicy: 'skip',
    lastRunAt: '2026-10-22T16:00:00Z',
    lastStatus: 'deferred: run limit reached',
    nextRunAt: '2026-10-22T17:00:00Z',
    deferredSlot: '2026-10-22T17:00:00Z',
  };

  it('keeps the slot and bookkeeping for edits that keep the timing', () => {
    const saved = prepareScheduleSave(
      {
        ...stored,
        name: 'Renamed',
        lastStatus: 'stale form copy',
        nextRunAt: '2000-01-01T00:00:00Z',
      },
      stored,
    );
    expect(saved.name).toBe('Renamed');
    expect(saved.nextRunAt).toBe(stored.nextRunAt);
    expect(saved.deferredSlot).toBe(stored.deferredSlot);
    expect(saved.lastStatus).toBe(stored.lastStatus);
    expect(saved.lastRunAt).toBe(stored.lastRunAt);
  });

  it('drops the old slot when the timing changes or the schedule pauses', () => {
    const edited = prepareScheduleSave(
      { ...stored, kind: { kind: 'interval', everySecs: 300 } },
      stored,
    );
    expect(edited.nextRunAt).toBeUndefined();
    expect(edited.deferredSlot).toBeUndefined();
    expect(prepareScheduleSave({ ...stored, timezone: 'utc' }, stored).nextRunAt).toBe(
      undefined,
    );
    expect(prepareScheduleSave({ ...stored, enabled: false }, stored).nextRunAt).toBe(
      undefined,
    );
    const paused = { ...stored, enabled: false };
    expect(prepareScheduleSave({ ...stored }, paused).nextRunAt).toBeUndefined();
  });
});

describe('schedule validation (mirror of Schedule::validate)', () => {
  const schedule = (kind: Schedule['kind'], timezone = 'utc'): Schedule => ({
    id: 's',
    name: 'S',
    workflowId: 'w',
    kind,
    timezone,
    enabled: true,
    trusted: false,
    missedPolicy: 'skip',
  });

  it('uses the Rust messages', () => {
    expect(validateSchedule(schedule({ kind: 'interval', everySecs: 10 }))).toEqual([
      'Interval must be 60 s – 30 days.',
    ]);
    expect(validateSchedule(schedule({ kind: 'interval', everySecs: 300 }))).toEqual([]);
    expect(
      validateSchedule(schedule({ kind: 'interval', everySecs: 300 }, 'Mars/Olympus')),
    ).toEqual(["Timezone must be 'utc', 'local', or '±HH:MM'."]);
    expect(
      validateSchedule(schedule({ kind: 'interval', everySecs: 300 }, '+05:30')),
    ).toEqual([]);
    expect(validateSchedule(schedule({ kind: 'daily', hour: 24, minute: 0 }))).toEqual([
      'Daily time must be a valid HH:MM.',
    ]);
  });

  it('mirrors cron parsing, including never-matching dates', () => {
    const cron = (expr: string): string[] =>
      validateSchedule(schedule({ kind: 'cron', expr }));
    expect(cron('*/15 * * * *')).toEqual([]);
    expect(cron('0 9 1 * 1')).toEqual([]);
    expect(cron('0 0 29 2 *')).toEqual([]);
    expect(cron('0 0 31 2 1')).toEqual([]);
    expect(cron('*/15 * * *')).toEqual([
      'Invalid cron: Cron needs 5 fields: minute hour day month weekday.',
    ]);
    expect(cron('99 * * * *')).toEqual([
      "Invalid cron: Value out of range 0-59 in '99'.",
    ]);
    expect(cron('*/0 * * * *')).toEqual(["Invalid cron: Step must be >= 1 in '*/0'."]);
    expect(cron('0 9 * * mon')).toEqual(["Invalid cron: Bad value 'mon' in 'mon'."]);
    expect(cron('1-2-3 * * * *')).toEqual(["Invalid cron: Bad value '2-3' in '1-2-3'."]);
    expect(cron('5-1 * * * *')).toEqual(["Invalid cron: Reversed range '5-1' in '5-1'."]);
    expect(cron('0 0 31 2 *')).toEqual([
      'Invalid cron: Cron never matches: no chosen month has that day.',
    ]);
    expect(cron('0 0 31 4,6 *')).toEqual([
      'Invalid cron: Cron never matches: no chosen month has that day.',
    ]);
  });
});

describe('one-time date field', () => {
  it('shows and reads the instant in local time', () => {
    const at = new Date(2030, 0, 2, 9, 30).toISOString();
    expect(toLocalInputValue(at)).toBe('2030-01-02T09:30');
    expect(fromLocalInputValue('2030-01-02T09:30')).toBe(at);
    expect(fromLocalInputValue('')).toBeNull();
    expect(toLocalInputValue('not a date')).toBe('');
  });
});

describe('spent one-time schedules (mirror of Schedule::one_time_spent)', () => {
  const at = '2026-10-22T16:00:00Z';
  const once: Schedule = {
    id: 'once',
    name: 'Once',
    workflowId: 'wf',
    kind: { kind: 'oneTime', at },
    timezone: 'local',
    enabled: false,
    trusted: false,
    missedPolicy: 'skip',
  };
  const now = Date.parse('2026-10-22T17:00:00Z');

  it('uses the Rust messages', () => {
    expect(oneTimeSpent({ ...once, lastRunAt: at }, now)).toBe(
      'This one-time schedule already ran. Pick a new time to run it again.',
    );
    expect(oneTimeSpent(once, now)).toBe(
      "This one-time schedule's time has passed. Pick a new time.",
    );
    // Within the late grace, with catch-up, or after an earlier manual run.
    expect(oneTimeSpent(once, Date.parse('2026-10-22T16:10:00Z'))).toBeNull();
    expect(oneTimeSpent({ ...once, missedPolicy: 'runOnce' }, now)).toBeNull();
    expect(
      oneTimeSpent(
        { ...once, lastRunAt: '2026-10-22T15:00:00Z' },
        Date.parse('2026-10-22T15:30:00Z'),
      ),
    ).toBeNull();
    expect(
      oneTimeSpent({ ...once, kind: { kind: 'interval', everySecs: 300 } }, now),
    ).toBeNull();
    // Run manually before its time, then expired: not "Done".
    const early = { ...once, lastRunAt: '2026-10-22T15:00:00Z' };
    expect(oneTimeCompleted(early)).toBe(false);
    expect(oneTimeSpent(early, now)).toBe(
      "This one-time schedule's time has passed. Pick a new time.",
    );
    expect(oneTimeCompleted({ ...once, lastRunAt: at })).toBe(true);
  });
});
