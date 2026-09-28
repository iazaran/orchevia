/**
 * Theme management: `system` (default, follows `prefers-color-scheme`),
 * `light`, or `dark`. Persisted via backend settings with a localStorage
 * fallback so browser dev mode works too.
 */

export type ThemeChoice = 'system' | 'light' | 'dark';

import { readLocal, writeLocal } from './storage';

const STORAGE_KEY = 'orchevia.theme.v1';

export function themeFromValue(value: string | null): ThemeChoice {
  if (value === 'light' || value === 'dark' || value === 'system') return value;
  return 'system';
}

export function loadThemeLocal(): ThemeChoice {
  return themeFromValue(readLocal(STORAGE_KEY));
}

export function saveThemeLocal(theme: ThemeChoice): void {
  writeLocal(STORAGE_KEY, theme);
}

/** Resolve `system` against the OS preference; light/dark pass through. */
export function resolveTheme(theme: ThemeChoice): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches
  ) {
    return 'light';
  }
  return 'dark';
}

/** Apply the resolved theme via `data-theme` on `<html>`. */
export function applyTheme(theme: ThemeChoice): void {
  const resolved = resolveTheme(theme);
  if (typeof document !== 'undefined') {
    if (resolved === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }
}
