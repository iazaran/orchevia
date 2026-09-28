import { useEffect, useState } from 'react';
import { Modal } from './Modal';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

type Pending = { opts: ConfirmOptions; resolve: (v: boolean) => void };

let requestHandler:
  ((opts: ConfirmOptions, resolve: (v: boolean) => void) => void) | null = null;

/**
 * In-app confirmation with a real title. When the host is not mounted yet
 * (e.g. a call during first render), it resolves `false` — cancelling the
 * action — instead of falling back to a native dialog. Orchevia never shows
 * `window.confirm`/`window.prompt`/`alert` anywhere.
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  if (requestHandler === null) {
    console.warn(`confirmDialog without host, cancelling: ${opts.title}`);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    requestHandler?.(opts, resolve);
  });
}

export function ConfirmHost(): React.JSX.Element | null {
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    requestHandler = (opts, resolve) => {
      setPending({ opts, resolve });
    };
    return () => {
      requestHandler = null;
    };
  }, []);

  if (pending === null) return null;
  const close = (v: boolean): void => {
    pending.resolve(v);
    setPending(null);
  };
  const { opts } = pending;
  return (
    <Modal
      label={opts.title}
      role="alertdialog"
      onBackdrop={() => {
        close(false);
      }}
      maxWidth={480}
    >
      <div>
        <h3 style={{ marginTop: 0 }}>{opts.title}</h3>
        <p className="field-hint">{opts.message}</p>
        <div
          style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}
        >
          <button className="btn" onClick={() => close(false)}>
            Cancel
          </button>
          <button
            className={opts.danger === true ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={() => close(true)}
            autoFocus
          >
            {opts.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
