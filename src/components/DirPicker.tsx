import { useState } from 'react';
import { useDraftText } from './DraftText';

function isDesktop(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  );
}

/**
 * Path field with a native Browse button (Tauri dialog plugin): a folder by
 * default, or a file with `pick="file"`. Falls back to a plain text input in
 * the browser mock, where no native dialog exists.
 */
export function DirPicker({
  id,
  label,
  value,
  placeholder,
  onChange,
  onPicked,
  pick = 'folder',
  fromPicked,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  onPicked?: (path: string) => void;
  /** What the system picker chooses. */
  pick?: 'folder' | 'file';
  /** Rewrite a picked path before it is stored (e.g. relative to a folder). */
  fromPicked?: (path: string) => string;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  // Callers store the path trimmed; keep a typed space (`My Repo`) visible.
  const [shown, setDraft] = useDraftText(value, (text) => text.trim());

  const browse = (): void => {
    setBusy(true);
    void (async () => {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({ directory: pick === 'folder', multiple: false });
        if (typeof selected === 'string' && selected !== '') {
          const path = fromPicked ? fromPicked(selected) : selected;
          onChange(path);
          onPicked?.(path);
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
          value={shown}
          onChange={(e) => {
            setDraft(e.target.value);
            onChange(e.target.value);
          }}
        />
        {isDesktop() && (
          <button
            className="btn"
            style={{ whiteSpace: 'nowrap' }}
            disabled={busy}
            onClick={browse}
            title={`Choose a ${pick} with the system picker`}
          >
            {busy ? '…' : 'Browse…'}
          </button>
        )}
      </div>
    </div>
  );
}
