import { describe, expect, it } from 'vitest';
import { errorMessage } from './errors';

describe('error message', () => {
  it('unwraps Errors and stringifies the rest', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});
