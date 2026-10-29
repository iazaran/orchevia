import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  SETUP_ISSUE_CODES,
  VALIDATION_CODES,
  validateWorkflowLocal,
  type Workflow,
  type WorkflowNode,
} from './workflow';

/**
 * The same fixture drives `parity_tests` in `crates/core/src/workflow.rs`:
 * both validators must report exactly the issues each case lists.
 */
interface ExpectedIssue {
  code: string;
  severity: 'error' | 'warning';
  nodeId?: string;
  edgeId?: string;
}
/** Case nodes may leave out `position` and `config`. */
type CaseNode = Omit<WorkflowNode, 'position' | 'config'> & {
  position?: WorkflowNode['position'];
  config?: WorkflowNode['config'];
};
interface ParityCase {
  name: string;
  workflow: Omit<Partial<Workflow>, 'nodes'> & { nodes: CaseNode[] };
  issues: ExpectedIssue[];
}
interface ParityFixture {
  codes: string[];
  setupCodes: string[];
  exemptions: { code: string; reason: string }[];
  cases: ParityCase[];
}

const fixture = JSON.parse(
  readFileSync('src/test/validation-parity.json', 'utf8'),
) as ParityFixture;

/** Fill the fields cases leave out, exactly like the Rust test. */
function caseWorkflow(c: ParityCase): Workflow {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'wf-parity',
    name: 'Parity',
    edges: [],
    ...c.workflow,
    nodes: c.workflow.nodes.map(({ position, config, ...n }) => ({
      ...n,
      position: position ?? { x: 0, y: 0 },
      config: config ?? {},
    })),
  };
}

function key(issue: ExpectedIssue): string {
  return `${issue.code} ${issue.severity} node=${issue.nodeId ?? '-'} edge=${issue.edgeId ?? '-'}`;
}

describe('validator parity fixture', () => {
  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const actual = validateWorkflowLocal(caseWorkflow(c)).map(key).sort();
    expect(actual).toEqual(c.issues.map(key).sort());
  });

  it('lists and exercises every code the validator can report', () => {
    expect([...fixture.codes].sort()).toEqual([...VALIDATION_CODES].sort());
    const exercised = new Set(fixture.cases.flatMap((c) => c.issues.map((i) => i.code)));
    for (const code of fixture.codes) expect(exercised, code).toContain(code);
    expect(fixture.setupCodes).toEqual(SETUP_ISSUE_CODES);
  });

  it('keeps run-start exemptions out of the browser validator', () => {
    // These need the database or PATH, so only the engine checks them when a
    // run starts; the browser validator never reports them.
    const reported = new Set(
      fixture.cases
        .flatMap((c) => validateWorkflowLocal(caseWorkflow(c)))
        .map((i) => i.code),
    );
    for (const { code, reason } of fixture.exemptions) {
      expect(reason.trim(), code).not.toBe('');
      expect(VALIDATION_CODES as readonly string[], code).not.toContain(code);
      expect(reported, code).not.toContain(code);
    }
  });
});
