import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { __setMockBackendForTests } from '../lib/backend';
import { builtinTemplates } from '../lib/templates';
import { createEmptyWorkflow } from '../lib/workflow';
import { useAppStore } from '../store';
import { HomeView } from './HomeView';
import { CommandPalette, paletteMatches } from './CommandPalette';

afterEach(() => {
  vi.restoreAllMocks();
});

function seed(): void {
  __setMockBackendForTests();
  const workflow = createEmptyWorkflow('Weekly report');
  const now = new Date().toISOString();
  useAppStore.setState({
    view: 'home',
    workflows: [
      {
        id: workflow.id,
        name: workflow.name,
        definition: workflow,
        createdAt: now,
        updatedAt: now,
      },
    ],
    runs: [
      { id: 'r-wait', workflowId: workflow.id, status: 'paused', startedAt: now },
      {
        id: 'r-fail',
        workflowId: workflow.id,
        status: 'failed',
        startedAt: now,
        finishedAt: now,
      },
    ],
    profiles: [],
    schedules: [],
    watchers: [],
    builtinTemplates: builtinTemplates(),
    userTemplates: [],
    pendingIntent: null,
    templateDomain: 'all',
    templateQuery: '',
  });
}

it('drafts a typed goal in the generator and starts from a kind of work', () => {
  seed();
  render(<HomeView />);
  const goal = screen.getByLabelText('Describe what you want done');
  const draft = screen.getByRole('button', { name: /Draft a workflow/ });
  expect(draft).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: /Turn meeting notes/ }));
  expect(goal).toHaveValue('Turn meeting notes into action items and a follow-up email');
  fireEvent.click(draft);
  expect(useAppStore.getState().pendingIntent).toEqual({
    kind: 'generate',
    goal: 'Turn meeting notes into action items and a follow-up email',
  });
  expect(useAppStore.getState().view).toBe('workflows');

  useAppStore.setState({ view: 'home' });
  fireEvent.click(screen.getByRole('button', { name: /Media & design/ }));
  expect(useAppStore.getState().templateDomain).toBe('media');
  expect(useAppStore.getState().view).toBe('templates');
});

it('lists what needs you, the setup left and recent work', () => {
  seed();
  render(<HomeView />);
  const attention = screen.getByRole('region', { name: 'Needs you' });
  expect(within(attention).getByText('Waiting')).toBeInTheDocument();
  expect(within(attention).getByText('Failed')).toBeInTheDocument();
  const setup = screen.getByRole('region', { name: /Get set up · 1 of 3/ });
  const done = within(setup).getByText('Run your first workflow').closest('li');
  expect(done).toHaveClass('done');
  expect(done).toHaveTextContent('(done)');
  fireEvent.click(within(setup).getAllByRole('button', { name: 'Start' })[0]!);
  expect(useAppStore.getState().view).toBe('agents');
  useAppStore.setState({ view: 'home' });
  const workflows = screen.getByRole('region', { name: 'Your workflows' });
  fireEvent.click(within(workflows).getByRole('button', { name: 'Run Weekly report' }));
  expect(useAppStore.getState().pendingIntent).toEqual({ kind: 'run' });
  expect(useAppStore.getState().view).toBe('workflows');
});

it('finds views, workflows, templates and drafts from a long query', () => {
  seed();
  const onClose = vi.fn();
  render(<CommandPalette onClose={onClose} onOpenWizard={() => undefined} />);
  const box = screen.getByRole('combobox', {
    name: 'Search views, workflows, templates and actions',
  });
  expect(box).toHaveFocus();
  fireEvent.change(box, { target: { value: 'run weekly' } });
  expect(screen.getByRole('option', { name: /Run Weekly report/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(onClose).toHaveBeenCalled();
  expect(useAppStore.getState().pendingIntent).toEqual({ kind: 'run' });

  fireEvent.change(box, { target: { value: 'video cuts' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(useAppStore.getState().view).toBe('templates');
  expect(useAppStore.getState().templateQuery).toBe('Social Video Cuts');

  fireEvent.change(box, { target: { value: 'summarize my inbox every morning' } });
  const draft = screen.getByRole('option', { name: /Draft a workflow/ });
  fireEvent.click(draft);
  expect(useAppStore.getState().pendingIntent).toEqual({
    kind: 'generate',
    goal: 'summarize my inbox every morning',
  });
  expect(
    paletteMatches(
      {
        id: 'x',
        label: 'Usage & costs',
        group: 'Go to',
        icon: 'usage',
        run: () => undefined,
      },
      'GO usage',
    ),
  ).toBe(true);
});

it('moves through results with the arrow keys', () => {
  seed();
  render(<CommandPalette onClose={() => undefined} onOpenWizard={() => undefined} />);
  const box = screen.getByRole('combobox');
  const options = screen.getAllByRole('option');
  expect(options[0]).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(box, { key: 'ArrowUp' });
  fireEvent.keyDown(box, { key: 'ArrowUp' });
  const all = screen.getAllByRole('option');
  expect(all[all.length - 1]).toHaveAttribute('aria-selected', 'true');
  expect(box).toHaveAttribute('aria-activedescendant', all[all.length - 1]?.id);
});
