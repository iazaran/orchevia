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
- agent nodes require an `agentProfileId` and a non-empty `prompt`; `timeoutSecs`
  must be 1–43200 when set; `inputRefs` must reference existing nodes
- condition nodes require a non-empty `condition` and one `true` + one `false`
  outgoing edge; `true`/`false` labels elsewhere are errors; unknown labels warn
- `retry.maxAttempts` 1–10, `retry.delayMs` ≤ 60000; `timeoutSecs` 1–43200;
  `maxVisits` 1–100
- cycles need a `condition` on the loop and `maxVisits >= 2` on cycle nodes
- prompt/condition variable refs must resolve (`workflow.*`, declared
  `input.*`, existing `node.*`); inputs need valid unique names
- runs additionally require the referenced profile to exist and its CLI to be on
  `PATH` (checked at start; missing tools fail with `agent-cli-unavailable`)
- unreachable-from-start nodes → warning; dead-end non-`end` nodes → warning
- unknown future `schemaVersion` → hard error (“please update Orchevia”)

## Execution semantics

- Deterministic DAG scheduling: independent ready nodes run in definition order,
  with up to four concurrent nodes. Joins wait for active incoming paths. Cycles
  require a Condition guard and bounded visits.
- Non-zero exit codes fail the run at that node; later nodes are skipped.
- Approval nodes pause durably; resume continues with remaining nodes.
- Agent nodes (v2): render the `prompt` template against workflow vars + completed
  upstream outputs, build adapter argv (`claude -p …` / `codex exec …`), validate the
  working directory, then run like a command with the node/profile timeout.
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
