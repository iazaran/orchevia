import { Component, type ReactNode } from 'react';
import { errorMessage } from '../lib/errors';
import { Notice } from './Notice';

/**
 * Last-resort crash net: if any view throws during render, show a recoverable
 * message instead of a blank window. Keyed by view so switching views resets it.
 */
export class ViewErrorBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(err: unknown): { error: string | null } {
    return { error: errorMessage(err) };
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="view">
          <Notice variant="error">
            <strong>This view crashed instead of rendering.</strong>
            <div className="tool-version" style={{ marginTop: 6 }}>
              {this.state.error}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                className="btn btn-primary"
                onClick={() => {
                  window.location.reload();
                }}
              >
                Reload app
              </button>
            </div>
            <p className="field-hint">
              Your workflows and history live in local SQLite — reloading loses nothing
              saved.
            </p>
          </Notice>
        </div>
      );
    }
    return this.props.children;
  }
}
