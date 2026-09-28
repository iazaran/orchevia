import { useEffect, useState } from 'react';
import { getBackend } from '../lib/backend';
import {
  applyTheme,
  loadThemeLocal,
  saveThemeLocal,
  type ThemeChoice,
} from '../lib/theme';

export function useTheme(): { theme: ThemeChoice; setTheme: (t: ThemeChoice) => void } {
  const [theme, setThemeState] = useState<ThemeChoice>(() => loadThemeLocal());

  useEffect(() => {
    // Prefer the persisted desktop setting; fall back to local choice.
    void getBackend()
      .getSetting('ui.theme')
      .then((saved) => {
        if (saved === 'light' || saved === 'dark' || saved === 'system') {
          setThemeState(saved);
          saveThemeLocal(saved);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    applyTheme(theme);
    const media =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: light)')
        : null;
    const onChange = (): void => {
      if (theme === 'system') applyTheme('system');
    };
    media?.addEventListener('change', onChange);
    return () => {
      media?.removeEventListener('change', onChange);
    };
  }, [theme]);

  const setTheme = (next: ThemeChoice): void => {
    setThemeState(next);
    saveThemeLocal(next);
    void getBackend()
      .setSetting('ui.theme', next)
      .catch(() => {});
  };

  return { theme, setTheme };
}

export function ThemeToggle({
  theme,
  setTheme,
}: {
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
}): React.JSX.Element {
  return (
    <label
      className="field-hint"
      style={{ display: 'flex', gap: 6, alignItems: 'center' }}
    >
      Theme
      <select
        className="input"
        aria-label="Theme"
        value={theme}
        style={{ width: 'auto' }}
        onChange={(e) => {
          setTheme(e.target.value as ThemeChoice);
        }}
      >
        <option value="system">System</option>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
    </label>
  );
}
