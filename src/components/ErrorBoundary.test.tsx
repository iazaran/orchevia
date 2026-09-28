import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ViewErrorBoundary } from './ErrorBoundary';

function Boom(): React.JSX.Element {
  throw new Error('canvas exploded');
}

describe('view error boundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <ViewErrorBoundary>
        <span>all good</span>
      </ViewErrorBoundary>,
    );
    expect(screen.getByText('all good')).toBeDefined();
  });

  it('shows a recoverable message instead of a blank window', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <ViewErrorBoundary>
          <Boom />
        </ViewErrorBoundary>,
      );
      expect(screen.getByRole('alert')).toBeDefined();
      expect(screen.getByText(/crashed instead of rendering/)).toBeDefined();
      expect(screen.getByText('Reload app')).toBeDefined();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
