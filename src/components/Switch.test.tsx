import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { Switch } from './Switch';

it('is an accessible switch that reports the next state', async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(
    <Switch
      checked={false}
      onChange={onChange}
      label="Run schedule 'Nightly'"
      onText="On"
      offText="Paused"
    />,
  );
  const toggle = screen.getByRole('switch', { name: "Run schedule 'Nightly'" });
  expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(toggle).toHaveTextContent('Paused');
  await user.click(toggle);
  expect(onChange).toHaveBeenCalledWith(true);
  rerender(
    <Switch
      checked
      onChange={onChange}
      label="Run schedule 'Nightly'"
      onText="On"
      offText="Paused"
      busy
    />,
  );
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(toggle).toHaveTextContent('On');
  expect(toggle).toBeDisabled();
  expect(toggle).toHaveAttribute('aria-busy', 'true');
});
