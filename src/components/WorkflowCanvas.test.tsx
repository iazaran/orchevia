import { afterEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkflowCanvas } from './WorkflowCanvas';
import { createEmptyWorkflow } from '../lib/workflow';
import { useAppStore } from '../store';
afterEach(() => vi.unstubAllGlobals());
it('changes arrangement only after Arrange and preserves connections/config', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  const wf = createEmptyWorkflow('Layout');
  const update = vi.fn();
  useAppStore.setState({
    selectedNodeId: null,
    selectedEdgeId: null,
    validation: [],
    overlayResults: [],
    profiles: [],
    updateActiveWorkflow: update,
  });
  render(<WorkflowCanvas workflow={wf} />);
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('Arrange direction'), 'horizontal');
  expect(update).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '⤢ Arrange' }));
  expect(update).toHaveBeenCalledTimes(1);
  const changed = update.mock.calls[0]?.[0] as typeof wf;
  expect(changed.edges).toEqual(wf.edges);
  expect(changed.nodes.map((n) => n.config)).toEqual(wf.nodes.map((n) => n.config));
  expect(changed.nodes[1]?.position.x).toBeGreaterThan(changed.nodes[0]?.position.x ?? 0);
});

it('disables graph mutations while inspecting a run snapshot', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  render(<WorkflowCanvas workflow={createEmptyWorkflow('Snapshot')} readOnly />);
  expect(screen.getByRole('button', { name: '⤢ Arrange' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '+ CLI / Command' })).toBeDisabled();
  expect(screen.getByLabelText('Arrange direction')).toBeDisabled();
});

it('synchronizes added, removed and repositioned nodes from JSON edits', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  const wf = createEmptyWorkflow('External edit');
  const { rerender, container } = render(<WorkflowCanvas workflow={wf} />);
  const next = structuredClone(wf);
  next.nodes.push({
    id: 'added',
    type: 'command',
    label: 'Added by JSON',
    position: { x: 300, y: 400 },
    config: { executable: 'echo', args: ['hello'] },
  });
  next.nodes = next.nodes.filter((n) => n.type !== 'end');
  if (next.nodes[0]) next.nodes[0].position = { x: 100, y: 200 };
  rerender(<WorkflowCanvas workflow={next} />);
  expect(await screen.findByText('Added by JSON')).toBeInTheDocument();
  expect(screen.queryByText('End')).toBeNull();
  expect(container.querySelector(`[data-id="${wf.nodes[0]?.id ?? ''}"]`)).toHaveStyle({
    transform: 'translate(100px,200px)',
  });
});
