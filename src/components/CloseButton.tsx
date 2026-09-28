import type { CSSProperties, ReactNode } from 'react';

/**
 * Single shared close/dismiss button for modals, cards, banners, and inline
 * ghost actions. One component guarantees the red-on-hover ✕ language stays
 * consistent — do not hand-roll ✕ buttons elsewhere.
 */
export function CloseButton({
  variant,
  onClose,
  label,
  title,
  disabled,
  style,
  children,
}: {
  variant: 'modal' | 'card' | 'notice' | 'ghost';
  onClose: () => void;
  /** Accessible name, e.g. "Close samples" or "Dismiss message". */
  label: string;
  title?: string;
  disabled?: boolean;
  style?: CSSProperties;
  children?: ReactNode;
}): React.JSX.Element {
  if (variant === 'ghost') {
    return (
      <button
        type="button"
        className="btn btn-ghost danger-hover"
        aria-label={label}
        title={title ?? label}
        disabled={disabled}
        style={style}
        onClick={onClose}
      >
        {children ?? '✕'}
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`${variant}-dismiss`}
      title={title ?? label}
      aria-label={label}
      disabled={disabled}
      style={style}
      onClick={onClose}
    >
      {children ?? '✕'}
    </button>
  );
}
