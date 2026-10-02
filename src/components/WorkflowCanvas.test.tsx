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
