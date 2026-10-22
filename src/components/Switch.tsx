/**
 * Shared on/off switch for settings that apply at once and for pausing
 * automations from their cards. It is a real button with `role="switch"`, so
 * keyboards and screen readers get its state. `label` names what it controls;
 * the visible `onText`/`offText` says the current state. Use it instead of
 * hand-rolled checkboxes for live toggles (forms with a Save button keep
 * checkboxes).
 */
export function Switch({
  checked,
  onChange,
  label,
  onText,
  offText,
  title,
  disabled,
  busy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name, e.g. "Run schedule 'Nightly review'". */
  label: string;
  onText?: string;
  offText?: string;
  title?: string;
  disabled?: boolean;
  /** Saving: disabled and announced as busy. */
  busy?: boolean;
}): React.JSX.Element {
  const stateText = checked ? onText : offText;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy === true ? true : undefined}
      title={title ?? label}
      className={`switch${checked ? ' is-on' : ''}`}
      disabled={disabled === true || busy === true}
      onClick={() => {
        onChange(!checked);
      }}
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      {stateText !== undefined && <span className="switch-text">{stateText}</span>}
    </button>
  );
}
