import { expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkflowsView } from './WorkflowsView';
import { __setMockBackendForTests } from '../lib/backend';
import { createEmptyWorkflow } from '../lib/workflow';
import { useAppStore } from '../store';
vi.mock('./WorkflowCanvas', () => ({ WorkflowCanvas: () => null }));
vi.mock('./NodeInspector', () => ({ NodeInspector: () => null }));
it('opens simple JSON and preserves the definition through advanced conversion', async () => {
  const backend = __setMockBackendForTests();
  const wf = createEmptyWorkflow('Editable');
  const stored = await backend.saveWorkflow(wf);
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: wf.id,
    profiles: [],
    validation: [],
    overlayRunId: null,
  });
  render(<WorkflowsView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'JSON' }));
  const editor = screen.getByLabelText<HTMLTextAreaElement>('Workflow JSON');
  await waitFor(() => expect(editor.value).toContain('"version": 1'));
  expect(editor.value).not.toContain('position');
  await user.click(screen.getByRole('button', { name: 'Advanced JSON' }));
  await waitFor(() => expect(editor.value).toContain('"position"'));
  await user.click(screen.getByRole('button', { name: 'Save JSON' }));
  await waitFor(() =>
    expect(screen.queryByLabelText('Workflow JSON')).not.toBeInTheDocument(),
  );
  expect((await backend.getWorkflow(wf.id))?.definition).toEqual(wf);
});
