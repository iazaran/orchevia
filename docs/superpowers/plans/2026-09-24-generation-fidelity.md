# Workflow Generation Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Generate compact workflows that use Orchevia's supported Agent, Git, GitHub, Ticket, MCP, Condition, Approval, and Command capabilities when they fit the user's goal, while preserving exact native operations and explicit user restrictions.

**Architecture:** Extend the existing version 1 generation proposal with the existing tagged GitOp and GitHubOp types. Keep parsing, compilation, validation, and risk analysis in orchevia-core; keep the Tauri command thin and render operation details from the returned Workflow in the existing React preview. No new workflow architecture or provider integration is needed.

**Tech Stack:** Rust, serde, Tauri 2, React/TypeScript, Vitest, SQLite.

**Spec:** docs/superpowers/specs/2026-09-24-generation-fidelity-design.md

## Global Constraints

- Do not stage or commit files. The user explicitly requested both.
- Follow AGENTS.md: inspect similar code first, reuse existing model/backend/UI patterns, self-review, and run every listed gate.
- Keep CURRENT_SCHEMA_VERSION at 6 on both sides. Keep GENERATION_SCHEMA_VERSION at 1 because gitOp and githubOp are optional proposal fields.
- Generation uses locally installed CLIs; preview and accept never execute the resulting workflow.
- Explicit user node restrictions override native preferences. Use the fewest nodes that preserve material steps, dependencies, decisions, and requested approval gates.
- No new node kind, process runner, database table, provider account, telemetry path, or third-party dependency.
- Keep the Backend and MockBackend contract aligned if either interface changes. In this plan the GenerationPreview shape remains unchanged.
- Workflow write risks must continue through the existing trust analysis and run-time checks.

## Review Focus

1. An explicit “no Agent nodes” goal must not be overridden by prompt text or an executable-less Command repair. Pinned by Tasks 1 and 2.
2. A generated Git/GitHub node lacking gitOp/githubOp must fail with a repairable error rather than silently run status. Pinned by Task 1.
3. A native write operation missing a required name, branch, or PR title must remain blocked by validate_workflow. Pinned by Task 1.
4. A Ticket/MCP step must keep its key/tool and existing local-server setup guidance. Pinned by Task 1 and the capability instructions in Task 2.
5. An unsupported native operation such as git push must be described as a risky Command fallback; the generator must not invent GitOp::Push. Pinned by Tasks 1 and 2.

## File map

- crates/core/src/generation.rs: proposal fields, compiler rules, prompt text, colocated Rust tests.
- src/lib/generation.ts and src/lib/generation.test.ts: pure preview description helper and its tests.
- src/components/WorkflowsView.tsx and src/styles.css: show the actual operation/role/tool in the existing preview list.
- src/components/RunsView.tsx and src/lib/markdown.ts: correct baseline lint/format issues so required gates can pass, with no Runs behavior change.
- CHANGELOG.md, docs/architecture.md, docs/workflow-schema.md, implementation-plan/generation-fidelity.md: describe the shipped generation behavior.
- No workflow schema migration, new Tauri command, or new Backend method is planned.

---

### Task 1: Preserve generated native operations

**Files:**

- Modify and test: crates/core/src/generation.rs
- Reuse: crates/core/src/workflow.rs GitOp, GitHubOp, validate_workflow; crates/core/src/trust.rs workflow_risks

**Interfaces:**

- Consumes: GenerationProposal and ProposalNodeConfig from generation.rs; GitOp and GitHubOp from workflow.rs.
- Produces: ProposalNodeConfig.git_op: Option<GitOp> and github_op: Option<GitHubOp>, compiled to NodeConfig.git_op and github_op.

- [ ] **Step 1: Write failing tests for native operation preservation and risk.** Add this test in the existing generation tests module:

```rust
#[test]
fn generated_native_operations_keep_the_requested_actions() {
    use crate::workflow::{GitHubOp, GitOp, WorkflowDefaults};
    let text = r#"{"version":1,"name":"Open PR","nodes":[
      {"key":"start","type":"start","config":{}},
      {"key":"branch","type":"git","label":"Create branch","config":{"gitOp":{"op":"branchCreate","name":"feature/x"}}},
      {"key":"pr","type":"github","label":"Open draft PR","config":{"githubOp":{"op":"createPr","title":"Feature X","base":"main","head":"feature/x","draft":true}}},
      {"key":"end","type":"end","config":{}}],
      "edges":[{"from":"start","to":"branch"},{"from":"branch","to":"pr"},{"from":"pr","to":"end"}]}"#;
    let proposal = parse_proposal(text).expect("parse");
    let preview = compile_proposal(
        &proposal,
        &role_map(),
        "wf-native",
        Some(WorkflowDefaults { repo_dir: Some("/tmp".into()), branch: None }),
    ).expect("compile");
    assert!(matches!(
        preview.workflow.nodes[1].config.git_op.as_ref(),
        Some(GitOp::BranchCreate { name }) if name == "feature/x"
    ));
    assert!(matches!(
        preview.workflow.nodes[2].config.github_op.as_ref(),
        Some(GitHubOp::CreatePr { base, head, draft, .. })
            if base == "main" && head == "feature/x" && *draft
    ));
    assert!(preview.blocking_errors().is_empty());
    assert!(preview.risk_labels.iter().any(|label| label == "Create commits / branches"));
    assert!(preview.risk_labels.iter().any(|label| label == "Push / create or comment on PRs"));
}
```

- [ ] **Step 2: Run the focused test and confirm it fails.**

Run: cargo test -p orchevia-core generation::tests::generated_native_operations_keep_the_requested_actions

Expected: the Git or GitHub operation assertion fails because compilation currently substitutes status/prStatus.

- [ ] **Step 3: Add the proposal fields and compile them directly.** Import GitOp and GitHubOp from workflow.rs, then add fields to ProposalNodeConfig and replace the two integration-node match arms:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub git_op: Option<GitOp>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub github_op: Option<GitHubOp>,
```

```rust
NodeKind::Git => {
    out.git_op = Some(config.git_op.clone().ok_or_else(|| {
        format!("Git node '{label}' needs config.gitOp; choose a supported operation.")
    })?);
    out.working_dir = config.working_dir.clone();
}
NodeKind::GitHub => {
    out.github_op = Some(config.github_op.clone().ok_or_else(|| {
        format!("GitHub node '{label}' needs config.githubOp; choose a supported operation.")
    })?);
    out.working_dir = config.working_dir.clone();
}
```

- [ ] **Step 4: Add rejection and preservation tests before changing Command repair.** Replace empty_executable_without_args_becomes_agent_step with the first test below, then add the others:

```rust
#[test]
fn empty_executable_without_args_is_rejected() {
    let text = proposal_with_command(r#"{"executable":"","args":[]}"#);
    let proposal = parse_proposal(&text).expect("parse");
    let err = compile_proposal(&proposal, &role_map(), "wf-empty", None)
        .expect_err("missing executable must be repaired");
    assert!(err.contains("config.executable"), "{err}");
}

#[test]
fn generated_native_op_must_be_explicit() {
    let mut proposal = parse_proposal(PROPOSAL).expect("parse");
    proposal.nodes[1].kind = "git".into();
    proposal.nodes[1].config = ProposalNodeConfig::default();
    let err = compile_proposal(&proposal, &role_map(), "wf-git", None)
        .expect_err("missing git operation");
    assert!(err.contains("config.gitOp"), "{err}");
}

#[test]
fn unsupported_git_op_is_rejected_during_parse() {
    let text = r#"{"version":1,"name":"W","nodes":[
      {"key":"g","type":"git","config":{"gitOp":{"op":"push"}}}]}"#;
    assert!(parse_proposal(text).is_err());
}

#[test]
fn incomplete_native_write_is_blocked_by_workflow_validation() {
    use crate::workflow::{GitHubOp, WorkflowDefaults};
    let mut proposal = parse_proposal(PROPOSAL).expect("parse");
    proposal.nodes[1].kind = "github".into();
    proposal.nodes[1].config = ProposalNodeConfig {
        github_op: Some(GitHubOp::CreatePr {
            title: "Feature x".into(),
            body: String::new(),
            base: String::new(),
            head: "feature/x".into(),
            draft: true,
        }),
        ..ProposalNodeConfig::default()
    };
    let preview = compile_proposal(
        &proposal, &role_map(), "wf-pr",
        Some(WorkflowDefaults { repo_dir: Some("/tmp".into()), branch: None }),
    ).expect("compile to blocked preview");
    assert!(preview.blocking_errors().iter().any(|e| e.contains("base and head")));
}

#[test]
fn explicit_ai_cli_command_stays_a_command_with_a_warning() {
    let text = proposal_with_command(
        r#"{"executable":"codex","args":["exec","Review the change"]}"#,
    );
    let proposal = parse_proposal(&text).expect("parse");
    let preview = compile_proposal(&proposal, &role_map(), "wf-cli", None).expect("compile");
    assert_eq!(preview.workflow.nodes[1].kind, NodeKind::Command);
    assert!(preview.repairs.iter().any(|note| note.contains("Agent Profile")));
}

#[test]
fn unsupported_push_stays_a_risky_command() {
    let text = proposal_with_command(
        r#"{"executable":"git","args":["push","origin","feature/x"]}"#,
    );
    let proposal = parse_proposal(&text).expect("parse");
    let preview = compile_proposal(&proposal, &role_map(), "wf-push", None).expect("compile");
    assert_eq!(preview.workflow.nodes[1].kind, NodeKind::Command);
    assert_eq!(preview.workflow.nodes[1].config.executable.as_deref(), Some("git"));
    assert!(preview.risky_nodes.iter().any(|label| label == "Migrate"));
}
```

Update native_integration_nodes_kept_with_setup_guidance so its Git node uses config.gitOp = {"op":"status"}. Keep its Ticket/MCP setup assertions and add the following value checks:

```rust
let ticket = preview.workflow.nodes.iter().find(|n| n.id == "t").expect("ticket");
assert_eq!(ticket.config.ticket_key.as_deref(), Some("{{input.ticket}}"));
let tool = preview.workflow.nodes.iter().find(|n| n.id == "m").expect("mcp");
assert_eq!(tool.config.mcp_tool.as_deref(), Some("jira_get_issue"));
```

- [ ] **Step 5: Remove the semantic-changing Command repair and warn on direct AI CLIs.** Reject missing `config.executable` whether or not `args[0]` looks like a tool name. Return:

```rust
return Err(format!(
    "Command node '{label}' needs config.executable; supply a concrete local tool."
));
```

For direct claude/codex executables add a preview repair note in the Command arm:

```rust
if matches!(exe, "claude" | "codex") {
    repairs.push(format!(
        "'{label}': direct AI CLI Command bypasses Agent Profiles; review its args and timeout."
    ));
}
```

Keep the existing shell-wrapped AI warning. Preserve a valid explicit Command, including git push. The direct `git push` Command is classified as a remote write by the existing trust analysis with a narrow check in `trust.rs`.

- [ ] **Step 6: Run focused Rust tests.**

Run: cargo test -p orchevia-core generation::tests

Expected: all generation tests pass, including the revised former auto-Agent test and the existing Ticket/MCP setup test.

### Task 2: Make the generator choose the right existing capabilities

**Files:**

- Modify and test: crates/core/src/generation.rs

**Interfaces:**

- Consumes: build_generator_prompt(goal, roles_available, known_kinds, repo).
- Produces: the same function signature and JSON proposal format; no Tauri or frontend contract change.

- [ ] **Step 1: Write a failing prompt test.** Keep generator_prompt_pins_native_first_design, then add:

```rust
#[test]
fn generator_prompt_prioritizes_user_shape_and_full_capability_set() {
    let prompt = build_generator_prompt(
        "No Agent nodes. Read a ticket, decide whether to continue, and request approval.",
        &["implementation".to_string()],
        &["start", "agent", "command", "git", "github", "ticket", "mcp", "condition", "approval", "end"],
        None,
    );
    assert!(prompt.contains("Explicit user node restrictions override preferences"));
    assert!(prompt.contains("fewest nodes that preserve"));
    assert!(prompt.contains("config.gitOp"));
    assert!(prompt.contains("config.githubOp"));
    assert!(prompt.contains("Ticket, MCP Tool, Condition, Human Approval"));
    assert!(prompt.contains("git push"));
    assert!(!prompt.contains("Interpret SHAPE bans loosely"));
    assert!(!prompt.contains("AI work ALWAYS uses"));
}
```

Run: cargo test -p orchevia-core generation::tests::generator_prompt_prioritizes_user_shape_and_full_capability_set

Expected: fail on the missing new precedence and operation instructions.

- [ ] **Step 2: Revise the existing prompt rules in place.** Keep dynamic known kinds, roles, repository grounding, bounds, compact JSON, and explicit preview-only semantics. Replace the conflicting “shape bans loosely” and “AI ALWAYS” rules with these rules, escaping braces for the Rust format! literal:

```text
- Explicit user node restrictions override preferences. If the goal says no Agent nodes, return no Agent nodes; use concrete Command steps for AI CLIs only when required by that restriction. Explain the profile bypass in "explanation".
- Choose the fewest nodes that preserve material work, dependencies, decisions, and requested approval gates. Merge adjacent work only when it has the same execution boundary; never drop a requested side effect, review, branch, or approval.
- Choose among Agent, Git, GitHub, Ticket, MCP Tool, Condition, Human Approval, and Command according to the goal. Do not force every capability into each workflow.
- Use native Agent nodes for AI work unless the goal explicitly excludes them. Use Ticket for a known ticket key, MCP Tool for a named server tool, Condition for true/false decisions, and Human Approval for a human gate.
- Native Git nodes need config.gitOp, for example {"op":"status"}, {"op":"branchCreate","name":"feature/x"}, or {"op":"commit","message":"Implement feature x"}.
- Native GitHub nodes need config.githubOp, for example {"op":"listPrs","state":"open"} or {"op":"createPr","title":"Feature x","base":"main","head":"feature/x","draft":true}.
- Git push is not a supported native Git operation. If required, use a clearly labeled Command with executable "git" and args ["push","origin","feature/x"], which is flagged as risky in preview. Never invent a GitOp value.
```

Also replace the unconditional “never wrap git, gh, or AI CLI” rule with native preference plus the explicit restriction/unsupported-operation exceptions. Replace the opening “No shell commands” phrase with “No schedules, triggers, credentials, or invented node kinds; shell mechanics belong only in Command nodes.” Retain a concrete executable requirement for Command nodes. Add these two prompt examples, with braces escaped in the Rust format! literal; server selection remains post-preview setup:

```text
- Ticket example: {"type":"ticket","config":{"ticketKey":"{{input.ticket}}"}}.
- MCP Tool example: {"type":"mcp","config":{"mcpTool":"searchJiraIssuesUsingJql"}}.
```

Keep compact output as an efficiency aid, not a reason to omit material steps.

- [ ] **Step 3: Run focused prompt and parser/compiler tests.**

Run: cargo test -p orchevia-core generation::tests

Expected: all generation tests pass. Inspect the resulting prompt text once for contradictions involving Agent bans, shell commands, and native unsupported operations.

### Task 3: Show what generated nodes will actually do

**Files:**

- Modify and test: src/lib/generation.ts, src/lib/generation.test.ts
- Modify: src/components/WorkflowsView.tsx, src/styles.css

**Interfaces:**

- Consumes: WorkflowNode from src/lib/workflow.ts.
- Produces: describeGeneratedStep(node: WorkflowNode): string for existing preview display. GenerationPreview and Backend stay unchanged.

- [ ] **Step 1: Write failing pure-helper tests.** Import describeGeneratedStep into generation.test.ts and add tests using WorkflowNode values with position {x:0,y:0}. Pin at least these results:

```ts
expect(
  describeGeneratedStep({
    id: 'branch',
    type: 'git',
    position: { x: 0, y: 0 },
    config: { gitOp: { op: 'branchCreate', name: 'feature/x' } },
  }),
).toBe('branchCreate: feature/x');
expect(
  describeGeneratedStep({
    id: 'pr',
    type: 'github',
    position: { x: 0, y: 0 },
    config: {
      githubOp: {
        op: 'createPr',
        title: 'Feature x',
        base: 'main',
        head: 'feature/x',
        draft: true,
      },
    },
  }),
).toBe('createPr: feature/x → main');
expect(
  describeGeneratedStep({
    id: 'ticket',
    type: 'ticket',
    position: { x: 0, y: 0 },
    config: { ticketKey: '{{input.ticket}}' },
  }),
).toBe('Ticket: {{input.ticket}}');
expect(
  describeGeneratedStep({
    id: 'tool',
    type: 'mcp',
    position: { x: 0, y: 0 },
    config: { mcpTool: 'searchJiraIssuesUsingJql' },
  }),
).toBe('MCP tool: searchJiraIssuesUsingJql');
```

Add these three cases to the same test:

```ts
expect(
  describeGeneratedStep({
    id: 'agent',
    type: 'agent',
    position: { x: 0, y: 0 },
    config: { agentRole: 'implementation', prompt: 'Implement' },
  }),
).toBe('Agent role: implementation');
expect(
  describeGeneratedStep({
    id: 'cmd',
    type: 'command',
    position: { x: 0, y: 0 },
    config: { executable: 'cargo', args: ['test'] },
  }),
).toBe('CLI: cargo');
expect(
  describeGeneratedStep({
    id: 'missing',
    type: 'git',
    position: { x: 0, y: 0 },
    config: {},
  }),
).toBe('Operation missing');
```

Run: pnpm exec vitest run src/lib/generation.test.ts. Expected: fail because the helper does not exist.

- [ ] **Step 2: Implement the pure helper in generation.ts.** Import WorkflowNode as a type and use the existing discriminated config fields. Use this behavior:

```ts
export function describeGeneratedStep(node: WorkflowNode): string {
  if (node.type === 'git') {
    const op = node.config.gitOp;
    if (op === undefined) return 'Operation missing';
    if (op.op === 'branchCreate' || op.op === 'checkout') return op.op + ': ' + op.name;
    if (op.op === 'commit') return 'commit: ' + op.message;
    return op.op;
  }
  if (node.type === 'github') {
    const op = node.config.githubOp;
    if (op === undefined) return 'Operation missing';
    if (op.op === 'createPr') return 'createPr: ' + op.head + ' → ' + op.base;
    return op.op;
  }
  if (node.type === 'agent') return 'Agent role: ' + (node.config.agentRole ?? 'missing');
  if (node.type === 'ticket') return 'Ticket: ' + (node.config.ticketKey ?? 'missing');
  if (node.type === 'mcp') return 'MCP tool: ' + (node.config.mcpTool ?? 'missing');
  if (node.type === 'command') return 'CLI: ' + (node.config.executable ?? 'missing');
  if (node.type === 'approval') return 'Human approval';
  if (node.type === 'condition') return 'True / false decision';
  return '';
}
```

- [ ] **Step 3: Run the focused helper tests.**

Run: pnpm exec vitest run src/lib/generation.test.ts

Expected: pass.

- [ ] **Step 4: Render the detail in the existing Proposed steps list.** Import describeGeneratedStep in WorkflowsView.tsx. After each node label, render the returned detail only when it is nonempty, using a span with class preview-step-detail. Replace the existing Proposed steps map with:

```tsx
{
  preview.workflow.nodes.map((n) => {
    const detail = describeGeneratedStep(n);
    return (
      <li key={n.id}>
        <span className="status-pill status-paused">{n.type}</span> {n.label ?? n.id}
        {detail !== '' && <span className="preview-step-detail">{detail}</span>}
      </li>
    );
  });
}
```

Add this CSS:

```css
.preview-step-detail {
  display: block;
  color: var(--text-2);
  overflow-wrap: anywhere;
  margin-left: 2px;
}
```

The current preview-steps height cap and scrolling remain. Confirm a generated branch or PR shows its real operation, while Ticket/MCP/Agent nodes identify the selected key/tool/role.

- [ ] **Step 5: Run the frontend unit and type checks.**

Run: pnpm exec vitest run src/lib/generation.test.ts

Run: pnpm typecheck

Expected: both pass.

### Task 4: Documentation, required gates, and self-review

**Files:**

- Modify: CHANGELOG.md, docs/architecture.md, docs/workflow-schema.md
- Create: implementation-plan/generation-fidelity.md
- Touch only for baseline gate fixes: src/components/RunsView.tsx, src/lib/markdown.ts, src/styles.css

**Interfaces:**

- Consumes: completed Tasks 1–3.
- Produces: accurate documentation and a fully passing required check set.

- [ ] **Step 1: Correct the two existing lint errors without changing Runs behavior.** Remove the redundant activeRun === null guard at RunsView.tsx:393 because the containing render branch already narrows it. In markdown.ts, replace the control-character sentinel with a private-use sentinel in both places:

```ts
return '\uE000' + String(codeSpans.length - 1) + '\uE000';
```

```ts
return rich.replace(/\uE000(\d+)\uE000/g, (_, i: string) => codeSpans[Number(i)] ?? '');
```

Run: pnpm lint and pnpm exec vitest run src/lib/markdown.test.ts. Expected: pass.

- [ ] **Step 2: Format only the files required by these changes and the known baseline formatting failures.**

Run: pnpm exec prettier --write src/components/RunsView.tsx src/lib/markdown.ts src/styles.css src/lib/generation.ts src/lib/generation.test.ts src/components/WorkflowsView.tsx

Expected: Prettier exits 0. Do not use pnpm format, which rewrites the whole repository.

- [ ] **Step 3: Document exact behavior.** Add a CHANGELOG.md entry that native Git/GitHub proposal operations are preserved, explicit node restrictions take priority, unsupported operations remain visible/risky Command steps, and preview lists real actions. Update docs/architecture.md's generation section and docs/workflow-schema.md's generation examples with tagged gitOp/githubOp JSON. Create implementation-plan/generation-fidelity.md with the chosen scope, test evidence, and remaining Runs/UI phases. The documentation must say that an explicit CLI-only goal may bypass Agent Profiles and that preview never auto-runs. Use these statements in the generation section and changelog entry:

```md
- Generated Git/GitHub nodes retain their requested supported operation. Missing operations are rejected for repair; they no longer default to status.
- The generator selects Agent, Git, GitHub, Ticket, MCP Tool, Condition, Human Approval, and Command nodes as the goal needs, using as few nodes as the required work allows. Explicit node restrictions take priority.
- A CLI-only goal can bypass Agent Profiles through Command nodes. Review those commands and risks before accepting. Accepting never runs the workflow.
```

```json
{"type":"git","config":{"gitOp":{"op":"branchCreate","name":"feature/x"}}}
{"type":"github","config":{"githubOp":{"op":"createPr","title":"Feature x","base":"main","head":"feature/x","draft":true}}}
```

- [ ] **Step 4: Run every AGENTS.md gate and the production frontend build.**

Run each and record its observed exit status:

- pnpm check
- cargo test -p orchevia-core
- cargo clippy -p orchevia-core --all-targets -- -D warnings
- cargo fmt --check
- cargo check -p orchevia
- pnpm build

Expected: each exits 0. Fix failures without weakening rules. The repository already has unrelated formatting/lint failures in Runs/Markdown; Step 1–2 clears them.

- [ ] **Step 5: Self-review the unstaged work.** Check the Git/GitHub operation fields against the Rust and TS workflow types, test the no-Agent and native-first prompt wording for contradictions, inspect all modified files, and confirm generation still never runs accepted workflows. Use git status --short to confirm nothing was staged or committed. Report tests and any manual native-CLI verification separately; do not claim provider-model reliability from deterministic tests alone.

## Manual acceptance after implementation

Use four small goals on an isolated test repository: a read-only answer, a native branch-and-draft-PR proposal, a ticket/MCP decision with approval, and an explicit no-Agent CLI proposal. Inspect the preview before accepting anything; do not run write-capable workflows during this generation check. If a real Claude or Codex generation attempt cannot be made in the current environment, report the limitation and hand these exact cases to the user for their later testing. The next independent design/plan cycles address Runs output and then UI/public presentation.
