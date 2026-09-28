import { describe, expect, it } from 'vitest';
import { formatDate, formatTime } from './time';

describe('time formatting', () => {
  it('renders timestamps in locale form', () => {
    const out = formatTime('2026-09-23T20:34:45.483763133Z');
    expect(out).not.toBe('2026-09-23T20:34:45.483763133Z');
    expect(out).toContain('2026');
  });

  it('passes through unparseable input', () => {
    expect(formatTime('not-a-date')).toBe('not-a-date');
    expect(formatDate('')).toBe('');
  });

  it('renders compact dates', () => {
    expect(formatDate('2026-09-23T20:34:45Z')).toContain('2026');
  });
});
