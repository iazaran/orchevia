import { describe, expect, it } from 'vitest';
import { resolveTheme, themeFromValue } from './theme';

describe('theme helpers', () => {
  it('parses stored values with system fallback', () => {
    expect(themeFromValue('light')).toBe('light');
    expect(themeFromValue('nope')).toBe('system');
    expect(themeFromValue(null)).toBe('system');
  });

  it('resolves explicit choices directly', () => {
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
  });
});
