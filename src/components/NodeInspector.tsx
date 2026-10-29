import { useId, useState } from 'react';
import { getBackend } from '../lib/backend';
import { ADAPTER_LABELS, referencedVariables } from '../lib/agents';
import { parseCondition, renderCondition, type ConditionOp } from '../lib/conditions';
import {
  NODE_KIND_META,
  commandArgv,
  commandWorkingFolder,
  scriptPathFromPicked,
  setWorkflowDefaults,
  commandModeBlocker,
  toCommandMode,
  toScriptMode,
  type Workflow,
} from '../lib/workflow';
import { profileGrants } from '../lib/permissions';
import { DirPicker } from './DirPicker';
import { BranchPicker } from './BranchPicker';
import { ToolRulesField } from './ToolRulesField';
import { KeyValueTextarea, LinesTextarea } from './DraftText';
import { Notice, useNoticeMessage } from './Notice';
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

/**
 * A typed whole number ≥ 0, or null for anything else. Steps store these
 * as unsigned integers, so a field ignores "1.5", "-1" or "7a" (React
 * then puts the field back to the stored value) instead of saving a value
 * the desktop app cannot read.
 */
function wholeNumber(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() !== '' && Number.isInteger(value) && value >= 0 ? value : null;
}

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
      config.workingDir = value.trim();
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
          <label className="field-label" htmlFor={`git-paths-${nodeId}`}>
            Paths (one per line, explicit)
          </label>
          <LinesTextarea
            id={`git-paths-${nodeId}`}
            rows={2}
            value={op.paths ?? []}
            onChange={(paths) => {
              setOp({ ...op, paths });
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
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {textarea === true ? (
        <textarea
          id={id}
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
          id={id}
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
            config.workingDir = v.trim();
          }
          patchNode(config, node.label);
        }}
      />
      {(op.op === 'prDetails' || op.op === 'prFiles' || op.op === 'prChecks') && (
        <GitTextField
          label="PR number"
          value={String(op.number)}
          placeholder="7"
          onChange={(v) => {
            // Cleared while retyping reads as 0, as before.
            const number = v.trim() === '' ? 0 : wholeNumber(v);
            if (number !== null) setOp({ ...op, number });
          }}
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
            onChange={(v) => {
              // Cleared while retyping reads as 0, as before.
              const number = v.trim() === '' ? 0 : wholeNumber(v);
              if (number !== null) setOp({ ...op, number });
            }}
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
        <label className="field-label" htmlFor={`mcp-args-${nodeId}`}>
          Arguments (one KEY=value per line, values support {'{{…}}'})
        </label>
        <KeyValueTextarea
          id={`mcp-args-${nodeId}`}
          rows={3}
          placeholder="key=DEV-1234"
          value={node.config.mcpArgs ?? {}}
          onChange={(mcpArgs) => {
            patchNode({ ...node.config, mcpArgs }, node.label);
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
  // A half-typed expression is not an error yet: it shows once the field is left.
  const [textErrorShown, setTextErrorShown] = useState(false);
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
          aria-invalid={
            textErrorShown &&
            textError !== null &&
            textDraft?.condition === JSON.stringify(condition)
          }
          aria-describedby={
            textErrorShown &&
            textError !== null &&
            textDraft?.condition === JSON.stringify(condition)
              ? `cond-text-error-${nodeId}`
              : undefined
          }
          onBlur={() => setTextErrorShown(true)}
          onChange={(e) => {
            const text = e.target.value;
            setTextErrorShown(false);
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
        {textErrorShown &&
          textError !== null &&
          textDraft?.condition === JSON.stringify(condition) && (
            <p className="form-error" role="alert" id={`cond-text-error-${nodeId}`}>
              {textError}
            </p>
          )}
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
              const maxAttempts =
                e.target.value.trim() === '' ? 0 : wholeNumber(e.target.value);
              if (maxAttempts !== null) setRetry({ ...retry, maxAttempts });
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
              const delayMs =
                e.target.value.trim() === '' ? 0 : wholeNumber(e.target.value);
              if (delayMs !== null) setRetry({ ...retry, delayMs });
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
  const appDefault = useAppStore((s) => s.agentPermissionDefault);
  const [preview, setPreview] = useState<string | null>(null);
  const [agentPreview, setAgentPreview] = useState<string | null>(null);
  const [detectingBranch, setDetectingBranch] = useState(false);
  // Why the last Command/Script file switch did not happen, for that step only.
  const [modeNote, setModeNote] = useState<{ nodeId: string; text: string } | null>(null);
  const [branchDetectMsg, setBranchDetectMsg, , branchDetectMsgEvent] =
    useNoticeMessage('warn');

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
  const validation = useAppStore((s) => s.validation);
  // Only the selected step's own needs: the user is at its fields now.
  const nodeIssues = validation.filter(
    (issue) => node !== null && issue.nodeId === node.id && issue.severity === 'error',
  );
  const selectedEdgeId = useAppStore((s) => s.selectedEdgeId);
  const selectEdge = useAppStore((s) => s.selectEdge);
  const edge = workflow?.edges.find((e) => e.id === selectedEdgeId) ?? null;

  if (edge !== null && workflow !== null) {
    const sourceKind = workflow.nodes.find((n) => n.id === edge.source)?.type;
    return (
      <aside className="inspector" aria-label="Edge inspector">
        <h2 style={{ marginTop: 0, fontSize: '1.17em' }}>Connection</h2>
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
        <h2 style={{ marginTop: 0, fontSize: '1.17em' }}>Workflow</h2>
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
          automatically as you edit, including graph changes. Save confirmations appear in
          the bottom-left message stack. If saving fails, use Retry save in the toolbar.
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
            <Notice variant="warn" eventId={branchDetectMsgEvent}>
              {branchDetectMsg}
            </Notice>
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
          <span className="field-label">Usage limits</span>
          <span className="field-hint" style={{ marginBottom: 8 }}>
            {workflow.limits === undefined ||
            Object.values(workflow.limits).every((v) => v === undefined)
              ? 'No saved limits — runs execute ordinarily. '
              : `Saved: ${[
                  workflow.limits.maxAgentAttempts !== undefined
                    ? `${String(workflow.limits.maxAgentAttempts)} attempts (enforced)`
                    : null,
                  workflow.limits.maxToolCalls !== undefined
                    ? `${String(workflow.limits.maxToolCalls)} tools (advisory)`
                    : null,
                  workflow.limits.maxSubagents !== undefined
                    ? `${String(workflow.limits.maxSubagents)} subagents (advisory)`
                    : null,
                  workflow.limits.spendLimitUsd !== undefined
                    ? `USD ${String(workflow.limits.spendLimitUsd)} (estimated API value)`
                    : null,
                ]
                  .filter((part) => part !== null)
                  .join(' · ')}. `}
            Edit them with the Usage limits toolbar button; the start form shows the
            effective values per run.
          </span>
        </div>
        <div className="field">
          <span className="field-label">Workflow inputs (as {'{{input.name}}'})</span>
          {/* Rows go by position: a name changes while it is typed and two
              rows may briefly share one. */}
          {(workflow.inputs ?? []).map((input, index) => (
            <div key={index} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input
                className="input"
                value={input.name}
                aria-label="Input name"
                onChange={(e) => {
                  updateActiveWorkflow({
                    ...workflow,
                    inputs: (workflow.inputs ?? []).map((x, i) =>
                      i === index ? { ...x, name: e.target.value } : x,
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
                    inputs: (workflow.inputs ?? []).map((x, i) =>
                      i === index
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
                    inputs: (workflow.inputs ?? []).filter((_, i) => i !== index),
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
              const taken = new Set((workflow.inputs ?? []).map((x) => x.name));
              let n = taken.size + 1;
              while (taken.has(`input${String(n)}`)) n += 1;
              const name = `input${String(n)}`;
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

  // Where a Command step runs; a relative script path resolves against it.
  const commandFolder = commandWorkingFolder(node.config, workflow.defaults);
  const scriptMode = node.type === 'command' && node.config.scriptFile !== undefined;

  /** Preview the real argv (a script runs as `<interpreter> <script> args…`). */
  const refreshPreview = (config = node.config): void => {
    if (node.type !== 'command') return;
    if (config.scriptFile?.trim() === '') {
      // Nothing real to show until a script is chosen.
      setPreview(null);
      return;
    }
    const [executable = '', ...args] = commandArgv(
      config,
      commandWorkingFolder(config, workflow.defaults),
    );
    void getBackend()
      .previewCommand(executable, args)
      .then(setPreview)
      .catch(() => setPreview(null));
  };

  const switchCommandMode = (script: boolean): void => {
    const blocked = script ? null : commandModeBlocker(node.config);
    setModeNote(blocked === null ? null : { nodeId: node.id, text: blocked });
    if (blocked !== null) return;
    // Nothing is dropped: an interpreter running a file keeps that file, and
    // a script turns back into its interpreter's first argument.
    const config = script ? toScriptMode(node.config) : toCommandMode(node.config);
    patch(config, node.label);
    refreshPreview(config);
  };

  return (
    <aside className="inspector" aria-label="Node inspector">
      <h2 style={{ marginTop: 0, fontSize: '1.17em' }}>{meta.label}</h2>
      <p className="field-hint">{meta.description}</p>
      {nodeIssues.length > 0 && (
        <Notice inline className="node-setup">
          <strong>To finish this step</strong>
          <ul>
            {nodeIssues.map((issue, index) => (
              <li key={`${issue.code}-${String(index)}`}>{issue.message}</li>
            ))}
          </ul>
        </Notice>
      )}

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
            <span className="field-label" id="node-run-mode-label">
              Runs
            </span>
            <div
              role="radiogroup"
              aria-labelledby="node-run-mode-label"
              className="command-mode"
            >
              {[
                { script: false, id: 'command', title: 'Command' },
                { script: true, id: 'script', title: 'Script file' },
              ].map((mode) => (
                <label
                  key={mode.id}
                  htmlFor={`node-run-mode-${mode.id}`}
                  className={`access-option${scriptMode === mode.script ? ' selected' : ''}`}
                >
                  <input
                    id={`node-run-mode-${mode.id}`}
                    type="radio"
                    name="node-run-mode"
                    checked={scriptMode === mode.script}
                    onChange={() => {
                      switchCommandMode(mode.script);
                    }}
                  />
                  <span>{mode.title}</span>
                </label>
              ))}
            </div>
            {modeNote?.nodeId === node.id && (
              <p className="field-hint" role="status">
                {modeNote.text}
              </p>
            )}
          </div>
          {scriptMode ? (
            <>
              <DirPicker
                id="node-script"
                label="Script path"
                pick="file"
                value={node.config.scriptFile ?? ''}
                placeholder="scripts/check.sh"
                fromPicked={(path) => scriptPathFromPicked(path, commandFolder)}
                onChange={(v) => {
                  const config = { ...node.config, scriptFile: v.trim() };
                  patch(config, node.label);
                  refreshPreview(config);
                }}
              />
              <span className="field-hint">
                Relative to the working folder
                {commandFolder === undefined ? '' : ` (${commandFolder})`}; ~/ is your
                home folder. The path is used as written: pass values as arguments.
              </span>
              <div className="field">
                <label className="field-label" htmlFor="node-exe">
                  Run with
                </label>
                <input
                  id="node-exe"
                  className="input"
                  placeholder="bash"
                  value={node.config.executable ?? ''}
                  onChange={(e) => {
                    const config = { ...node.config };
                    if (e.target.value.trim() === '') delete config.executable;
                    else config.executable = e.target.value;
                    patch(config, node.label);
                  }}
                  onBlur={() => {
                    refreshPreview();
                  }}
                  onFocus={() => {
                    refreshPreview();
                  }}
                />
                <span className="field-hint">
                  The interpreter that runs the script (python3, node, sh…); blank runs it
                  with bash.
                </span>
              </div>
            </>
          ) : (
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
                onFocus={() => {
                  refreshPreview();
                }}
              />
              <span className="field-hint">
                Executable and arguments are passed separately — no shell is involved.
                Long shell scripts read better as a Script file.
              </span>
            </div>
          )}
          <div className="field">
            <label className="field-label" htmlFor="node-args">
              {scriptMode
                ? 'Script arguments (one per line)'
                : 'Arguments (one per line)'}
            </label>
            <LinesTextarea
              id="node-args"
              rows={4}
              value={node.config.args ?? []}
              onChange={(args) => {
                patch({ ...node.config, args }, node.label);
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
            placeholder={workflow.defaults?.repoDir ?? '/path/to/project'}
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
                  const value = wholeNumber(e.target.value);
                  if (value === null) return;
                  config.timeoutSecs = value;
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
                const config = { ...node.config };
                delete config.agentRole;
                if (e.target.value) config.agentProfileId = e.target.value;
                else delete config.agentProfileId;
                patch(config, node.label);
              }}
            >
              <option value="">
                {node.config.agentRole
                  ? `— Unresolved role: ${node.config.agentRole} —`
                  : '— Select a profile —'}
              </option>
              {node.config.agentProfileId &&
                !profiles.some((p) => p.id === node.config.agentProfileId) && (
                  <option value={node.config.agentProfileId}>
                    Missing profile: {node.config.agentProfileId}
                  </option>
                )}
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.adapter})
                </option>
              ))}
            </select>
            <span className="field-hint">
              {(() => {
                const profile = profiles.find((p) => p.id === node.config.agentProfileId);
                if (profile)
                  return `Uses ${profile.name} · ${ADAPTER_LABELS[profile.adapter]} · model: ${profile.model || 'CLI default'} · effort: ${profile.effort || 'CLI default'}.`;
                if (node.config.agentProfileId)
                  return 'The selected profile is missing. Choose an existing profile before running.';
                if (node.config.agentRole)
                  return `Role '${node.config.agentRole}' is unresolved. Select an Agent Profile before running; no default is active.`;
                return profiles.length === 0
                  ? 'No profile selected — create one in Agents before running.'
                  : 'No profile selected. Choose an Agent Profile before running; no default is active.';
              })()}
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
          <ToolRulesField
            key={`required-tools-${node.id}`}
            id="node-required-tools"
            label="Required tools (optional)"
            value={node.config.requiredTools ?? []}
            placeholder={'mcp__jira\nBash(git status *)'}
            onChange={(rules) => {
              const config = { ...node.config };
              if (rules.length === 0) delete config.requiredTools;
              else config.requiredTools = rules;
              patch(config, node.label);
            }}
            hint={(() => {
              const profile = profiles.find((p) => p.id === node.config.agentProfileId);
              const missing =
                profile?.adapter === 'claude'
                  ? (node.config.requiredTools ?? []).filter(
                      (rule) => !profileGrants(profile, rule, appDefault),
                    )
                  : [];
              return `Claude Code allow rules this step needs, one per line. Exports and templates carry them; import and run start offer to add missing ones to the chosen profile.${missing.length > 0 && profile !== undefined ? ` ${profile.name} does not grant: ${missing.join(', ')}.` : ''}`;
            })()}
          />
          <div className="field">
            <label className="field-label" htmlFor="node-session-group">
              Session group
            </label>
            <input
              id="node-session-group"
              className="input"
              placeholder="Blank = fresh; e.g. implement-{{input.ticket}}"
              value={node.config.sessionGroup ?? ''}
              onChange={(e) => {
                const config = { ...node.config };
                if (!e.target.value.trim()) {
                  delete config.sessionGroup;
                  delete config.sessionMaxTurns;
                } else config.sessionGroup = e.target.value;
                patch(config, node.label);
              }}
            />
            <span className="field-hint">
              Reuse context within one run, with the same profile and directory. Use
              separate groups for independent reviewers and an item key in loops.
            </span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="node-session-turns">
              Maximum turns per session
            </label>
            <input
              id="node-session-turns"
              className="input"
              type="number"
              min={1}
              max={20}
              placeholder="4"
              disabled={!node.config.sessionGroup}
              value={node.config.sessionMaxTurns ?? ''}
              onChange={(e) => {
                const config = { ...node.config };
                if (!e.target.value) delete config.sessionMaxTurns;
                else {
                  const value = wholeNumber(e.target.value);
                  if (value === null) return;
                  config.sessionMaxTurns = value;
                }
                patch(config, node.label);
              }}
            />
            <span className="field-hint">
              Starts fresh after this many successful turns (default 4). Longer histories
              can increase cost.
            </span>
          </div>
          <details>
            <summary>
              Context from completed nodes ({String(node.config.contextRefs?.length ?? 0)}{' '}
              selected)
            </summary>
            <div style={{ maxHeight: 200, overflowY: 'auto' }}>
              {workflow.nodes
                .filter((other) => other.id !== node.id)
                .map((other) => (
                  <label
                    key={other.id}
                    className="field-hint"
                    style={{ display: 'block', margin: '8px 0' }}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Context from ${other.label ?? other.id}`}
                      checked={node.config.contextRefs?.includes(other.id) ?? false}
                      disabled={
                        !node.config.contextRefs?.includes(other.id) &&
                        (node.config.contextRefs?.length ?? 0) >= 16
                      }
                      onChange={(e) => {
                        const config = { ...node.config };
                        const refs = config.contextRefs ?? [];
                        config.contextRefs = e.target.checked
                          ? [...refs, other.id]
                          : refs.filter((id) => id !== other.id);
                        if (!config.contextRefs.length) {
                          delete config.contextRefs;
                          delete config.contextMaxChars;
                        }
                        patch(config, node.label);
                      }}
                    />{' '}
                    {other.label ?? other.id}
                  </label>
                ))}
            </div>
            <span className="field-hint">
              Select relevant predecessors (up to 16). They must have completed when this
              node runs. Avoid also inlining their outputs in the prompt.
            </span>
          </details>
          <div className="field">
            <label className="field-label" htmlFor="node-context-budget">
              Context character budget
            </label>
            <input
              id="node-context-budget"
              className="input"
              type="number"
              min={256}
              max={64000}
              placeholder="12000"
              disabled={!node.config.contextRefs?.length}
              value={node.config.contextMaxChars ?? ''}
              onChange={(e) => {
                const config = { ...node.config };
                if (!e.target.value) delete config.contextMaxChars;
                else {
                  const value = wholeNumber(e.target.value);
                  if (value === null) return;
                  config.contextMaxChars = value;
                }
                patch(config, node.label);
              }}
            />
            <span className="field-hint">
              Combined excerpt characters, excluding headers (default 12000). Longer
              outputs keep a marked beginning and end; full output stays in run logs.
            </span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="node-max-tools">
              Advisory tool-call allowance
            </label>
            <input
              id="node-max-tools"
              className="input"
              type="number"
              min={1}
              max={100000}
              placeholder="Blank = workflow default"
              value={node.config.maxToolCalls ?? ''}
              onChange={(e) => {
                const config = { ...node.config };
                if (!e.target.value) delete config.maxToolCalls;
                else {
                  const value = wholeNumber(e.target.value);
                  if (value === null) return;
                  config.maxToolCalls = value;
                }
                patch(config, node.label);
              }}
            />
            <span className="field-hint">
              This step's share of tool calls, not the whole workflow budget. Advisory
              guidance inside the prompt plus observed counts — the CLI owns its tool loop
              and this never hard-stops work.
            </span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="node-max-subagents">
              Advisory subagent allowance
            </label>
            <input
              id="node-max-subagents"
              className="input"
              type="number"
              min={1}
              max={1000}
              placeholder="Blank = workflow default"
              value={node.config.maxSubagents ?? ''}
              onChange={(e) => {
                const config = { ...node.config };
                if (!e.target.value) delete config.maxSubagents;
                else {
                  const value = wholeNumber(e.target.value);
                  if (value === null) return;
                  config.maxSubagents = value;
                }
                patch(config, node.label);
              }}
            />
            <span className="field-hint">
              Blank inherits the workflow allowance. Spawning still requires explicit
              permission in the task. This allowance is advisory; only the run-wide
              attempt budget is enforced.
            </span>
          </div>
          <div className="field">
            <DirPicker
              id="node-agent-cwd"
              label="Working directory (optional, overrides profile)"
              value={node.config.workingDir ?? ''}
              placeholder={workflow.defaults?.repoDir ?? '/path/to/project'}
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
              Must exist before execution. Repository changes happen here. Blank uses the
              workflow’s repository directory, unless the profile sets its own folder.
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
                  const value = wholeNumber(e.target.value);
                  if (value === null) return;
                  config.timeoutSecs = value;
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
                    node.config.workingDir ?? workflow.defaults?.repoDir,
                  )
                  .then((p) => {
                    setAgentPreview(p.preview);
                  })
                  .catch((err: unknown) => {
                    setAgentPreview(null);
                    useAppStore
                      .getState()
                      .pushUiNotice({ content: errorMessage(err), variant: 'error' });
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
                  Shows the fresh profile command. Session IDs and selected handoff
                  excerpts are resolved during execution. Execution re-validates the
                  profile.
                </span>
              </>
            )}
          </div>
          <Notice inline>
            This node runs a third-party AI CLI that may send prompt and repository
            content to its own provider. Nothing runs until you press ▶ Run.
          </Notice>
        </>
      )}

      {node.type === 'condition' && (
        <ConditionEditor key={node.id} workflow={workflow} nodeId={node.id} />
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
              const value = wholeNumber(e.target.value);
              if (value === null) return;
              config.maxVisits = value;
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
