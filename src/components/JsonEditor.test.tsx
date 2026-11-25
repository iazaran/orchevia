import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { JsonEditor, JsonView } from './JsonEditor';
import { Segmented } from './Segmented';

afterEach(cleanup);

function Harness({ initial }: { initial: string }): React.JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="doc">Document</label>
      <JsonEditor id="doc" value={value} onChange={setValue} />
    </>
  );
}

it('colors tokens, marks the broken line and explains the error', () => {
  const { container } = render(<Harness initial={'{\n  "a": 1\n  "b": true\n}'} />);
  const input = screen.getByLabelText('Document');
  expect(input).toHaveAttribute('aria-invalid', 'true');
  const message =
    'Line 2, column 8: Add a comma after this value, or a } to close the object.';
  expect(screen.getByText(message)).toBeVisible();
  expect(input).toHaveAccessibleDescription(message);
  expect(container.querySelector('.json-gutter .is-error')?.textContent).toBe('2');
  expect(container.querySelector('.json-line.is-error .json-mark')?.textContent).toBe(
    '1',
  );
  expect(container.querySelectorAll('.json-key')).toHaveLength(2);
  expect(container.querySelector('.json-boolean')?.textContent).toBe('true');
  expect(screen.getByRole('button', { name: 'Format' })).toBeDisabled();
});

it('formats valid JSON and reports its size', async () => {
  render(<Harness initial={'{"a":[1,2]}'} />);
  const input = screen.getByLabelText<HTMLTextAreaElement>('Document');
  expect(input).toHaveAttribute('aria-invalid', 'false');
  expect(screen.getByText('Valid JSON · 1 line')).toBeVisible();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Format' }));
  expect(input.value).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
  expect(screen.getByText('Valid JSON · 6 lines')).toBeVisible();
});

it('read-only views pretty-print values and strings', () => {
  const { container, rerender } = render(<JsonView value={{ ok: true }} />);
  expect(container.textContent).toBe('{  "ok": true}');
  rerender(<JsonView value={'not json'} />);
  expect(container.textContent).toBe('not json');
});

it('segmented switches select with clicks and arrow keys', () => {
  function Modes(): React.JSX.Element {
    const [mode, setMode] = useState<'a' | 'b' | 'c'>('a');
    return (
      <Segmented
        label="Mode"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
          { value: 'c', label: 'Gamma' },
        ]}
      />
    );
  }
  render(<Modes />);
  const group = screen.getByRole('radiogroup', { name: 'Mode' });
  expect(group).toBeInTheDocument();
  const alpha = screen.getByRole('radio', { name: 'Alpha' });
  expect(alpha).toBeChecked();
  expect(alpha).toHaveAttribute('tabindex', '0');
  expect(screen.getByRole('radio', { name: 'Beta' })).toHaveAttribute('tabindex', '-1');
  fireEvent.keyDown(alpha, { key: 'ArrowLeft' });
  expect(screen.getByRole('radio', { name: 'Gamma' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Gamma' })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('radio', { name: 'Gamma' }), { key: 'Home' });
  expect(alpha).toBeChecked();
  fireEvent.click(screen.getByRole('radio', { name: 'Beta' }));
  expect(screen.getByRole('radio', { name: 'Beta' })).toBeChecked();
});
