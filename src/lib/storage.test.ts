import { describe, expect, it } from 'vitest';
import { readLocal, writeLocal } from './storage';

describe('guarded storage', () => {
  it('round-trips values', () => {
    writeLocal('orchevia.test.key', 'v1');
    expect(readLocal('orchevia.test.key')).toBe('v1');
    localStorage.removeItem('orchevia.test.key');
    expect(readLocal('orchevia.test.key')).toBeNull();
  });
});
