import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __setMockBackendForTests } from '../lib/backend';
import { useAppStore } from '../store';
import { TemplatesView } from './TemplatesView';

afterEach(() => vi.restoreAllMocks());

it('creates a template from pasted workflow JSON with no selected workflow', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  useAppStore.setState({
    builtinTemplates: [],
    userTemplates: [],
    activeWorkflowId: null,
  });
  const before = await backend.listWorkflows();
  render(<TemplatesView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Import JSON…' }));
  const text = JSON.stringify({
    version: 1,
    name: 'Direct template',
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [{ from: 'start', to: 'end' }],
  });
  await user.click(screen.getByRole('textbox', { name: 'Workflow or template JSON' }));
  await user.paste(text);
  await user.click(screen.getByRole('button', { name: 'Import into my library' }));
  expect(
    await screen.findByText("Imported template 'Direct template'."),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Direct template' })).toBeInTheDocument(),
  );
  expect(useAppStore.getState().activeWorkflowId).toBeNull();
  expect(await backend.listWorkflows()).toEqual(before);
});

it('leaves invalid pasted JSON editable with a clear validation error', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  useAppStore.setState({
    builtinTemplates: [],
    userTemplates: [],
    activeWorkflowId: null,
  });
  render(<TemplatesView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Import JSON…' }));
  const input = screen.getByRole('textbox', { name: 'Workflow or template JSON' });
  await user.click(input);
  const text = JSON.stringify({ version: 1, name: 'Broken', nodes: [], edges: [] });
  await user.paste(text);
  await user.click(screen.getByRole('button', { name: 'Import into my library' }));
  expect(await screen.findByText('Template workflow has no nodes.')).toBeInTheDocument();
  expect(input).toHaveValue(text);
  expect((await backend.listTemplates()).user).toHaveLength(0);
});
