import { describe, expect, it } from 'vitest';
import shared from '../test/publishing-commands.json';
import { commandPublishes, isPublicationStep, type WorkflowNode } from './workflow';

describe('publication steps', () => {
  it('agrees with the core on the shared command list', () => {
    for (const [exe = '', ...args] of shared.publishes)
      expect(commandPublishes(exe, args), [exe, ...args].join(' ')).toBe(true);
    for (const [exe = '', ...args] of shared.local)
      expect(commandPublishes(exe, args), [exe, ...args].join(' ')).toBe(false);
  });

  it('treats GitHub writes as publishing unless turned off', () => {
    const pr: WorkflowNode = {
      id: 'pr',
      type: 'github',
      position: { x: 0, y: 0 },
      config: { githubOp: { op: 'postComment', number: 1, body: 'x' } },
    };
    expect(isPublicationStep(pr)).toBe(true);
    expect(isPublicationStep({ ...pr, config: { ...pr.config, publishes: false } })).toBe(
      false,
    );
    expect(
      isPublicationStep({ ...pr, config: { githubOp: { op: 'prChecks', number: 1 } } }),
    ).toBe(false);
    expect(
      isPublicationStep({ ...pr, type: 'approval', config: { publishes: true } }),
    ).toBe(false);
    expect(
      isPublicationStep({
        ...pr,
        type: 'command',
        config: { executable: 'git', args: ['push'], publishes: true },
      }),
    ).toBe(true);
  });
});
