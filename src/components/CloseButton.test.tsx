import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CloseButton } from './CloseButton';

describe('close button', () => {
  it('maps variants to the shared dismiss classes', () => {
    const { rerender } = render(
      <CloseButton variant="modal" label="Close" onClose={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Close' }).className).toContain(
      'modal-dismiss',
    );
    rerender(<CloseButton variant="card" label="Close" onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Close' }).className).toContain(
      'card-dismiss',
    );
    rerender(<CloseButton variant="notice" label="Close" onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Close' }).className).toContain(
      'notice-dismiss',
    );
    rerender(
      <CloseButton variant="ghost" label="Close" onClose={() => {}}>
        Dismiss ✕
      </CloseButton>,
    );
    expect(screen.getByRole('button', { name: 'Close' }).textContent).toBe('Dismiss ✕');
  });

  it('fires onClose and honors disabled', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <CloseButton variant="modal" label="Close me" onClose={onClose} />,
    );
    await user.click(screen.getByRole('button', { name: 'Close me' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<CloseButton variant="modal" label="Locked" onClose={onClose} disabled />);
    expect(screen.getByRole('button', { name: 'Locked' })).toBeDisabled();
  });
});
