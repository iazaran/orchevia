import type { CSSProperties, ReactNode } from 'react';
import { CloseButton } from './CloseButton';

/**
 * Shared banner (info/warning/error) with optional top-right dismiss.
 * Replaces the repeated `{message && <div className="notice">…` blocks —
 * do not hand-roll banner markup elsewhere.
 */
export function Notice({
  variant,
  onDismiss,
  dismissLabel,
  role,
  style,
  className,
  children,
}: {
  variant?: 'warn' | 'error';
  onDismiss?: () => void;
  dismissLabel?: string;
  role?: 'status' | 'alert' | 'form';
  style?: CSSProperties;
  className?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={`notice${variant !== undefined ? ` ${variant}` : ''}${onDismiss !== undefined ? ' has-dismiss' : ''}${className !== undefined ? ` ${className}` : ''}`}
      role={role ?? (variant === 'error' ? 'alert' : 'status')}
      style={style}
    >
      {children}
      {onDismiss !== undefined && (
        <CloseButton
          variant="notice"
          label={dismissLabel ?? 'Dismiss message'}
          onClose={onDismiss}
        />
      )}
    </div>
  );
}
