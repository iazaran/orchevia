import {
  Children,
  isValidElement,
  useEffect,
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type AnimationEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useAppStore, type UiNotice } from '../store';
import { CloseButton } from './CloseButton';

interface NoticeProps {
  variant?: 'info' | 'warn' | 'error';
  /** A new action may produce the same text as an earlier message. */
  eventId?: number;
  onDismiss?: () => void;
  dismissLabel?: string;
  role?: 'status' | 'alert' | 'form';
  style?: CSSProperties;
  className?: string;
  /** Contextual content (previews and saved run details), rather than an alert. */
  inline?: boolean;
  onAnimationEnd?: (event: AnimationEvent<HTMLDivElement>) => void;
  children: ReactNode;
}

function contentText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? contentText(child.props.children)
        : typeof child === 'string' ||
            typeof child === 'number' ||
            typeof child === 'bigint'
          ? String(child)
          : '',
    )
    .join('');
}

/** Keep explicit severity alongside views that also need their latest message. */
export function useNoticeMessage(
  defaultVariant: 'info' | 'warn' | 'error' = 'info',
): [
  string | null,
  (text: string | null, variant?: 'info' | 'warn' | 'error') => void,
  'info' | 'warn' | 'error',
  number,
] {
  const [message, setMessage] = useState<{
    text: string | null;
    variant: 'info' | 'warn' | 'error';
    eventId: number;
  }>({ text: null, variant: defaultVariant, eventId: 0 });
  const update = useCallback(
    (text: string | null, variant: 'info' | 'warn' | 'error' = defaultVariant): void =>
      setMessage((previous) => ({ text, variant, eventId: previous.eventId + 1 })),
    [defaultVariant],
  );
  return [message.text, update, message.variant, message.eventId];
}

/** Shared feedback: queued outside the layout; inline only for contextual content. */
export function Notice(props: NoticeProps): React.JSX.Element | null {
  const push = useAppStore((s) => s.pushUiNotice);
  const published = useRef<string | null>(null);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
    if (props.inline === true) return;
    // JSX and callbacks are often recreated on a parent render. Only a new
    // message/severity emits an alert, so rerenders do not restart its lifetime.
    const identity = JSON.stringify([
      props.eventId,
      props.variant,
      props.role,
      contentText(props.children),
    ]);
    if (published.current === identity) return;
    published.current = identity;
    push({
      content: props.children,
      ...(props.variant === undefined ? {} : { variant: props.variant }),
      ...(props.role === undefined ? {} : { role: props.role }),
      ...(props.dismissLabel === undefined ? {} : { dismissLabel: props.dismissLabel }),
      ...(props.onDismiss === undefined
        ? {}
        : {
            onDismiss: () => {
              // Closing an older stacked message must not clear a newer one.
              if (published.current === identity) latest.current.onDismiss?.();
            },
          }),
    });
  });
  if (props.inline !== true) return null;
  return <NoticeBody {...props} />;
}

function NoticeBody({
  variant,
  onDismiss,
  dismissLabel,
  role,
  style,
  className,
  onAnimationEnd,
  children,
}: NoticeProps): React.JSX.Element {
  return (
    <div
      className={`notice${variant !== undefined ? ` ${variant}` : ''}${onDismiss !== undefined ? ' has-dismiss' : ''}${className !== undefined ? ` ${className}` : ''}`}
      role={role ?? (variant === 'error' ? 'alert' : 'status')}
      style={style}
      onAnimationEnd={onAnimationEnd}
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

function FloatingNotice({ notice }: { notice: UiNotice }): React.JSX.Element {
  const remove = useAppStore((s) => s.removeUiNotice);
  const [exiting, setExiting] = useState(false);
  const dismissed = useRef(false);
  const finishExit = useCallback((): void => {
    if (dismissed.current) return;
    dismissed.current = true;
    remove(notice.id);
    notice.onDismiss?.();
  }, [notice, remove]);
  useEffect(() => {
    if (notice.variant === 'warn' || notice.variant === 'error') return;
    const timer = setTimeout(() => setExiting(true), 5000);
    return () => clearTimeout(timer);
  }, [notice.id, notice.variant]);
  useEffect(() => {
    if (!exiting) return;
    // Fallback for reduced motion or a missing animation event.
    const timer = setTimeout(finishExit, 200);
    return () => clearTimeout(timer);
  }, [exiting, finishExit]);
  return (
    <NoticeBody
      {...(notice.variant === undefined ? {} : { variant: notice.variant })}
      {...(notice.role === undefined ? {} : { role: notice.role })}
      {...(notice.dismissLabel === undefined
        ? {}
        : { dismissLabel: notice.dismissLabel })}
      onAnimationEnd={(event) => {
        if (
          exiting &&
          event.target === event.currentTarget &&
          event.animationName === 'notice-exit'
        )
          finishExit();
      }}
      className={`floating-notice${exiting ? ' notice-exiting' : ''}`}
      {...(notice.variant === 'warn' ||
      notice.variant === 'error' ||
      notice.onDismiss !== undefined
        ? {
            onDismiss: () => setExiting(true),
          }
        : {})}
    >
      {notice.content}
    </NoticeBody>
  );
}

/** One body portal keeps feedback above canvas, dialogs, and clipped panels. */
export function NoticeHost(): React.JSX.Element | null {
  const notices = useAppStore((s) => s.uiNotices);
  if (notices.length === 0) return null;
  return createPortal(
    <div className="notice-stack" role="region" aria-label="Messages">
      {notices.map((notice) => (
        <FloatingNotice key={notice.id} notice={notice} />
      ))}
    </div>,
    document.body,
  );
}
