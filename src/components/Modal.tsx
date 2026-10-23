import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CloseButton } from './CloseButton';

/**
 * Shared modal shell: backdrop + card + red corner ✕. Replaces the repeated
 * `modal-backdrop`/`modal-card` markup — do not hand-roll modal shells
 * elsewhere. Pass `onBackdrop` only when clicking outside should close;
 * `onClose` renders the ✕ (omit it for forced-choice dialogs).
 */
export function Modal({
  label,
  onClose,
  closeLabel,
  closeDisabled,
  onBackdrop,
  maxWidth,
  style,
  role,
  children,
}: {
  label: string;
  onClose?: () => void;
  closeLabel?: string;
  closeDisabled?: boolean;
  onBackdrop?: () => void;
  maxWidth?: number;
  style?: CSSProperties;
  role?: 'dialog' | 'alertdialog';
  children: ReactNode;
}): React.JSX.Element {
  const backdrop = useRef<HTMLDivElement>(null);
  // Read during the first render: by the time effects run, an autoFocus
  // inside the dialog has already moved focus away from the opener.
  const [opener] = useState(() => document.activeElement);
  // Only a press that starts on the backdrop closes: selecting text in a
  // field and letting go outside the card must not.
  const pressedBackdrop = useRef(false);
  const close = useRef({ onClose, closeDisabled });
  useEffect(() => {
    close.current = { onClose, closeDisabled };
  }, [onClose, closeDisabled]);
  useEffect(() => {
    const dialog = backdrop.current;
    if (dialog === null) return;
    const focusable = (): HTMLElement[] =>
      [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
        ),
        ...document.querySelectorAll<HTMLElement>(
          '.notice-stack button:not(:disabled), .notice-stack a[href]',
        ),
      ].filter((element) => !element.closest('[hidden], .notice-exiting'));
    const field = dialog.querySelector<HTMLElement>(
      'input:not(:disabled), textarea:not(:disabled), select:not(:disabled)',
    );
    (field ?? focusable()[0] ?? dialog).focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      // Only the top dialog handles keys when a confirmation opens over it.
      const dialogs = document.querySelectorAll('[aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== dialog) return;
      if (
        event.key === 'Escape' &&
        close.current.onClose !== undefined &&
        close.current.closeDisabled !== true
      ) {
        event.preventDefault();
        event.stopPropagation();
        close.current.onClose();
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      // Portal notices live after the application in DOM order. Handle every
      // Tab explicitly so background controls cannot receive focus in between.
      event.preventDefault();
      if (elements.length === 0) {
        dialog.focus();
      } else {
        const index = elements.findIndex((element) => element === document.activeElement);
        const next =
          index < 0
            ? event.shiftKey
              ? elements.length - 1
              : 0
            : (index + (event.shiftKey ? -1 : 1) + elements.length) % elements.length;
        elements[next]?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [opener]);
  return (
    <div
      ref={backdrop}
      tabIndex={-1}
      className="modal-backdrop"
      role={role ?? 'dialog'}
      aria-modal="true"
      aria-label={label}
      onMouseDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const fromBackdrop =
          pressedBackdrop.current && event.target === event.currentTarget;
        pressedBackdrop.current = false;
        if (fromBackdrop) onBackdrop?.();
      }}
    >
      <section
        className="modal-card"
        style={{ ...(maxWidth !== undefined ? { maxWidth } : {}), ...style }}
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        {onClose !== undefined && (
          <CloseButton
            variant="modal"
            label={closeLabel ?? 'Close'}
            onClose={onClose}
            {...(closeDisabled === undefined ? {} : { disabled: closeDisabled })}
          />
        )}
        {children}
      </section>
    </div>
  );
}
