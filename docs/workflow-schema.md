# Workflow data model

Workflows are canvas-independent, serializable, versioned JSON. The persisted definition
is the source of truth; node positions are carried along for the editor but execution
depends only on nodes + edges.

## Document

```json
{
  "schemaVersion": 6,
  "id": "wf-...",
  "name": "Sample: Environment Check",
  "nodes": [
    {
      "id": "node-...",
      "type": "command",
      "position": { "x": 80, "y": 180 },
      "config": { "executable": "uname", "args": ["-a"] },
      "label": "Inspect Environment"
    }
  ],
  "edges": [{ "id": "edge-...", "source": "node-a", "target": "node-b" }]
}
```

## Node types (schema v4)

| `type`      | Config                                                                                                                  | Semantics                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `start`     | —                                                                                                                       | Single entry point; exactly one required                                     |
| `command`   | `executable` (required), `args[]`, `workingDir?`                                                                        | Run a local process, no shell                                                |
| `approval`  | `message?`                                                                                                              | Pause the run until approved/rejected                                        |
| `agent`     | `agentProfileId` (required), `prompt` (required), `workingDir?`, `timeoutSecs?`, `inputRefs[]?`, `retry?`, `maxVisits?` | Run a local AI CLI via an Agent Profile; prompt is a `{{variable}}` template |
| `condition` | `condition` (required: `logic` + `clauses[]`), `maxVisits?`                                                             | Branch on a constrained expression; needs `true` + `false` labeled edges     |
| `git`       | `gitOp` (required), `workingDir` (required repo dir)                                                                    | Safe repo ops; lossy states refused                                          |
| `github`    | `githubOp` (required), `workingDir` (required repo dir)                                                                 | PRs/checks/comments via local `gh`                                           |
| `ticket`    | `ticketKey` (required, templates ok), `mcpServerId` (required)                                                          | Load Jira ticket via MCP → `ticket.*` vars                                   |
| `mcp`       | `mcpServerId` + `mcpTool` (required), `mcpArgs` (templates ok)                                                          | Call one MCP tool with provenance                                            |
| `end`       | —                                                                                                                       | Terminal node; at least one required                                         |

Future milestones extend this enum (`test`, `review`, `schedule`, …) with a
schema bump + migration. Full integration guide: [integrations.md](./integrations.md).

## Generated native operations

The generation proposal uses the same tagged operation objects as the stored
workflow. A generated Git or GitHub node must name a supported operation in
`config.gitOp` or `config.githubOp`; the label alone never selects the action.
The compiler rejects missing or unknown operations for the generator's repair
flow. It uses the existing workflow validator for required operation fields.

```json
{"type":"git","config":{"gitOp":{"op":"branchCreate","name":"feature/x"}}}
{"type":"github","config":{"githubOp":{"op":"createPr","title":"Feature x","base":"main","head":"feature/x","draft":true}}}
```

Git push has no native `GitOp` variant. A goal that needs it can use a
reviewable Command node with `executable: "git"` and explicit `args`; this is
classified as a remote write. A newly created local branch needs that push
before `createPr`. Generated MCP nodes preserve `mcpArgs` when supplied, while
the selected server and argument names need inspection on the canvas. Generation
prefers Agent Profiles for AI work but honors a goal that explicitly excludes
Agent nodes. Such a Command bypasses Agent Profiles and is flagged in preview.
Accepting a generated workflow saves it for editing; it never runs the graph.

## Agent prompt variables

Templates support `{{dotted.path}}` placeholders (no expressions, no eval):

- `{{workflow.name}}`, `{{workflow.id}}`
- `{{input.<name>}}` — declared workflow inputs (merged defaults + run values)
- `{{node.<id>}}` / `{{node.<id>.output}}` — stdout of a completed upstream node
- `{{node.<id>.status}}`, `{{node.<id>.exitCode}}`, `{{node.<id>.severity}}`,
  `{{node.<id>.visits}}` (completed visit count, useful for loop exits)

Missing variables fail the node with a clear message listing the names.
`\{{` renders a literal `{{`. See [agents.md](./agents.md).

## Validation

Errors block execution; warnings don't. Current rules:

- exactly one `start`, at least one `end`
- edges reference existing nodes; no self-loops
- command nodes require a non-empty `executable`
- agent nodes require an `agentProfileId` (or a well-known `agentRole`; other
  roles warn) and a non-empty `prompt`; `timeoutSecs` must be 1–43200 when set;
  `inputRefs` must reference existing nodes
- condition nodes require a non-empty `condition` and one `true` + one `false`
  outgoing edge; `true`/`false` labels elsewhere are errors; unknown labels warn
- Git/GitHub nodes need an operation and a folder (node `workingDir` or
  `defaults.repoDir`); branch, path, message, title and body fields must be
  filled, and a blank branch or PR head uses `defaults.branch` when it is set
- `retry.maxAttempts` 1–10, `retry.delayMs` ≤ 60000 (Command and Agent nodes);
  `timeoutSecs` 1–43200; `maxVisits` 1–100
- cycles need a `condition` on the loop and `maxVisits >= 2` on cycle nodes
- prompt/condition/session-group variable refs must resolve (`workflow.*`,
  declared `input.*`, `ticket.*`, existing `node.*`); inputs need valid unique
  names
- runs additionally require the referenced profile to exist and its CLI to be on
  `PATH` (checked at start; missing tools fail with `agent-cli-unavailable`)
- unreachable-from-start nodes → warning; dead-end non-`end` nodes → warning
- unknown future `schemaVersion` → hard error (“please update Orchevia”)

The editor's instant checks (`validateWorkflowLocal`) and the backend's
authoritative ones (`validate_workflow`) report the same codes: each issue has
a `code`, `severity`, and the `nodeId` and/or `edgeId` it is about. The shared
fixture `src/test/validation-parity.json` lists every code and runs on both
sides. Checks that need the database or `PATH` (profiles, CLIs, MCP servers,
required run inputs) only happen when a run starts; the fixture lists them as
exemptions.

## Execution semantics

- Deterministic DAG scheduling: independent ready nodes run in definition order,
  with up to four concurrent nodes. Joins wait for active incoming paths. Cycles
  require a Condition guard and bounded visits.
- Non-zero exit codes fail the run at that node; later nodes are skipped.
- Approval nodes pause durably; resume continues with remaining nodes.
- Agent nodes (v2): render the `prompt` template against workflow vars + completed
  upstream outputs, build adapter argv (`claude -p …` / `codex exec … -`, prompt on
  stdin), validate the working directory, then run like a command with the
  node/profile timeout.
- v3 engine: DAG scheduling with fan-out/fan-in joins, condition branches
  (`true`/`false` edges), `failure` recovery edges, bounded retries with backoff,
  guarded loops (`maxVisits`), typed workflow inputs, and structured results
  (`attempt`, `durationMs`, `structuredJson` with severity/branch extras).
  Full contract: [execution.md](./execution.md).
- v4 integrations: `git`/`github`/`ticket`/`mcp` nodes execute through local
  adapters (`git`, `gh`, MCP stdio) with provenance in `structuredJson` and
  `ticket.*` aliases from the latest ticket result. Guide:
  [integrations.md](./integrations.md).
- Cancellation sets a flag checked between nodes and kills an in-flight child.

## Migrations

`migrate_workflow` in `crates/core/src/workflow.rs` upgrades older documents
(`0 → 1 → 2 → 3 → 4`; version-only bumps since new fields are
optional with defaults). Rules: never silently drop unknown executable
semantics; reject unknown node types at validation; keep migrations covered by
serialization round-trip tests.

## Simple workflow documents

The JSON editor defaults to a developer document with `version: 1`, `name`,
`nodes` (`key`, `type`, `label`, `config`), `edges` (`from`, `to`, optional
`label`), and optional `inputs`/`defaults`. Canvas positions and machine IDs
stay in the runtime definition. Unchanged keys preserve existing IDs and
positions; update edges and `node.<key>` references when renaming a key.
Agent selections use `role` and optional exact `profileName`. Duplicate or
missing profile names require setup. Advanced JSON retains the complete schema-v6
definition; legacy workflow and template files remain importable. Template
exports use the simple document while preserving template metadata.

Arrange defaults to top-to-bottom dependency ranks. Use its direction control
for left-to-right graphs. Bounded cycles stay grouped, parallel branches get
separate lanes, and measured node sizes determine spacing. Arrangement changes
positions only, and existing manual positions stay until you click Arrange.

Built-in templates use a required `testCommand` input for project validation.
Supply the repository's real test command at run time. Each Command argument
uses the same variable renderer as prompts; interpolation preserves the argument
as one value, and missing variables fail before launching the process. Executables
remain literal. Use the renderer's escape syntax for literal template tokens.

For graphs over twelve nodes, Arrange opens the first dependency steps at a
readable zoom instead of shrinking the complete chain into tiny labels. Pan or
use the minimap to follow later steps; Fit View remains available for an overview.

Simple and Advanced imports reject malformed typed values before saving. Legacy
`gitHub` imports normalize to `github` in both backends. Reference conversion
preserves placeholder whitespace and escaped tokens; only declared `inputRefs`
and condition left-hand variables receive bare-reference remapping. Condition
right-hand operands and ordinary MCP argument values remain literals.

## Editor persistence and layout (v0.1.8)

Workflow names, defaults, inputs, node configuration and graph changes autosave
through one per-workflow queue after a short debounce. The header shows Saving,
Saved, or a save error with Retry. Failed drafts remain in memory through
navigation and refresh. Save controls remain on JSON import/edit and other
explicit forms. Close/reload only after Saved; failed drafts are not durable
until a retry succeeds. Deletion waits for queued saves so a late save cannot
recreate a deleted workflow.

Arrange supports vertical and horizontal dependency layers. It centers forks
and joins, orders guarded loops from their entry, uses measured node bounds and
packs disconnected islands separately. It changes positions only. The initial
view and Arrange reserve room beneath the translucent toolbar; long graphs
open their leading steps at a readable zoom, with Fit View and the minimap
available for the whole graph.

## Optional Agent context fields

`sessionGroup?: string`, `sessionMaxTurns?: number` (1–20, default 4),
`contextRefs?: string[]` (up to 16 completed other nodes), and
`contextMaxChars?: number` (256–64000, default 12000) are mirrored in the core,
inspector and Simple JSON. They require no schema migration. Session variables
and handoff IDs are validated/remapped with existing workflow references.
See [workflow cost controls](workflow-costs.md) for execution semantics.

## Declared Agent tools

`requiredTools?: string[]` on an Agent node lists the Claude Code allow rules the
step needs (`mcp__jira`, `Bash(git status *)`, `Edit`). It is optional and grants
nothing by itself. Rules use the same syntax and validation as a profile's
[allowed tools](agents.md#tool-permissions) (`agent-required-tools-invalid`), and
the field is rejected on other node kinds (`agent-required-tools-misplaced`).

Simple JSON and template exports carry the field inside the node `config`. The
template wrapper `version` and the inner document `version` stay 1, so earlier
exports import unchanged. When a template is imported, a workflow is opened, or a
run starts, Orchevia lists the declared tools that the chosen Claude Code profile
does not grant and offers to add them to that profile's allowed tools. A node
that names only a role is checked against the profile the role maps to. Codex and
custom profiles have no tool list and are not checked. No schema migration is
needed.

## Run controls

Workflow schema remains v6. Controls belong to run history rather than exported
workflow definitions. `runWorkflow(workflowId, inputs, options)` accepts optional:

- `dryRun`: boolean, default false.
- `fixtures`: node-id map of ordered fixture results; allowed only for dry-runs.
- `spendLimitUsd`: positive finite number; ordinary execution only, default absent.
- `maxAgentAttempts` / `maxToolCalls` / `maxSubagents`: per-run overrides of the
  saved workflow limits (whole numbers ≥ 1 within hard bounds); absent inherits.
- `ignoreSavedLimits`: when true, saved workflow limits are ignored for this run
  while explicit overrides still apply.

Saved workflows may carry optional `limits` (`maxAgentAttempts`,
`maxToolCalls`, `maxSubagents`, `spendLimitUsd`) and per-Agent-node
`maxToolCalls` / `maxSubagents` allowances; all are mirrored in validation,
Simple JSON (document v1) and generation assistance, and require no schema
migration. Stored runs include `execution.options`, optional
`execution.recoveredFrom`, per-node `execution.recoveryChoices`, snapshotted
`execution.resolvedLimits`, a persisted `execution.consumedAgentAttempts` counter, and optional `execution.spendPause` / `execution.usagePause` guards,
each with its unique `id`. Existing SQLite databases migrate additively with
ordinary execution defaults. Fixtures cannot set reserved execution metadata.
New commands remain thin Backend → Tauri → core calls: `previewRecovery`,
`recoverRun`, `continueSpendRun`, `continueUsageRun`, `usageSummary`, and
`adapterCapabilities`.

Recovery previews include a source fingerprint and per-node allowed choices.
Submission requires those decisions and a request id for idempotence. Retained
result rows carry `reusedFrom: {runId, resultId}` when consumed by the scheduler;
source session/usage metadata is stripped. Spend pauses have distinct
`guardPaused`/`guardContinued` history rows and do not fabricate workflow node success.
