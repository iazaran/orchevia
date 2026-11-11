import { describe, expect, it } from 'vitest';
import sharedDigest from '../test/agent-digest-claude.json';
import {
  digestOf,
  displayPath,
  looksLikeTestCommand,
  parseTestCounts,
  stepPurpose,
  summarizeStep,
} from './step-summary';
import type { StoredNodeResult, WorkflowNode } from './workflow';

function row(overrides: Partial<StoredNodeResult> = {}): StoredNodeResult {
  return {
    id: 1,
    runId: 'run-1',
    nodeId: 'impl',
    status: 'succeeded',
    stdout: '',
    stderr: '',
    startedAt: '2026-11-11T10:00:00Z',
    ...overrides,
  };
}

function node(
  overrides: Partial<WorkflowNode> & Pick<WorkflowNode, 'type'>,
): WorkflowNode {
  return {
    id: 'impl',
    position: { x: 0, y: 0 },
    config: { args: [] },
    ...overrides,
  };
}

const agent = node({
  type: 'agent',
  config: { args: [], prompt: '# Implement {{input.task}}\nKeep changes small.' },
});

describe('digestOf', () => {
  it('reads the digest the core writes (shared fixture)', () => {
    const digest = digestOf(
      row({ structuredJson: JSON.stringify({ agentDigest: sharedDigest }) }),
    );
    expect(digest?.files).toEqual([{ path: '/work/repo/notes.txt', change: 'added' }]);
    expect(digest?.commands.map((c) => [c.command, c.status, c.exitCode])).toEqual([
      ['ls', 'succeeded', 0],
      ['false', 'failed', 1],
    ]);
    expect(digest?.tasks.every((t) => t.status === 'completed')).toBe(true);
    expect(digest?.message).toContain('hello world');
    expect(digest?.reads).toBe(0);
  });

  it('is null for rows without one and ignores malformed parts', () => {
    expect(digestOf(row())).toBeNull();
    expect(digestOf(row({ structuredJson: '{not json' }))).toBeNull();
    const digest = digestOf(
      row({
        structuredJson: JSON.stringify({ agentDigest: { files: [1, { path: 'a' }] } }),
      }),
    );
    expect(digest?.files).toEqual([{ path: 'a', change: '' }]);
  });
});

describe('parseTestCounts', () => {
  it('sums every cargo summary line', () => {
    const text =
      'test result: ok. 12 passed; 0 failed; 1 ignored; 0 measured\n' +
      'test result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured';
    expect(parseTestCounts(text)).toEqual({ passed: 15, failed: 2, skipped: 1 });
  });

  it('reads vitest, jest and pytest summaries', () => {
    expect(parseTestCounts(' Tests  1 failed | 11 passed | 2 skipped (14)')).toEqual({
      passed: 11,
      failed: 1,
      skipped: 2,
    });
    expect(parseTestCounts('Tests:       3 passed, 3 total')).toEqual({
      passed: 3,
      failed: 0,
      skipped: 0,
    });
    expect(parseTestCounts('===== 2 failed, 10 passed in 0.42s =====')).toEqual({
      passed: 10,
      failed: 2,
      skipped: 0,
    });
  });

  it('strips colours and returns null without a summary', () => {
    expect(parseTestCounts('\u001b[32m Tests  4 passed (4)\u001b[0m')?.passed).toBe(4);
    expect(parseTestCounts('compiled fine')).toBeNull();
  });
});

it('recognises the same test runners as the core', () => {
  for (const yes of [
    'cargo test -p orchevia-core',
    'pnpm test',
    'npx vitest run',
    'python -m pytest -q',
    'go test ./...',
    './gradlew test',
    'cd app && npm run test -- --ci',
  ])
    expect(looksLikeTestCommand(yes), yes).toBe(true);
  for (const no of [
    'cargo build',
    'echo testing',
    'pnpm testify',
    'rg jest-config',
    'latest',
  ])
    expect(looksLikeTestCommand(no), no).toBe(false);
});

describe('stepPurpose', () => {
  it('describes each kind of step from its configuration', () => {
    expect(stepPurpose(agent, { task: 'the login bug' })).toBe('Implement the login bug');
    expect(stepPurpose(agent)).toBe('Implement {{input.task}}');
    expect(
      stepPurpose(
        node({ type: 'command', config: { executable: 'pnpm', args: ['test'] } }),
      ),
    ).toBe('Runs pnpm test');
    expect(
      stepPurpose(
        node({
          type: 'github',
          config: {
            args: [],
            githubOp: { op: 'createPr', title: 't', base: 'main', head: 'fix' },
          },
        }),
      ),
    ).toBe('Opens a pull request');
    expect(
      stepPurpose(
        node({
          type: 'git',
          config: { args: [], gitOp: { op: 'commit', message: 'Fix' } },
        }),
      ),
    ).toBe('Commits: Fix');
    expect(stepPurpose(node({ type: 'approval', config: { args: [] } }))).toBe(
      'Waits for your approval',
    );
  });
});

describe('summarizeStep', () => {
  it('turns an agent digest into facts', () => {
    const summary = summarizeStep(
      row({
        structuredJson: JSON.stringify({
          agentDigest: {
            ...sharedDigest,
            commands: [
              ...sharedDigest.commands,
              { command: 'cargo test', status: 'failed', exitCode: 101, test: true },
            ],
          },
        }),
      }),
      agent,
      { repoDir: '/work/repo' },
    );
    expect(summary.facts.map((f) => [f.kind, f.text, f.tone])).toEqual([
      ['files', 'Changed 1 file (1 added)', 'neutral'],
      ['tests', 'Tests failed (exit 101): cargo test', 'bad'],
      ['commands', 'Ran 2 commands (1 failed)', 'neutral'],
      ['tasks', 'Its plan: 2 of 2 done', 'neutral'],
    ]);
    expect(summary.facts[0]?.detail).toEqual(['added: notes.txt']);
    expect(summary.doing).toBeNull();
    expect(summary.agentNote).toBeNull();
  });

  it('says what a running agent is doing and labels its words', () => {
    const summary = summarizeStep(
      row({
        status: 'running',
        structuredJson: JSON.stringify({
          agentDigest: { doing: 'Editing src/a.ts', message: 'Looking at the parser.' },
        }),
      }),
      agent,
    );
    expect(summary.doing).toBe('Editing src/a.ts');
    expect(summary.agentNote).toBe('Looking at the parser.');
    expect(summarizeStep(row({ status: 'running' }), agent).doing).toBe('Working…');
  });

  it('reports a test command from its exit code and printed counts only', () => {
    const tests = node({
      type: 'command',
      config: { executable: 'pnpm', args: ['test'] },
    });
    const passed = summarizeStep(
      row({
        exitCode: 0,
        stdout: ' Tests  12 passed (12)',
        structuredJson: '{"command":"pnpm test"}',
      }),
      tests,
    );
    expect(passed.facts).toEqual([
      { kind: 'tests', text: 'Tests passed: 12 passed', tone: 'ok' },
    ]);
    const failed = summarizeStep(row({ status: 'failed', exitCode: 1 }), tests);
    expect(failed.facts[0]).toEqual({
      kind: 'tests',
      text: 'Tests failed (exit 1)',
      tone: 'bad',
    });
    // A command that is not a test reports its exit code, not "tests passed".
    const build = node({
      type: 'command',
      config: { executable: 'make', args: ['build'] },
    });
    expect(summarizeStep(row({ exitCode: 0 }), build).facts[0]?.text).toBe(
      'Finished with exit code 0',
    );
    // A simulated row claims nothing about a real process.
    expect(
      summarizeStep(row({ exitCode: 0, structuredJson: '{"simulated":true}' }), build)
        .facts,
    ).toEqual([]);
  });

  it('labels attempts, loop visits, reuse, simulation and corrections', () => {
    const retry = node({
      type: 'agent',
      config: { args: [], retry: { maxAttempts: 3, delayMs: 0, backoff: false } },
    });
    expect(summarizeStep(row({ attempt: 2 }), retry).labels).toEqual(['Attempt 2 of 3']);
    const history = [row({ id: 1 }), row({ id: 2, status: 'skipped' }), row({ id: 3 })];
    expect(
      summarizeStep(history[2] as StoredNodeResult, agent, { results: history }).labels,
    ).toEqual(['Visit 2']);
    expect(
      summarizeStep(
        row({ id: 3, structuredJson: '{"correction":{"feedbackIds":[4,5],"round":1}}' }),
        agent,
        { results: history },
      ).labels,
    ).toEqual(['Correction for feedback #4, #5']);
    expect(
      summarizeStep(
        row({
          structuredJson:
            '{"reusedFrom":{"runId":"run-0","resultId":9},"simulated":true}',
        }),
        agent,
      ).labels,
    ).toEqual(['Reused from run-0', 'Simulated']);
  });

  it('shows a feedback check decision and blockers', () => {
    const check = summarizeStep(
      row({
        status: 'checked',
        structuredJson: JSON.stringify({
          feedbackCheck: {
            feedbackIds: [1],
            decision: 'satisfied',
            explanation: 'Old keys still load.',
          },
        }),
      }),
      agent,
    );
    expect(check.labels).toEqual(['Feedback check']);
    expect(check.facts[0]).toEqual({
      kind: 'outcome',
      text: 'Feedback already satisfied: Old keys still load.',
      tone: 'ok',
    });
    const stopped = summarizeStep(
      row({ status: 'failed', structuredJson: '{"processTimeout":true}' }),
      agent,
      { findings: [{ severity: 'P1' }, { severity: 'P2' }, { severity: 'P1' }] },
    );
    expect(stopped.facts.map((f) => f.text)).toEqual([
      '3 findings: P1 ×2, P2 ×1',
      'Stopped at its time limit',
    ]);
  });

  it('keeps paths outside the repository whole', () => {
    expect(displayPath('/work/repo/src/a.ts', '/work/repo/')).toBe('src/a.ts');
    expect(displayPath('/etc/hosts', '/work/repo')).toBe('/etc/hosts');
  });
});
