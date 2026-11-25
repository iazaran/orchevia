import { useRef } from 'react';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Tooltip with more detail than the label. */
  title?: string;
}

/**
 * Shared segmented switch for choosing one of two to five views or modes
 * (Simple / Advanced JSON, cadence, date range). It is a radio group: one
 * tab stop, arrow keys move and select, and screen readers hear "radio, 1 of
 * 2, checked". Use `Switch` for on/off settings and plain buttons for actions.
 */
export function Segmented<T extends string>({
  label,
  labelledBy,
  value,
  options,
  onChange,
  disabled,
  size,
  className,
}: {
  /** Accessible name of the group, e.g. "JSON format". */
  label?: string;
  /** Id of a visible label; used instead of `label` when set. */
  labelledBy?: string;
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (next: T) => void;
  disabled?: boolean;
  size?: 'small';
  className?: string;
}): React.JSX.Element {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const move = (index: number): void => {
    const count = options.length;
    const target = ((index % count) + count) % count;
    const next = options[target];
    if (next === undefined) return;
    refs.current[target]?.focus();
    if (next.value !== value) onChange(next.value);
  };
  return (
    <div
      role="radiogroup"
      aria-label={labelledBy === undefined ? label : undefined}
      aria-labelledby={labelledBy}
      aria-disabled={disabled === true ? true : undefined}
      className={`segmented${size === 'small' ? ' segmented-small' : ''}${className === undefined ? '' : ` ${className}`}`}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={index === selectedIndex ? 0 : -1}
            title={option.title}
            disabled={disabled}
            className={`segmented-option${checked ? ' is-selected' : ''}`}
            onClick={() => {
              if (!checked) onChange(option.value);
            }}
            onKeyDown={(event) => {
              const step =
                event.key === 'ArrowRight' || event.key === 'ArrowDown'
                  ? 1
                  : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                    ? -1
                    : 0;
              if (step !== 0) {
                event.preventDefault();
                move(index + step);
              } else if (event.key === 'Home') {
                event.preventDefault();
                move(0);
              } else if (event.key === 'End') {
                event.preventDefault();
                move(options.length - 1);
              }
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
