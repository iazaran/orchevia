import { describe, expect, it } from 'vitest';
import { validateMcpServer } from './integrations';

describe('mcp servers', () => {
  it('rejects blank command', () => {
    expect(
      validateMcpServer({ id: 'a', name: 'A', command: '', args: [], enabled: true }),
    ).not.toHaveLength(0);
  });

  it('accepts a valid server', () => {
    expect(
      validateMcpServer({
        id: 'a',
        name: 'A',
        command: 'npx',
        args: ['-y', 'x'],
        enabled: true,
      }),
    ).toHaveLength(0);
  });
});
