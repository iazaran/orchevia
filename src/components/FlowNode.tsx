import { memo } from 'react';
import { Handle, Position as FlowPosition, type NodeProps } from '@xyflow/react';
import { NODE_KIND_META, type NodeKind } from '../lib/workflow';

export interface CanvasNodeData extends Record<string, unknown> {
  direction?: 'vertical' | 'horizontal';
  label: string;
  kind: NodeKind;
  detail?: string | undefined;
  selected: boolean;
  /** Latest run status for overlay display (pending/running/succeeded/...). */
  runStatus?: string | undefined;
  /** Validation severity for this node (error/warning). */
  issueSeverity?: 'error' | 'warning' | undefined;
  /** Hover/focus reporting for connection highlighting (absent when read-only). */
  onHover?: ((nodeId: string | null) => void) | undefined;
}

const KIND_ICONS: Record<NodeKind, string> = {
  start: '●',
  command: '▸',
  approval: '⏸',
  agent: '✦',
  condition: '◆',
  git: '⑂',
  github: '⌾',
  ticket: '▤',
  mcp: '⬡',
  end: '■',
};

function FlowNode({ data, id }: NodeProps): React.JSX.Element {
  const node = data as unknown as CanvasNodeData;
  const meta = NODE_KIND_META[node.kind];
  return (
    <div
      className={`orchevia-node${node.selected ? ' selected' : ''}${node.runStatus !== undefined ? ` run-${node.runStatus}` : ''}${node.issueSeverity !== undefined ? ` issue-${node.issueSeverity}` : ''}`}
      style={{ ['--node-accent' as string]: meta.accent }}
      // Keyboard focus bubbles here from React Flow's focusable node wrapper
      // (@xyflow/react has no onNodeFocus prop), so Tab reaches the same
      // connection highlight as pointer hover.
      onFocus={() => node.onHover?.(id)}
      onBlur={() => node.onHover?.(null)}
    >
      <Handle
        type="target"
        position={node.direction === 'horizontal' ? FlowPosition.Left : FlowPosition.Top}
      />
      <div className="orchevia-node-kind">
        <span className="node-kind-icon" aria-hidden="true">
          {KIND_ICONS[node.kind]}
        </span>
        {meta.label}
        {node.runStatus !== undefined && (
          <span className={`node-status status-${node.runStatus}`}>{node.runStatus}</span>
        )}
      </div>
      <div className="orchevia-node-title">{node.label}</div>
      {node.detail !== undefined && node.detail !== '' && (
        <div className="orchevia-node-detail" title={node.detail}>
          {node.detail}
        </div>
      )}
      <Handle
        type="source"
        position={
          node.direction === 'horizontal' ? FlowPosition.Right : FlowPosition.Bottom
        }
      />
    </div>
  );
}

export const OrcheviaFlowNode = memo(FlowNode);
