// What a run step is for, what it is doing and what it achieved, in plain
// words. Facts come only from evidence the engine recorded: exit codes, test
// summaries printed by the runner, tool inputs and results the CLI reported
// (`agentDigest`), finding blocks and stored decisions. Text the agent wrote
// about itself is returned separately so the page can label it.
import type { StoredNodeResult, WorkflowNode } from './workflow';

export interface DigestFile {
  path: string;
  /** `added`, `edited` or `deleted`. */
  change: string;
}
export interface DigestCommand {
  command: string;
  /** `running`, `succeeded`, `failed` or `unknown`. */
  status: string;
  exitCode?: number;
  test?: boolean;
}
export interface DigestTask {
  id: string;
  text: string;
  /** `pending`, `in_progress` or `completed`. */
  status: string;
}
/** Mirrors `AgentDigest` in `crates/core/src/agent_output.rs`. */
export interface AgentDigest {
  files: DigestFile[];
  commands: DigestCommand[];
  tasks: DigestTask[];
  doing?: string;
  message?: string;
  reads: number;
  searches: number;
  truncated: boolean;
}

export type FactTone = 'ok' | 'bad' | 'warn' | 'neutral';
export interface StepFact {
  kind: 'files' | 'tests' | 'commands' | 'tasks' | 'findings' | 'outcome' | 'blocker';
  text: string;
  tone: FactTone;
  /** Lines shown when the fact is expanded (file paths, task list). */
  detail?: string[];
}
export interface StepSummary {
  /** One line on what the step is for. */
  purpose: string;
  /** What a running step is doing now. */
  doing: string | null;
  facts: StepFact[];
  /** Attempt, loop visit, reuse, simulation, correction, feedback check. */
  labels: string[];
  /** The agent's own latest words while it runs, labelled as such. */
  agentNote: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function metadataOf(row: StoredNodeResult): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(row.structuredJson ?? '{}');
    return isRecord(data) ? data : {};
  } catch {
    return {};
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The recorded digest, or null for runs older than v0.2.0 and non-agent steps. */
export function digestOf(row: StoredNodeResult): AgentDigest | null {
  const raw = metadataOf(row).agentDigest;
  if (!isRecord(raw)) return null;
  const list = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter(isRecord) : [];
  const count = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  const digest: AgentDigest = {
    files: list(raw.files).map((f) => ({ path: str(f.path), change: str(f.change) })),
    commands: list(raw.commands).map((c) => ({
      command: str(c.command),
      status: str(c.status) || 'unknown',
      ...(typeof c.exitCode === 'number' ? { exitCode: c.exitCode } : {}),
      ...(c.test === true ? { test: true } : {}),
    })),
    tasks: list(raw.tasks).map((t) => ({
      id: str(t.id),
      text: str(t.text),
      status: str(t.status) || 'pending',
    })),
    reads: count(raw.reads),
    searches: count(raw.searches),
    truncated: raw.truncated === true,
  };
  if (str(raw.doing) !== '') digest.doing = str(raw.doing);
  if (str(raw.message) !== '') digest.message = str(raw.message);
  return digest;
}

function shorten(text: string, max: number): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  const chars = Array.from(line);
  return chars.length > max || text.trim().includes('\n')
    ? `${chars.slice(0, max).join('')}…`
    : line;
}

/** A path relative to the repository when it lies inside it. */
export function displayPath(path: string, repoDir?: string): string {
  const root = repoDir?.replace(/\/+$/, '') ?? '';
  if (root !== '' && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * Test counts printed by common runners (cargo, vitest, jest, pytest), summed
 * over every summary line of every runner, so one runner's failure is never
 * hidden by another's pass. Null when no summary was printed.
 */
export function parseTestCounts(
  text: string,
): { passed: number; failed: number; skipped: number } | null {
  const clean = text.replace(ANSI, '');
  const total = { passed: 0, failed: 0, skipped: 0, summaries: 0 };
  const add = (passed: string | undefined, failed?: string, skipped?: string): void => {
    total.summaries += 1;
    total.passed += Number(passed ?? 0);
    total.failed += Number(failed ?? 0);
    total.skipped += Number(skipped ?? 0);
  };
  const counts = (summary: string): void => {
    const part = (word: string): string | undefined =>
      new RegExp(`(\\d+) ${word}`).exec(summary)?.[1];
    add(part('passed'), part('failed'), part('skipped'));
  };
  // cargo: "test result: ok. 12 passed; 0 failed; 1 ignored; …"
  for (const m of clean.matchAll(
    /test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/g,
  ))
    add(m[1], m[2], m[3]);
  // vitest: "Tests  1 failed | 11 passed | 2 skipped (14)"
  for (const m of clean.matchAll(/^\s*Tests\s+((?:\d+ \w+(?: \| )?)+)\s*\(\d+\)/gm))
    counts(m[1] ?? '');
  // jest: "Tests:       1 failed, 2 skipped, 11 passed, 14 total"
  for (const m of clean.matchAll(/^Tests:\s+(.*\d+ total)/gm)) counts(m[1] ?? '');
  // pytest: "==== 2 failed, 10 passed, 1 skipped in 0.42s ===="
  for (const m of clean.matchAll(
    /^=+ (.*\d+ (?:passed|failed).*) in [\d.]+s(?: \([^)]*\))? =+$/gm,
  ))
    counts(m[1] ?? '');
  return total.summaries === 0
    ? null
    : { passed: total.passed, failed: total.failed, skipped: total.skipped };
}

const TEST_RUNNERS = [
  'cargo test',
  'cargo nextest',
  'npm test',
  'npm run test',
  'pnpm test',
  'pnpm run test',
  'pnpm vitest',
  'pnpm jest',
  'yarn vitest',
  'yarn jest',
  'yarn test',
  'yarn run test',
  'bun test',
  'deno test',
  'vitest',
  'jest',
  'pytest',
  'unittest',
  'go test',
  'phpunit',
  'pest',
  'rspec',
  'mvn test',
  'gradle test',
  'gradlew test',
  'dotnet test',
  'mix test',
  'make test',
  'ctest',
  'swift test',
];
const RUN_WRAPPERS = [
  'npx ',
  'bunx ',
  'pnpm exec ',
  'pnpm dlx ',
  'yarn dlx ',
  'uv run ',
  'poetry run ',
  'pipenv run ',
  'time ',
  'env ',
  'python -m ',
  'python3 -m ',
];

/** Mirrors `shell_segments`: split outside quotes; whether the segment's status is the command's. */
function shellSegments(command: string): [string, boolean][] {
  const chars = Array.from(command);
  const segments: [string, string][] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] ?? '';
    const next = chars[i + 1];
    if (quote !== null) {
      if (c === quote) quote = null;
      current += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      current += c;
    } else if (c === '&' && next === '&') {
      segments.push([current, '&&']);
      current = '';
      i++;
    } else if (c === '|' && next === '|') {
      segments.push([current, '||']);
      current = '';
      i++;
    } else if (c === '|') {
      segments.push([current, '|']);
      current = '';
    } else if (c === ';' || c === '\n') {
      segments.push([current, ';']);
      current = '';
    } else if (c === '&' && chars[i - 1] !== '>' && next !== '>') {
      // A lone `&` sends the command to the background; `2>&1` and `&>`
      // are redirections.
      segments.push([current, '&']);
      current = '';
    } else current += c;
  }
  segments.push([current, '']);
  return segments.map(([segment], index) => [
    segment,
    segments.slice(0, index).every(([, after]) => after !== '||') &&
      segments.slice(index).every(([, after]) => after === '' || after === '&&'),
  ]);
}

/** Mirrors `command_core`. */
function commandCore(segment: string): string {
  let rest = segment.trim().toLowerCase();
  for (;;) {
    const before = rest;
    const match = /^(\S+)\s+(.*)$/s.exec(rest);
    const first = match?.[1];
    if (first !== undefined && first.includes('=') && /^[a-z_]/.test(first))
      rest = (match?.[2] ?? '').trimStart();
    for (const wrapper of RUN_WRAPPERS)
      if (rest.startsWith(wrapper)) rest = rest.slice(wrapper.length).trimStart();
    if (rest === before) break;
  }
  const match = /^(\S+)(\s.*)?$/s.exec(rest);
  if (match === null) return rest;
  const program = (match[1] ?? '').split('/').pop() ?? '';
  return match[2] === undefined ? program : `${program} ${match[2].trimStart()}`;
}

/** Mirrors `NO_TEST_RUN`: flags that build, list or describe tests only. */
const NO_TEST_RUN = [
  '--no-run',
  '--help',
  '-h',
  '--version',
  '--collect-only',
  '--co',
  '--list',
  '-list',
  '--listtests',
  '--showconfig',
  '--show-config',
];

/** Mirrors `runs_tests`. */
function runsTests(args: string): boolean {
  const words = args.split(/\s+/).filter((word) => word !== '');
  if (words[0] === 'list') return false;
  return !words.some((word) =>
    NO_TEST_RUN.some((flag) => word === flag || word.startsWith(`${flag}=`)),
  );
}

/**
 * A known test runner in command position whose exit status reaches the end
 * of the command, in a mode that runs tests. Mirrors `is_test_command`
 * (shared cases in `src/test/test-commands.json`).
 */
export function looksLikeTestCommand(command: string): boolean {
  return shellSegments(command).some(([segment, reliable]) => {
    const core = commandCore(segment);
    return (
      reliable &&
      TEST_RUNNERS.some(
        (runner) =>
          core.startsWith(runner) &&
          (core.length === runner.length || /\s/.test(core[runner.length] ?? '')) &&
          runsTests(core.slice(runner.length)),
      )
    );
  });
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

function inputsRendered(text: string, inputs: Record<string, string>): string {
  return text.replace(/\{\{\s*input\.([\w-]+)\s*\}\}/g, (whole, name: string) => {
    const value = inputs[name];
    return value === undefined || value.trim() === '' ? whole : shorten(value, 60);
  });
}

/** One line on what a step is for, from its configuration. */
export function stepPurpose(
  node: WorkflowNode | undefined,
  inputs: Record<string, string> = {},
): string {
  if (node === undefined) return '';
  const config = node.config;
  switch (node.type) {
    case 'agent': {
      const first =
        (config.prompt ?? '')
          .split('\n')
          .map((line) => line.replace(/^#+\s*/, '').trim())
          .find((line) => line !== '') ?? '';
      return first === '' ? 'AI step' : shorten(inputsRendered(first, inputs), 160);
    }
    case 'command': {
      const program = config.scriptFile
        ? `${config.executable?.trim() || 'bash'} ${config.scriptFile}`
        : [config.executable ?? '', ...(config.args ?? [])].join(' ');
      return `Runs ${shorten(inputsRendered(program, inputs), 140)}`;
    }
    case 'git': {
      const op = config.gitOp;
      switch (op?.op) {
        case 'status':
          return 'Checks the repository status';
        case 'diffSummary':
          return 'Summarizes the changes';
        case 'branchCreate':
          return `Creates branch ${inputsRendered(op.name, inputs)}`;
        case 'checkout':
          return `Switches to ${inputsRendered(op.name, inputs)}`;
        case 'stage':
          return 'Stages changes';
        case 'commit':
          return `Commits: ${shorten(inputsRendered(op.message, inputs), 120)}`;
        case 'worktreeAdd':
          return 'Creates a worktree';
        case 'worktreeRemove':
          return 'Removes a worktree';
        default:
          return 'Git operation';
      }
    }
    case 'github': {
      const op = config.githubOp;
      switch (op?.op) {
        case 'createPr':
          return 'Opens a pull request';
        case 'postComment':
          return 'Posts a pull request comment';
        case 'prChecks':
          return 'Reads pull request checks';
        case 'prFiles':
          return 'Reads pull request files';
        case 'prDetails':
          return 'Reads a pull request';
        case 'listPrs':
          return 'Lists pull requests';
        default:
          return 'GitHub operation';
      }
    }
    case 'ticket':
      return `Reads ticket ${inputsRendered(config.ticketKey ?? '', inputs)}`.trim();
    case 'mcp':
      return `Calls ${config.mcpTool ?? 'an MCP tool'}`;
    case 'approval':
      return shorten(config.message ?? '', 160) || 'Waits for your approval';
    case 'condition':
      return 'Chooses the route';
    case 'start':
    case 'end':
      return '';
    default:
      return '';
  }
}

function digestFacts(digest: AgentDigest, repoDir: string | undefined): StepFact[] {
  const facts: StepFact[] = [];
  if (digest.files.length > 0) {
    const counts = (change: string): number =>
      digest.files.filter((f) => f.change === change).length;
    const parts = [
      counts('added') > 0 ? `${String(counts('added'))} added` : '',
      counts('edited') > 0 ? `${String(counts('edited'))} edited` : '',
      counts('deleted') > 0 ? `${String(counts('deleted'))} deleted` : '',
    ].filter((p) => p !== '');
    facts.push({
      kind: 'files',
      text: `Changed ${plural(digest.files.length, 'file')}${digest.truncated ? '+' : ''} (${parts.join(', ')})`,
      tone: 'neutral',
      detail: digest.files.map((f) => `${f.change}: ${displayPath(f.path, repoDir)}`),
    });
  }
  const tests = digest.commands.filter((c) => c.test === true);
  const last = tests[tests.length - 1];
  if (last !== undefined) {
    const runs = tests.length > 1 ? ` (${String(tests.length)} runs)` : '';
    const command = shorten(last.command, 80);
    facts.push(
      last.status === 'succeeded'
        ? { kind: 'tests', text: `Tests passed: ${command}${runs}`, tone: 'ok' }
        : last.status === 'failed'
          ? {
              kind: 'tests',
              text: `Tests failed${last.exitCode !== undefined ? ` (exit ${String(last.exitCode)})` : ''}: ${command}${runs}`,
              tone: 'bad',
            }
          : last.status === 'running'
            ? { kind: 'tests', text: `Running tests: ${command}`, tone: 'neutral' }
            : {
                kind: 'tests',
                text: `Ran tests, result not reported: ${command}`,
                tone: 'warn',
              },
    );
  }
  const others = digest.commands.filter((c) => c.test !== true);
  if (others.length > 0) {
    const failed = others.filter((c) => c.status === 'failed').length;
    facts.push({
      kind: 'commands',
      text: `Ran ${plural(others.length, 'command')}${failed > 0 ? ` (${String(failed)} failed)` : ''}`,
      tone: 'neutral',
      detail: others.map(
        (c) =>
          `${c.status === 'failed' ? '✗' : c.status === 'succeeded' ? '✓' : '·'} ${c.command}`,
      ),
    });
  }
  if (digest.tasks.length > 0) {
    const done = digest.tasks.filter((t) => t.status === 'completed').length;
    facts.push({
      kind: 'tasks',
      text: `Its plan: ${String(done)} of ${String(digest.tasks.length)} done`,
      tone: 'neutral',
      detail: digest.tasks.map(
        (t) =>
          `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '·'} ${t.text}`,
      ),
    });
  }
  return facts;
}

/** Label for a row's execution: attempt, visit, reuse, simulation, correction. */
function executionLabels(
  row: StoredNodeResult,
  node: WorkflowNode | undefined,
  results: StoredNodeResult[],
  metadata: Record<string, unknown>,
): string[] {
  const labels: string[] = [];
  if (row.status === 'checked') labels.push('Feedback check');
  const correction = metadata.correction;
  if (isRecord(correction)) {
    const ids = Array.isArray(correction.feedbackIds)
      ? correction.feedbackIds.filter((id): id is number => typeof id === 'number')
      : [];
    labels.push(
      ids.length > 0
        ? `Correction for feedback ${ids.map((id) => `#${String(id)}`).join(', ')}`
        : 'Correction',
    );
  }
  const reused = metadata.reusedFrom;
  if (isRecord(reused) && typeof reused.runId === 'string')
    labels.push(`Reused from ${reused.runId}`);
  if (metadata.simulated === true) labels.push('Simulated');
  const attempt = row.attempt ?? 1;
  const max = node?.config.retry?.maxAttempts;
  if (attempt > 1 || (max !== undefined && max > 1 && row.status === 'retrying'))
    labels.push(
      max !== undefined && max > 1
        ? `Attempt ${String(attempt)} of ${String(Math.min(10, max))}`
        : `Attempt ${String(attempt)}`,
    );
  // Loop passes: earlier finished visits of the same step since the last
  // feedback round that reran it. A correction is labelled as such, and a
  // step a correction round reran says so instead of counting as a pass.
  if (!isRecord(correction) && row.status !== 'checked') {
    const index = results.findIndex((r) => r.id === row.id);
    const before = results.slice(0, index < 0 ? results.length : index);
    let since = 0;
    let round: number | null = null;
    for (const [at, r] of before.entries()) {
      const plan = r.nodeId === '__feedback' ? metadataOf(r).feedbackRound : undefined;
      if (!isRecord(plan)) continue;
      const affected = Array.isArray(plan.affected) ? plan.affected : [];
      if (!affected.includes(row.nodeId)) continue;
      since = at + 1;
      round = typeof plan.round === 'number' ? plan.round : null;
    }
    const finished = (r: StoredNodeResult): boolean =>
      r.nodeId === row.nodeId &&
      ['succeeded', 'failed', 'approved', 'rejected'].includes(r.status);
    const rerun = round !== null && before.slice(0, since).some(finished);
    if (rerun) labels.push(`Rerun after feedback (round ${String(round)})`);
    const earlier = before.slice(since).filter(finished).length;
    if (earlier > 0) labels.push(`Visit ${String(earlier + 1)}`);
  }
  return labels;
}

/** A running command's own latest output line, or that it is running. */
function latestLine(output: string): string {
  const line = output
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .pop();
  return line === undefined ? 'Running…' : `Running · ${shorten(line, 140)}`;
}

export function summarizeStep(
  row: StoredNodeResult,
  node: WorkflowNode | undefined,
  options: {
    results?: StoredNodeResult[];
    inputs?: Record<string, string>;
    repoDir?: string | undefined;
    findings?: { severity: string }[];
  } = {},
): StepSummary {
  const metadata = metadataOf(row);
  const digest = digestOf(row);
  const running = row.status === 'running';
  const facts: StepFact[] = [];
  if (digest !== null) facts.push(...digestFacts(digest, options.repoDir));
  if (node?.type === 'command' && !running && row.status !== 'skipped') {
    const command = str(metadata.command);
    const counts = parseTestCounts(`${row.stdout}\n${row.stderr}`);
    const testLike =
      counts !== null ||
      looksLikeTestCommand(
        command || [node.config.executable ?? '', ...(node.config.args ?? [])].join(' '),
      );
    const exit = row.exitCode;
    if (testLike && exit !== undefined) {
      // The runner's own count of failures wins over a zero exit code.
      const failedTests = (counts?.failed ?? 0) > 0;
      const tally =
        counts === null
          ? ''
          : `: ${[
              `${String(counts.passed)} passed`,
              counts.failed > 0 ? `${String(counts.failed)} failed` : '',
              counts.skipped > 0 ? `${String(counts.skipped)} skipped` : '',
            ]
              .filter((p) => p !== '')
              .join(', ')}`;
      facts.push(
        exit === 0 && !failedTests
          ? { kind: 'tests', text: `Tests passed${tally}`, tone: 'ok' }
          : {
              kind: 'tests',
              text: `Tests failed (exit ${String(exit)})${tally}`,
              tone: 'bad',
            },
      );
    } else if (exit !== undefined && metadata.simulated !== true) {
      facts.push(
        exit === 0
          ? { kind: 'outcome', text: 'Finished with exit code 0', tone: 'ok' }
          : {
              kind: 'outcome',
              text: `Failed with exit code ${String(exit)}`,
              tone: 'bad',
            },
      );
    }
  }
  if (node?.type === 'condition' && row.status === 'succeeded') {
    const branch = str(metadata.branch) || row.stdout.trim();
    if (branch === 'true' || branch === 'false')
      facts.push({ kind: 'outcome', text: `Took the ${branch} branch`, tone: 'neutral' });
  }
  if (row.status === 'approved' || row.status === 'rejected') {
    facts.push({
      kind: 'outcome',
      text: row.status === 'approved' ? 'Approved' : 'Rejected',
      tone: row.status === 'approved' ? 'ok' : 'bad',
    });
  }
  const check = metadata.feedbackCheck;
  if (isRecord(check)) {
    const decision = str(check.decision);
    const explanation = str(check.explanation);
    facts.push({
      kind: 'outcome',
      text:
        decision === 'satisfied'
          ? `Feedback already satisfied${explanation ? `: ${explanation}` : ''}`
          : decision === 'change'
            ? `Feedback needs a change${str(check.change) ? `: ${str(check.change)}` : ''}`
            : `Feedback could not be checked${explanation ? `: ${explanation}` : ''}`,
      tone: decision === 'satisfied' ? 'ok' : decision === 'change' ? 'warn' : 'bad',
    });
  }
  const findings = options.findings ?? [];
  if (findings.length > 0) {
    const bySeverity = new Map<string, number>();
    for (const f of findings)
      bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
    facts.push({
      kind: 'findings',
      text: `${plural(findings.length, 'finding')}: ${[...bySeverity]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([severity, n]) => `${severity} ×${String(n)}`)
        .join(', ')}`,
      tone: 'warn',
    });
  }
  if (metadata.processTimeout === true)
    facts.push({ kind: 'blocker', text: 'Stopped at its time limit', tone: 'bad' });
  if (metadata.incomplete === true)
    facts.push({
      kind: 'blocker',
      text: 'The CLI stopped before finishing its work',
      tone: 'bad',
    });
  const checkedIds =
    isRecord(check) && Array.isArray(check.feedbackIds)
      ? check.feedbackIds.filter((id): id is number => typeof id === 'number')
      : [];
  return {
    purpose:
      row.status === 'checked'
        ? `Checks feedback ${checkedIds.map((id) => `#${String(id)}`).join(', ')} against this step's work, without changing it`
        : stepPurpose(node, options.inputs ?? {}),
    doing: running
      ? (digest?.doing ??
        (node?.type === 'agent'
          ? 'Working…'
          : node?.type === 'command'
            ? latestLine(row.stdout)
            : null))
      : null,
    facts,
    labels: executionLabels(row, node, options.results ?? [], metadata),
    agentNote: running ? (digest?.message ?? null) : null,
  };
}
