import { useEffect, useId, useState, type ReactNode } from 'react';
import { getBackend } from '../lib/backend';

/**
 * Branch text field with repo branch suggestions. Typing anything is always
 * allowed (new branches included); when the repo directory is known the
 * existing branches appear as suggestions.
 */
export function BranchPicker({
  id,
  label,
  repoDir,
  value,
  placeholder,
  onChange,
  action,
}: {
  id: string;
  label: string;
  repoDir: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  action?: ReactNode;
}): React.JSX.Element {
  const datalistId = useId();
  const [branches, setBranches] = useState<string[]>([]);
  useEffect(() => {
    const dir = repoDir.trim();
    if (dir === '') {
      setBranches([]);
      return;
    }
    let alive = true;
    void getBackend()
      .gitBranches(dir)
      .then((b) => {
        if (alive) setBranches(b.branches);
      })
      .catch(() => {
        if (alive) setBranches([]);
      });
    return () => {
      alive = false;
    };
  }, [repoDir]);
  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
        {action}
      </div>
      <input
        id={id}
        className="input"
        list={branches.length > 0 ? datalistId : undefined}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        placeholder={placeholder ?? 'feature/my-work'}
      />
      {branches.length > 0 && (
        <datalist id={datalistId}>
          {branches.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
      )}
    </div>
  );
}
