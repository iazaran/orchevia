import { useState } from 'react';

function isDesktop(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  );
}

/**
 * Directory field with a native Browse button (Tauri dialog plugin).
 * Falls back to a plain text input in the browser mock, where no native
 * dialog exists.
 */
export function DirPicker({
  id,
  label,
  value,
  placeholder,
  onChange,
  onPicked,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  onPicked?: (path: string) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);

  const browse = (): void => {
    setBusy(true);
    void (async () => {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({ directory: true, multiple: false });
        if (typeof selected === 'string' && selected !== '') {
          onChange(selected);
          onPicked?.(selected);
        }
      } catch {
        // No dialog available (browser mock): user types the path.
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          id={id}
          className="input"
          placeholder={placeholder ?? '/path/to/repo'}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
        {isDesktop() && (
          <button
            className="btn"
            style={{ whiteSpace: 'nowrap' }}
            disabled={busy}
            onClick={browse}
            title="Choose a folder with the system picker"
          >
            {busy ? '…' : 'Browse…'}
          </button>
        )}
      </div>
    </div>
  );
}
