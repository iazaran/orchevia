import { useState, type ReactNode } from 'react';

/** One rule per line (commas also separate); blank lines are dropped. */
export function parseToolRules(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((rule) => rule.trim())
    .filter((rule) => rule !== '');
}

/**
 * Editable list of Claude Code allow rules. Keeps the typed text as a draft so
 * a new line can be started; the parent receives the parsed rules. Remount
 * with a `key` when the edited object changes.
 */
export function ToolRulesField({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  id: string;
  label: string;
  value: string[];
  onChange: (rules: string[]) => void;
  placeholder?: string;
  hint?: ReactNode;
}): React.JSX.Element {
  const [draft, setDraft] = useState(() => value.join('\n'));
  // Show external changes (e.g. rules added from a run) without losing typing.
  const shown =
    parseToolRules(draft).join('\n') === value.join('\n') ? draft : value.join('\n');
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="textarea"
        rows={3}
        spellCheck={false}
        value={shown}
        placeholder={placeholder}
        onChange={(e) => {
          setDraft(e.target.value);
          onChange(parseToolRules(e.target.value));
        }}
      />
      {hint !== undefined && <span className="field-hint">{hint}</span>}
    </div>
  );
}
