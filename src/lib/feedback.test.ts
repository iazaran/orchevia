import { describe, expect, it } from 'vitest';
import fixture from '../test/feedback-parity.json';
import {
  correctionPlan,
  feedbackTarget,
  feedbackTiming,
  parseDecision,
  validateFeedbackText,
} from './feedback';
import type { Workflow } from './workflow';

const workflow = fixture.workflow as Workflow;

describe('feedback rules (shared with the core)', () => {
  it('sends feedback to the same AI step', () => {
    for (const { node, target } of fixture.targets)
      expect(feedbackTarget(workflow, node), node).toBe(target);
  });

  it('plans the same correction', () => {
    for (const plan of fixture.plans)
      expect(correctionPlan(workflow, plan.targets)).toEqual({
        roots: plan.roots,
        affected: plan.affected,
      });
  });

  it('reads the same decisions', () => {
    for (const { text, kind, ...rest } of fixture.decisions) {
      const decision = parseDecision(text);
      expect(decision.kind, text).toBe(kind);
      if (decision.kind === 'satisfied')
        expect(decision.explanation).toBe(rest.explanation);
      if (decision.kind === 'change') {
        expect(decision.explanation).toBe(rest.explanation);
        expect(decision.change).toBe(rest.change);
      }
    }
  });
});

describe('feedback text and timing', () => {
  it('validates like the core', () => {
    expect(validateFeedbackText('  keep it  ')).toBe('keep it');
    expect(() => validateFeedbackText('   ')).toThrow('Write the feedback first.');
    expect(() => validateFeedbackText('x'.repeat(4001))).toThrow('at most 4000');
    expect(validateFeedbackText('é'.repeat(4000))).toHaveLength(4000);
  });

  it('says when feedback will be handled', () => {
    expect(feedbackTiming(workflow, undefined)).toContain('before "push" publishes');
    expect(
      feedbackTiming(workflow, {
        publicationStarted: { nodeId: 'push', label: 'Push branch', at: '' },
      }),
    ).toContain('"Push branch" already started publishing');
    expect(feedbackTiming({ ...workflow, nodes: [] }, undefined)).toContain(
      'before the run finishes',
    );
  });
});
