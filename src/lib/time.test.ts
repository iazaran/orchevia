import { describe, expect, it } from 'vitest';
import { formatDate, formatRelative, formatTime } from './time';

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

describe('relative times', () => {
  // Midday local time, so the day boundaries below are unambiguous.
  const now = new Date(2026, 10, 27, 12, 0, 0).getTime();
  const at = (offsetMs: number): string => new Date(now + offsetMs).toISOString();
  const minute = 60_000;
  const hour = 60 * minute;

  it('describes the recent past', () => {
    expect(formatRelative(at(-20_000), now)).toBe('just now');
    expect(formatRelative(at(-5 * minute), now)).toBe('5 min ago');
    expect(formatRelative(at(-3 * hour), now)).toBe('3 h ago');
    expect(formatRelative(at(-20 * hour), now)).toMatch(/^yesterday /);
    expect(formatRelative(at(-3 * 24 * hour), now)).toBe('3 days ago');
    expect(formatRelative(at(-30 * 24 * hour), now)).toBe(
      formatDate(at(-30 * 24 * hour)),
    );
  });

  it('describes what comes next', () => {
    expect(formatRelative(at(20_000), now)).toBe('now');
    expect(formatRelative(at(50 * minute), now)).toBe('in 50 min');
    expect(formatRelative(at(5 * hour), now)).toMatch(/^today /);
    expect(formatRelative(at(21 * hour), now)).toMatch(/^tomorrow /);
    expect(formatRelative(at(3 * 24 * hour), now)).not.toMatch(/^in |^tomorrow|^today/);
    expect(formatRelative(at(30 * 24 * hour), now)).toBe(formatDate(at(30 * 24 * hour)));
  });

  it('passes through unparseable input', () => {
    expect(formatRelative('later', now)).toBe('later');
  });
});
