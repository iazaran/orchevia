import { useState } from 'react';
import { getBackend } from '../lib/backend';
import { referencedVariables } from '../lib/agents';
import { parseCondition, renderCondition, type ConditionOp } from '../lib/conditions';
import { NODE_KIND_META, setWorkflowDefaults, type Workflow } from '../lib/workflow';
import { DirPicker } from './DirPicker';
import { BranchPicker } from './BranchPicker';
import { Notice } from './Notice';
import { useAppStore } from '../store';
import { errorMessage } from '../lib/errors';

const CONDITION_OPS: { value: ConditionOp; label: string }[] = [
  { value: 'equals', label: '== equals' },
  { value: 'notEquals', label: '!= not equals' },
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'not contains' },
  { value: 'greater', label: '> greater than' },
  { value: 'less', label: '< less than' },
  { value: 'greaterOrEqual', label: '>= at least' },
  { value: 'lessOrEqual', label: '<= at most' },
];

const EDGE_LABELS = ['', 'success', 'failure', 'true', 'false'];

function useNodeConfig(
  workflow: Workflow,
  nodeId: string,
): {
  patchNode: (config: WorkflowNode['config'], label?: string) => void;
} {
  const updateActiveWorkflow = useAppStore((s) => s.updateActiveWorkflow);
  const patchNode = (config: WorkflowNode['config'], label?: string): void => {
    updateActiveWorkflow({
      ...workflow,
      nodes: workflow.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const updated = { ...n, config };
        if (label === undefined) {
          delete updated.label;
        } else {
          updated.label = label;
        }
        return updated;
      }),
    });
  };
  return { patchNode };
}

type WorkflowNode = import('../lib/workflow').WorkflowNode;

const GIT_OPS = [
  'status',
  'diffSummary',
  'branchCreate',
  'checkout',
  'stage',
  'commit',
  'worktreeAdd',
  'worktreeRemove',
  'worktreeList',
  'remotes',
] as const;

export function GitEditor({
  workflow,
  nodeId,
}: {
  workflow: Workflow;
  nodeId: string;
}): React.JSX.Element {
  const { patchNode } = useNodeConfig(workflow, nodeId);
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (node === undefined) return <></>;
  const op = node.config.gitOp ?? { op: 'status' as const };
  const setOp = (next: typeof op): void => {
    patchNode({ ...node.config, gitOp: next }, node.label);
  };
  const setWorkdir = (value: string): void => {
    const config = { ...node.config };
    if (value.trim() === '') {
      delete config.workingDir;
    } else {
      config.workingDir = value;
    }
    patchNode(config, node.label);
  };
  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor={`git-op-${nodeId}`}>
          Operation
        </label>
        <select
          id={`git-op-${nodeId}`}
          className="input"
          value={op.op}
          onChange={(e) => {
            const next = e.target.value as (typeof GIT_OPS)[number];
            setOp(defaultGitOp(next));
          }}
        >
          {GIT_OPS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
      <DirPicker
        id={`git-dir-${nodeId}`}
        label="Repository directory (blank = workflow default)"
        value={node.config.workingDir ?? ''}
        onChange={setWorkdir}
      />
      {op.op === 'branchCreate' && (
        <GitTextField
          label="Branch name (blank = workflow default)"
          value={op.name}
          placeholder="feature/DEV-1234"
          onChange={(name) => setOp({ ...op, name })}
        />
      )}
      {op.op === 'checkout' && (
        <>
          <GitTextField
            label="Branch name (blank = workflow default)"
            value={op.name}
            placeholder="main"
            onChange={(name) => setOp({ ...op, name })}
          />
          <label className="field-hint" style={{ display: 'flex', gap: 6 }}>
            <input
              type="checkbox"
              checked={op.allowDirty ?? false}
              onChange={(e) => {
                setOp({ ...op, allowDirty: e.target.checked });
              }}
            />
            Allow switching with dirty worktree (never discards)
          </label>
        </>
      )}
      {op.op === 'stage' && (
        <div className="field">
          <label className="field-label">Paths (one per line, explicit)</label>
          <textarea
            className="textarea"
            rows={2}
            value={(op.paths ?? []).join('\n')}
            onChange={(e) => {
              setOp({
                ...op,
                paths: e.target.value
                  .split('\n')
                  .map((s) => s.trim())
                  .filter((s) => s !== ''),
              });
            }}
          />
        </div>
      )}
      {op.op === 'commit' && (
        <GitTextField
          label="Message (supports {{input.*}} — e.g. {{input.commitMessage}})"
          value={op.message}
          placeholder="Implement DEV-1234 or {{input.commitMessage}}"
          onChange={(message) => setOp({ ...op, message })}
          textarea
        />
      )}
      {op.op === 'worktreeAdd' && (
        <>
          <GitTextField
            label="Worktree path"
            value={op.path}
            placeholder="/tmp/wt-DEV-1234"
            onChange={(path) => setOp({ ...op, path })}
          />
          <GitTextField
            label="Branch (optional, created when new)"
            value={op.branch ?? ''}
            placeholder="feature/DEV-1234"
            onChange={(branch) =>
              setOp({ ...op, branch: branch === '' ? undefined : branch })
            }
          />
        </>
      )}
      {op.op === 'worktreeRemove' && (
        <GitTextField
          label="Worktree path"
          value={op.path}
          placeholder="/tmp/wt-DEV-1234"
          onChange={(path) => setOp({ ...op, path })}
        />
      )}
      <span className="field-hint">
        Mutations refuse dirty/lossy states instead of forcing. Worktree removal only
        works on clean worktrees and never touches the main checkout.
      </span>
    </>
  );
}

function defaultGitOp(next: (typeof GIT_OPS)[number]): import('../lib/workflow').GitOp {
  switch (next) {
    case 'status':
      return { op: 'status' };
    case 'diffSummary':
      return { op: 'diffSummary' };
    case 'branchCreate':
      return { op: 'branchCreate', name: '' };
    case 'checkout':
      return { op: 'checkout', name: '' };
    case 'stage':
      return { op: 'stage', paths: [] };
    case 'commit':
      return { op: 'commit', message: '' };
    case 'worktreeAdd':
      return { op: 'worktreeAdd', path: '' };
    case 'worktreeRemove':
      return { op: 'worktreeRemove', path: '' };
    case 'worktreeList':
      return { op: 'worktreeList' };
    case 'remotes':
      return { op: 'remotes' };
  }
}

function GitTextField({
  label,
  value,
  placeholder,
  onChange,
  textarea,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  textarea?: boolean;
}): React.JSX.Element {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {textarea === true ? (
        <textarea
          className="textarea"
          rows={2}
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      ) : (
        <input
          className="input"
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      )}
    </div>
  );
}

const GITHUB_OPS = [
  'prStatus',
  'listPrs',
  'prDetails',
  'prFiles',
  'prChecks',
  'createPr',
  'postComment',
] as const;

export function GitHubEditor({
  workflow,
  nodeId,
}: {
  workflow: Workflow;
  nodeId: string;
}): React.JSX.Element {
  const { patchNode } = useNodeConfig(workflow, nodeId);
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (node === undefined) return <></>;
  const op = node.config.githubOp ?? { op: 'prStatus' as const };
  const setOp = (next: typeof op): void => {
    patchNode({ ...node.config, githubOp: next }, node.label);
  };
  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor={`gh-op-${nodeId}`}>
          Operation
        </label>
        <select
          id={`gh-op-${nodeId}`}
          className="input"
          value={op.op}
          onChange={(e) => {
            const next = e.target.value as (typeof GITHUB_OPS)[number];
            setOp(defaultGitHubOp(next));
          }}
        >
          {GITHUB_OPS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
      <DirPicker
        id={`gh-dir-${nodeId}`}
        label="Repository directory (blank = workflow default)"
        value={node.config.workingDir ?? ''}
        onChange={(v) => {
          const config = { ...node.config };
          if (v.trim() === '') {
            delete config.workingDir;
          } else {
            config.workingDir = v;
          }
          patchNode(config, node.label);
        }}
      />
      {(op.op === 'prDetails' || op.op === 'prFiles' || op.op === 'prChecks') && (
        <GitTextField
          label="PR number"
          value={String(op.number)}
          placeholder="7"
          onChange={(v) => setOp({ ...op, number: Number(v) })}
        />
      )}
      {op.op === 'listPrs' && (
        <GitTextField
          label="State"
          value={op.state ?? 'open'}
          placeholder="open"
          onChange={(state) => setOp({ ...op, state })}
        />
      )}
      {op.op === 'createPr' && (
        <>
          <GitTextField
            label="Title (required)"
            value={op.title}
            placeholder="Implement DEV-1234"
            onChange={(title) => setOp({ ...op, title })}
          />
          <GitTextField
            label="Body (supports {{…}})"
            value={op.body ?? ''}
            placeholder="Summary…"
            onChange={(body) => setOp({ ...op, body })}
            textarea
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <GitTextField
              label="Base"
              value={op.base}
              placeholder="main"
              onChange={(base) => setOp({ ...op, base })}
            />
            <GitTextField
              label="Head (blank = workflow default)"
              value={op.head}
              placeholder="feature/DEV-1234"
              onChange={(head) => setOp({ ...op, head })}
            />
          </div>
          <label className="field-hint" style={{ display: 'flex', gap: 6 }}>
            <input
              type="checkbox"
              checked={op.draft ?? false}
              onChange={(e) => {
                setOp({ ...op, draft: e.target.checked });
              }}
            />
            Draft PR
          </label>
        </>
      )}
      {op.op === 'postComment' && (
        <>
          <GitTextField
            label="PR number"
            value={String(op.number)}
            placeholder="7"
            onChange={(v) => setOp({ ...op, number: Number(v) })}
          />
          <GitTextField
            label="Body (explicit action)"
            value={op.body}
            placeholder="Review notes…"
            onChange={(body) => setOp({ ...op, body })}
            textarea
          />
        </>
      )}
      <span className="field-hint">
        Uses your <code>gh</code> auth — Orchevia never sees tokens. Remote writes (create
        PR, comment) only happen when this node runs.
      </span>
    </>
  );
}

function defaultGitHubOp(
  next: (typeof GITHUB_OPS)[number],
): import('../lib/workflow').GitHubOp {
  switch (next) {
    case 'prStatus':
      return { op: 'prStatus' };
    case 'listPrs':
      return { op: 'listPrs', state: 'open' };
    case 'prDetails':
      return { op: 'prDetails', number: 0 };
    case 'prFiles':
      return { op: 'prFiles', number: 0 };
    case 'prChecks':
      return { op: 'prChecks', number: 0 };
    case 'createPr':
      return { op: 'createPr', title: '', body: '', base: 'main', head: '', draft: true };
    case 'postComment':
      return { op: 'postComment', number: 0, body: '' };
  }
}

export function TicketEditor({
  workflow,
  nodeId,
}: {
  workflow: Workflow;
  nodeId: string;
}): React.JSX.Element {
  const mcpServers = useAppStore((s) => s.mcpServers);
  const { patchNode } = useNodeConfig(workflow, nodeId);
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (node === undefined) return <></>;
  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor={`ticket-key-${nodeId}`}>
          Ticket key (supports {'{{…}}'})
        </label>
        <input
          id={`ticket-key-${nodeId}`}
          className="input"
          placeholder="DEV-1234 or {{input.ticket}}"
          value={node.config.ticketKey ?? ''}
          onChange={(e) => {
            patchNode({ ...node.config, ticketKey: e.target.value }, node.label);
          }}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`ticket-server-${nodeId}`}>
          Jira MCP server
        </label>
        <select
          id={`ticket-server-${nodeId}`}
          className="input"
          value={node.config.mcpServerId ?? ''}
          onChange={(e) => {
            patchNode({ ...node.config, mcpServerId: e.target.value }, node.label);
          }}
        >
          <option value="">— Select a server —</option>
          {mcpServers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.enabled ? 'enabled' : 'disabled'})
            </option>
          ))}
        </select>
        <span className="field-hint">
          Ticket fields become{' '}
          <code>ticket.key/title/description/acceptanceCriteria</code>. Ticket text is
          untrusted input — passed to agents as data, never executed.
        </span>
      </div>
    </>
  );
}

export function McpNodeEditor({
  workflow,
  nodeId,
}: {
  workflow: Workflow;
  nodeId: string;
}): React.JSX.Element {
  const mcpServers = useAppStore((s) => s.mcpServers);
  const { patchNode } = useNodeConfig(workflow, nodeId);
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (node === undefined) return <></>;
  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor={`mcp-server-${nodeId}`}>
          Server
        </label>
        <select
          id={`mcp-server-${nodeId}`}
          className="input"
          value={node.config.mcpServerId ?? ''}
          onChange={(e) => {
            patchNode({ ...node.config, mcpServerId: e.target.value }, node.label);
          }}
        >
          <option value="">— Select a server —</option>
          {mcpServers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.enabled ? 'enabled' : 'disabled'})
            </option>
          ))}
        </select>
      </div>
      <GitTextField
        label="Tool name"
        value={node.config.mcpTool ?? ''}
        placeholder="jira_get_issue"
        onChange={(mcpTool) => patchNode({ ...node.config, mcpTool }, node.label)}
      />
      <div className="field">
        <label className="field-label">
          Arguments (one KEY=value per line, values support {'{{…}}'})
        </label>
        <textarea
          className="textarea"
          rows={3}
          placeholder="key=DEV-1234"
          value={Object.entries(node.config.mcpArgs ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join('\n')}
          onChange={(e) => {
            const args: Record<string, string> = {};
            for (const line of e.target.value.split('\n')) {
              const at = line.indexOf('=');
              if (at > 0) args[line.slice(0, at).trim()] = line.slice(at + 1).trim();
            }
            patchNode({ ...node.config, mcpArgs: args }, node.label);
          }}
        />
        <span className="field-hint">
          Invocation is explicit and recorded with server/tool provenance.
        </span>
      </div>
    </>
  );
}

export function ConditionEditor({
  workflow,
  nodeId,
}: {
  workflow: Workflow;
  nodeId: string;
}): React.JSX.Element {
  const updateActiveWorkflow = useAppStore((s) => s.updateActiveWorkflow);
  const [textError, setTextError] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState<{
    condition: string;
    text: string;
  } | null>(null);
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (node === undefined) return <></>;
  const condition = node.config.condition ?? { logic: 'or' as const, clauses: [] };

  const setCondition = (next: typeof condition): void => {
    updateActiveWorkflow({
      ...workflow,
      nodes: workflow.nodes.map((n) =>
        n.id === nodeId ? { ...n, config: { ...n.config, condition: next } } : n,
      ),
    });
  };

  return (
    <>
      {condition.clauses.map((clause, index) => (
        <div key={index} className="field" style={{ display: 'grid', gap: 6 }}>
          <span className="field-label">
            Clause {index + 1}
            {index > 0 ? ` (${condition.logic})` : ''}
          </span>
          <input
            className="input"
            aria-label={`Clause ${String(index + 1)} variable`}
            placeholder="node.review1.severity"
            value={clause.left}
            onChange={(e) => {
              const clauses = condition.clauses.map((c, i) =>
                i === index ? { ...c, left: e.target.value } : c,
              );
              setCondition({ ...condition, clauses });
            }}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <select
              className="input"
              aria-label={`Clause ${String(index + 1)} operator`}
              value={clause.op}
              onChange={(e) => {
                const clauses = condition.clauses.map((c, i) =>
                  i === index ? { ...c, op: e.target.value as ConditionOp } : c,
                );
                setCondition({ ...condition, clauses });
              }}
            >
              {CONDITION_OPS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <input
              className="input"
              aria-label={`Clause ${String(index + 1)} value`}
              placeholder="P0"
              value={clause.right}
              onChange={(e) => {
                const clauses = condition.clauses.map((c, i) =>
                  i === index ? { ...c, right: e.target.value } : c,
                );
                setCondition({ ...condition, clauses });
              }}
            />
          </div>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setCondition({
                ...condition,
                clauses: condition.clauses.filter((_, i) => i !== index),
              });
            }}
          >
            Remove clause
          </button>
        </div>
      ))}
      <div className="field">
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setCondition({
                ...condition,
                clauses: [...condition.clauses, { left: '', op: 'contains', right: '' }],
              });
            }}
          >
            + Add clause
          </button>
          <select
            className="input"
            aria-label="Clause logic"
            value={condition.logic}
            style={{ width: 'auto' }}
            onChange={(e) => {
              setCondition({
                ...condition,
                logic: e.target.value === 'or' ? 'or' : 'and',
              });
            }}
          >
            <option value="and">and</option>
            <option value="or">or</option>
          </select>
        </div>
        <span className="field-hint">
          Left side is always a variable (node./input./workflow.); right side a literal.
          No scripting — comparisons only.
        </span>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`cond-text-${nodeId}`}>
          Text form (advanced)
        </label>
        <textarea
          id={`cond-text-${nodeId}`}
          className="textarea"
          rows={2}
          value={
            textDraft?.condition === JSON.stringify(condition)
              ? textDraft.text
              : (() => {
                  try {
                    return renderCondition(condition);
                  } catch {
                    return '';
                  }
                })()
          }
          onChange={(e) => {
            const text = e.target.value;
            try {
              const next = parseCondition(text);
              setTextDraft({ condition: JSON.stringify(next), text });
              setCondition(next);
              setTextError(null);
            } catch (err) {
              setTextDraft({ condition: JSON.stringify(condition), text });
              setTextError(errorMessage(err));
            }
          }}
        />
        {textError !== null && <Notice variant="error">{textError}</Notice>}
        <span className="field-hint">
          Outgoing edges need <code>true</code> and <code>false</code> labels — click an
          edge on the canvas to set them.
        </span>
      </div>
    </>
  );
}

export function RetryEditor({
  workflow,
  nodeId,
}: {
  workflow: Workflow;
  nodeId: string;
}): React.JSX.Element {
  const updateActiveWorkflow = useAppStore((s) => s.updateActiveWorkflow);
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (node === undefined) return <></>;
  const retry = node.config.retry;
  const setRetry = (next: typeof retry): void => {
    const config = { ...node.config };
    if (next === undefined) {
      delete config.retry;
    } else {
      config.retry = next;
    }
    updateActiveWorkflow({
      ...workflow,
      nodes: workflow.nodes.map((n) => (n.id === nodeId ? { ...n, config } : n)),
    });
  };
  if (retry === undefined) {
    return (
      <div className="field">
        <button
          className="btn btn-ghost"
          onClick={() => {
            setRetry({ maxAttempts: 3, delayMs: 1000, backoff: true });
          }}
        >
          + Add retry policy
        </button>
      </div>
    );
  }
  return (
    <div className="field">
      <span className="field-label">Retry policy (bounded)</span>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label className="field-hint">
          Max attempts (1–10)
          <input
            className="input"
            type="number"
            min={1}
            max={10}
            value={retry.maxAttempts}
            onChange={(e) => {
              setRetry({ ...retry, maxAttempts: Number(e.target.value) });
            }}
          />
        </label>
        <label className="field-hint">
          Delay ms (≤60000)
          <input
            className="input"
            type="number"
            min={0}
            max={60000}
            value={retry.delayMs ?? 0}
            onChange={(e) => {
              setRetry({ ...retry, delayMs: Number(e.target.value) });
            }}
          />
        </label>
      </div>
      <label className="field-hint" style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <input
          type="checkbox"
          checked={retry.backoff ?? false}
          onChange={(e) => {
            setRetry({ ...retry, backoff: e.target.checked });
          }}
        />
        Exponential backoff (×2 per attempt)
      </label>
      <button
        className="btn btn-ghost"
        style={{ marginTop: 6 }}
        onClick={() => {
          setRetry(undefined);
        }}
      >
        Remove retry policy
      </button>
    </div>
  );
}

export function NodeInspector(): React.JSX.Element | null {
  const workflows = useAppStore((s) => s.workflows);
  const activeWorkflowId = useAppStore((s) => s.activeWorkflowId);
  const selectedNodeId = useAppStore((s) => s.selectedNodeId);
  const updateActiveWorkflow = useAppStore((s) => s.updateActiveWorkflow);
  const profiles = useAppStore((s) => s.profiles);
  const [preview, setPreview] = useState<string | null>(null);
  const [agentPreview, setAgentPreview] = useState<string | null>(null);
  const [detectingBranch, setDetectingBranch] = useState(false);
  const [branchDetectMsg, setBranchDetectMsg] = useState<string | null>(null);

  const detectBranch = (repoDir: string): void => {
    if (workflow === null) return;
    const dir = repoDir.trim();
    if (dir === '') {
      setBranchDetectMsg('Set the repository directory first.');
      return;
    }
    setDetectingBranch(true);
    setBranchDetectMsg(null);
    void getBackend()
      .gitCurrentBranch(dir)
      .then((branch) => {
        const state = useAppStore.getState();
        const latest = state.workflows.find((w) => w.id === workflow.id)?.definition;
        if (
          state.activeWorkflowId === workflow.id &&
          latest &&
          latest.defaults?.repoDir?.trim() === dir &&
          latest.defaults.branch === workflow.defaults?.branch
        ) {
          updateActiveWorkflow(setWorkflowDefaults(latest, dir, branch));
        }
      })
      .catch((err: unknown) => {
        setBranchDetectMsg(errorMessage(err));
      })
      .finally(() => {
        setDetectingBranch(false);
      });
  };

  const workflow = workflows.find((w) => w.id === activeWorkflowId)?.definition ?? null;
  const node = workflow?.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const selectedEdgeId = useAppStore((s) => s.selectedEdgeId);
  const selectEdge = useAppStore((s) => s.selectEdge);
  const edge = workflow?.edges.find((e) => e.id === selectedEdgeId) ?? null;

  if (edge !== null && workflow !== null) {
    const sourceKind = workflow.nodes.find((n) => n.id === edge.source)?.type;
    return (
      <aside className="inspector" aria-label="Edge inspector">
        <h3 style={{ marginTop: 0 }}>Connection</h3>
        <p className="field-hint">
          {edge.source} → {edge.target}
        </p>
        <div className="field">
          <label className="field-label" htmlFor="edge-label">
            Label (routing)
          </label>
          <select
            id="edge-label"
            className="input"
            value={edge.label ?? ''}
            onChange={(e) => {
              const label = e.target.value === '' ? undefined : e.target.value;
              updateActiveWorkflow({
                ...workflow,
                edges: workflow.edges.map((x) => {
                  if (x.id !== edge.id) return x;
                  const updated = { ...x };
                  if (label === undefined) {
                    delete updated.label;
                  } else {
                    updated.label = label;
                  }
                  return updated;
                }),
              });
            }}
          >
            {EDGE_LABELS.map((l) => (
              <option key={l} value={l}>
                {l === '' ? '— none (success path)' : l}
              </option>
            ))}
          </select>
          <span className="field-hint">
            {sourceKind === 'condition'
              ? 'Condition outputs need true/false labels to branch.'
              : 'Use failure to route errors to recovery; true/false only fit Condition outputs.'}
          </span>
        </div>
        <button
          className="btn btn-ghost"
          onClick={() => {
            selectEdge(null);
          }}
        >
          Done
        </button>
      </aside>
    );
  }

  if (workflow === null) {
    return (
      <aside className="inspector">
        <p className="field-hint">No workflow selected.</p>
      </aside>
    );
  }

  if (node === null) {
    return (
      <aside className="inspector">
        <h3 style={{ marginTop: 0 }}>Workflow</h3>
        <div className="field">
          <label className="field-label" htmlFor="wf-name">
            Name
          </label>
          <input
            id="wf-name"
            className="input"
            value={workflow.name}
            onChange={(e) => {
              updateActiveWorkflow({ ...workflow, name: e.target.value });
            }}
          />
        </div>
        <p className="field-hint">
          Select a node on the canvas to edit its configuration. Changes save
          automatically as you edit, including graph changes. The toolbar shows saving
          progress and offers a retry if saving fails.
        </p>
        <div className="field">
          <span className="field-label">Repository defaults</span>
          <span className="field-hint" style={{ marginBottom: 8 }}>
            Set once per workflow: Git/GitHub nodes without their own directory or branch
            use these. Node settings always win when set.
          </span>
          <DirPicker
            id="wf-default-repo"
            label="Repository directory"
            value={workflow.defaults?.repoDir ?? ''}
            placeholder="/path/to/repo (optional)"
            onChange={(v) => {
              updateActiveWorkflow(
                setWorkflowDefaults(workflow, v, workflow.defaults?.branch ?? ''),
              );
            }}
          />

          {branchDetectMsg !== null && (
            <p className="field-hint" style={{ marginTop: 4 }}>
              {branchDetectMsg}
            </p>
          )}
          <BranchPicker
            id="wf-default-branch"
            label="Branch (optional)"
            repoDir={workflow.defaults?.repoDir ?? ''}
            value={workflow.defaults?.branch ?? ''}
            placeholder="feature/my-work (optional)"
            onChange={(v) => {
              updateActiveWorkflow(
                setWorkflowDefaults(workflow, workflow.defaults?.repoDir ?? '', v),
              );
            }}
            action={
              <button
                className="btn btn-ghost"
                style={{ padding: '2px 8px', fontSize: 12 }}
                disabled={
                  detectingBranch || (workflow.defaults?.repoDir ?? '').trim() === ''
                }
                title="Fill in the current branch of the repository above"
                onClick={() => {
                  detectBranch(workflow.defaults?.repoDir ?? '');
                }}
              >
                {detectingBranch ? 'Detecting…' : 'Detect current'}
              </button>
            }
          />
        </div>
        <div className="field">
          <span className="field-label">Nodes</span>
          <span className="field-hint">
            {workflow.nodes.length} nodes · {workflow.edges.length} connections
          </span>
        </div>
        <div className="field">
          <span className="field-label">Workflow inputs (as {'{{input.name}}'})</span>
          {(workflow.inputs ?? []).map((input) => (
            <div key={input.name} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input
                className="input"
                value={input.name}
                aria-label="Input name"
                onChange={(e) => {
                  updateActiveWorkflow({
                    ...workflow,
                    inputs: (workflow.inputs ?? []).map((x) =>
                      x.name === input.name ? { ...x, name: e.target.value } : x,
                    ),
                  });
                }}
              />
              <input
                className="input"
                value={input.default ?? ''}
                placeholder="default"
                aria-label="Input default"
                onChange={(e) => {
                  updateActiveWorkflow({
                    ...workflow,
                    inputs: (workflow.inputs ?? []).map((x) =>
                      x.name === input.name
                        ? {
                            ...x,
                            default: e.target.value === '' ? undefined : e.target.value,
                          }
                        : x,
                    ),
                  });
                }}
              />
              <button
                className="btn btn-ghost"
                aria-label={`Remove input ${input.name}`}
                onClick={() => {
                  updateActiveWorkflow({
                    ...workflow,
                    inputs: (workflow.inputs ?? []).filter((x) => x.name !== input.name),
                  });
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="btn btn-ghost"
            onClick={() => {
              const name = `input${String((workflow.inputs ?? []).length + 1)}`;
              updateActiveWorkflow({
                ...workflow,
                inputs: [...(workflow.inputs ?? []), { name, default: '' }],
              });
            }}
          >
            + Add input
          </button>
          <span className="field-hint">
            Required inputs without defaults must be supplied at ▶ Run time.
          </span>
        </div>
      </aside>
    );
  }

  const meta = NODE_KIND_META[node.type];
  const patch = (config: typeof node.config, label?: string): void => {
    updateActiveWorkflow({
      ...workflow,
      nodes: workflow.nodes.map((n) => {
        if (n.id !== node.id) return n;
        const updated = { ...n, config };
        if (label === undefined) {
          delete updated.label;
        } else {
          updated.label = label;
        }
        return updated;
      }),
    });
  };

  const refreshPreview = (): void => {
    if (node.type !== 'command') return;
    void getBackend()
      .previewCommand(node.config.executable ?? '', node.config.args ?? [])
      .then(setPreview)
      .catch(() => setPreview(null));
  };

  return (
    <aside className="inspector" aria-label="Node inspector">
      <h3 style={{ marginTop: 0 }}>{meta.label}</h3>
      <p className="field-hint">{meta.description}</p>

      <div className="field">
        <label className="field-label" htmlFor="node-label">
          Label
        </label>
        <input
          id="node-label"
          className="input"
          value={node.label ?? ''}
          onChange={(e) => {
            patch(node.config, e.target.value);
          }}
        />
      </div>

      {node.type === 'command' && (
        <>
          <div className="field">
            <label className="field-label" htmlFor="node-exe">
              Executable
            </label>
            <input
              id="node-exe"
              className="input"
              placeholder="e.g. git, gh, echo"
              value={node.config.executable ?? ''}
              onChange={(e) => {
                patch({ ...node.config, executable: e.target.value }, node.label);
              }}
              onBlur={() => {
                refreshPreview();
              }}
              onFocus={refreshPreview}
            />
            <span className="field-hint">
              Executable and arguments are passed separately — no shell is involved.
            </span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="node-args">
              Arguments (one per line)
            </label>
            <textarea
              id="node-args"
              className="textarea"
              rows={4}
              value={(node.config.args ?? []).join('\n')}
              onChange={(e) => {
                patch(
                  {
                    ...node.config,
                    args: e.target.value
                      .split('\n')
                      .map((s) => s.trim())
                      .filter((s) => s !== ''),
                  },
                  node.label,
                );
              }}
              onBlur={() => {
                refreshPreview();
              }}
            />
          </div>
          <DirPicker
            id="node-cwd"
            label="Working directory (optional)"
            value={node.config.workingDir ?? ''}
            placeholder="/path/to/project"
            onChange={(v) => {
              const value = v.trim();
              const config = { ...node.config };
              if (value === '') {
                delete config.workingDir;
              } else {
                config.workingDir = value;
              }
              patch(config, node.label);
            }}
          />
          {preview !== null && preview !== '' && (
            <div className="field">
              <span className="field-label">Command preview</span>
              <div className="log-block">{preview}</div>
              <span className="field-hint">
                Display only — execution never goes through a shell.
              </span>
            </div>
          )}
          <div className="field">
            <label className="field-label" htmlFor="node-cmd-timeout">
              Timeout in seconds (1–43200, blank = 600)
            </label>
            <input
              id="node-cmd-timeout"
              className="input"
              type="number"
              min={1}
              max={43200}
              placeholder="600"
              value={node.config.timeoutSecs ?? ''}
              onChange={(e) => {
                const config = { ...node.config };
                if (e.target.value === '') {
                  delete config.timeoutSecs;
                } else {
                  config.timeoutSecs = Number(e.target.value);
                }
                patch(config, node.label);
              }}
            />
            <label
              className="field-hint"
              style={{ display: 'flex', gap: 8, marginTop: 6 }}
            >
              <input
                type="checkbox"
                checked={node.config.extendOnOutput === true}
                onChange={(e) => {
                  const config = { ...node.config };
                  if (e.target.checked) {
                    config.extendOnOutput = true;
                  } else {
                    delete config.extendOnOutput;
                  }
                  patch(config, node.label);
                }}
              />
              Keep running while output flows — the countdown restarts on every output
              chunk (up to 12 h total). For long AI implementations.
            </label>
          </div>
          <RetryEditor workflow={workflow} nodeId={node.id} />
        </>
      )}

      {node.type === 'agent' && (
        <>
          <div className="field">
            <label className="field-label" htmlFor="node-profile">
              Agent Profile
            </label>
            <select
              id="node-profile"
              className="input"
              value={node.config.agentProfileId ?? ''}
              onChange={(e) => {
                patch({ ...node.config, agentProfileId: e.target.value }, node.label);
              }}
            >
              <option value="">— Select a profile —</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.adapter})
                </option>
              ))}
            </select>
            <span className="field-hint">
              {profiles.length === 0
                ? 'No profiles yet — create one in the Agents tab.'
                : 'The profile decides which local CLI, model, and working directory are used.'}
            </span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="node-prompt">
              Prompt / instruction
            </label>
            <textarea
              id="node-prompt"
              className="textarea"
              rows={6}
              placeholder={
                'e.g. Implement {{workflow.name}}\n\nPlan output:\n{{node.<plan-node-id>.output}}'
              }
              value={node.config.prompt ?? ''}
              onChange={(e) => {
                patch({ ...node.config, prompt: e.target.value }, node.label);
              }}
            />
            <span className="field-hint">
              Variables: {'{{workflow.name}}'}, {'{{workflow.id}}'}, {'{{node.<id>}}'} and{' '}
              {'{{node.<id>.output}}'}. Missing variables fail the run with a clear
              message.
              {(() => {
                const refs = referencedVariables(node.config.prompt ?? '');
                return refs.length > 0 ? ` Referenced: ${refs.join(', ')}.` : '';
              })()}
            </span>
          </div>
          <div className="field">
            <DirPicker
              id="node-agent-cwd"
              label="Working directory (optional, overrides profile)"
              value={node.config.workingDir ?? ''}
              placeholder="/path/to/project"
              onChange={(v) => {
                const value = v.trim();
                const config = { ...node.config };
                if (value === '') {
                  delete config.workingDir;
                } else {
                  config.workingDir = value;
                }
                patch(config, node.label);
              }}
            />
            <span className="field-hint">
              Must exist before execution. Repository changes happen here — the profile’s
              mode decides the default.
            </span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="node-timeout">
              Timeout in seconds (1–43200, blank = profile default)
            </label>
            <input
              id="node-timeout"
              className="input"
              type="number"
              min={1}
              max={43200}
              placeholder="Profile default"
              value={node.config.timeoutSecs ?? ''}
              onChange={(e) => {
                const config = { ...node.config };
                if (e.target.value === '') {
                  delete config.timeoutSecs;
                } else {
                  config.timeoutSecs = Number(e.target.value);
                }
                patch(config, node.label);
              }}
            />
            <label
              className="field-hint"
              style={{ display: 'flex', gap: 8, marginTop: 6 }}
            >
              <input
                type="checkbox"
                checked={node.config.extendOnOutput === true}
                onChange={(e) => {
                  const config = { ...node.config };
                  if (e.target.checked) {
                    config.extendOnOutput = true;
                  } else {
                    delete config.extendOnOutput;
                  }
                  patch(config, node.label);
                }}
              />
              Keep running while output flows — the countdown restarts on every output
              chunk (up to 12 h total). For long AI implementations.
            </label>
          </div>
          <RetryEditor workflow={workflow} nodeId={node.id} />
          <div className="field">
            <button
              className="btn"
              onClick={() => {
                const profileId = node.config.agentProfileId ?? '';
                if (profileId === '') {
                  setAgentPreview('Select a profile first.');
                  return;
                }
                void getBackend()
                  .previewAgentCommand(
                    profileId,
                    node.config.prompt ?? '',
                    node.config.workingDir,
                  )
                  .then((p) => {
                    setAgentPreview(p.preview);
                  })
                  .catch((err: unknown) => {
                    setAgentPreview(errorMessage(err));
                  });
              }}
            >
              Preview agent command
            </button>
            {agentPreview !== null && agentPreview !== '' && (
              <>
                <div className="log-block" style={{ marginTop: 8 }}>
                  {agentPreview}
                </div>
                <span className="field-hint">
                  Display only — execution re-validates the profile and never uses a
                  shell.
                </span>
              </>
            )}
          </div>
          <Notice>
            This node runs a third-party AI CLI that may send prompt and repository
            content to its own provider. Nothing runs until you press ▶ Run.
          </Notice>
        </>
      )}

      {node.type === 'condition' && (
        <ConditionEditor workflow={workflow} nodeId={node.id} />
      )}

      {node.type === 'git' && <GitEditor workflow={workflow} nodeId={node.id} />}
      {node.type === 'github' && <GitHubEditor workflow={workflow} nodeId={node.id} />}
      {node.type === 'ticket' && <TicketEditor workflow={workflow} nodeId={node.id} />}
      {node.type === 'mcp' && <McpNodeEditor workflow={workflow} nodeId={node.id} />}

      <div className="field">
        <label className="field-label" htmlFor="node-maxvisits">
          Max visits (loop bound, default 1)
        </label>
        <input
          id="node-maxvisits"
          className="input"
          type="number"
          min={1}
          max={100}
          placeholder="1"
          value={node.config.maxVisits ?? ''}
          onChange={(e) => {
            const config = { ...node.config };
            if (e.target.value === '') {
              delete config.maxVisits;
            } else {
              config.maxVisits = Number(e.target.value);
            }
            patch(config, node.label);
          }}
        />
        <span className="field-hint">
          Nodes on a review/fix cycle must set this ≥ 2; cycles without a Condition guard
          or bound fail validation.
        </span>
      </div>

      {node.type === 'approval' && (
        <div className="field">
          <label className="field-label" htmlFor="node-msg">
            Approval prompt
          </label>
          <textarea
            id="node-msg"
            className="textarea"
            rows={3}
            placeholder="What should the reviewer confirm?"
            value={node.config.message ?? ''}
            onChange={(e) => {
              patch({ ...node.config, message: e.target.value }, node.label);
            }}
          />
        </div>
      )}
    </aside>
  );
}
