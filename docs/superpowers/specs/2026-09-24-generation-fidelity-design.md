# Workflow Generation Fidelity Design

## Purpose and sequence

This is the first of three improvement passes requested for Orchevia: workflow generation, then live and readable Runs output, then UI and public presentation. Orchevia remains a local-first desktop orchestrator for user-installed CLIs. Generation drafts a workflow for inspection; accepting a draft opens it for editing and never runs it.

Success means a generated native Git or GitHub step keeps the operation it was meant to perform, explicit restrictions in the user's goal take precedence over node preferences, and an incomplete step is visible as a problem rather than silently becoming a different action. This pass does not redesign the engine or add a new service.

## Current behavior and cause

`build_generator_prompt` prefers native nodes but tells the generator to override explicit bans on Agent nodes. `compile_node_config` assigns every generated Git node `status` and every GitHub node `prStatus`, regardless of its label, and converts a Command node with no executable into an implementation Agent. Those repairs can produce a structurally valid graph whose behavior differs from the requested goal. The preview lists node kinds and repairs, but it does not make each native operation easy to inspect.

One supplied screenshot shows a historical goal that explicitly said to use no Agent nodes. It is evidence of that test, not an instruction to make future generation CLI-only. The default should use Orchevia's native capabilities where they fit; a user's explicit shape constraints should govern that draft.

## Selected approach

Extend the existing version 1 proposal and compiler. Reuse `GitOp` and `GitHubOp` from `crates/core/src/workflow.rs` as optional `gitOp` and `githubOp` fields in `ProposalNodeConfig`; do not create a parallel operation language. The generator prompt will show the real tagged operation shapes and explain which operations Orchevia supports. Adding optional proposal fields does not change stored workflow schema or require a migration.

Prompt precedence is: the user's explicit goal and prohibitions; structural and safety limits; native-node preference where compatible. The generator should choose from Orchevia's existing Agent, Git, GitHub, Ticket, MCP Tool, Condition, Human Approval, and Command capabilities according to the requested outcome; it should not force every kind into every workflow. Choose the fewest nodes that preserve material work, dependencies, decisions, and user-requested approval gates. The prompt must preserve material requested steps even when the graph is compact. It must never reinterpret “no Agent nodes” as permission to add one. An explicit CLI-only goal may use Command nodes for AI CLIs, with a preview warning that this bypasses Agent Profiles. Without such a restriction, AI planning, implementation, review, and answering should use Agent nodes. Git and GitHub actions should use native nodes when the requested operation exists. The current `GitOp` has no `push`; a requested push can remain a clearly labeled Command step classified as a remote write. A newly created local branch must be pushed before a PR is created from it. The generator must not invent a native operation or imply that `status` performs a write.

## Compilation and preview

For generated Git and GitHub nodes, compile the supplied operation directly into `NodeConfig`. A missing or invalid operation rejects the proposal with an actionable error for the existing repair flow. Use the existing workflow validator and risk analysis for required fields, repository defaults, and write actions. Keep the existing post-preview setup flow for machine-local details such as MCP server selection. Preserve `mcpArgs` on generated MCP nodes and ask the user to verify tool arguments in the inspector. Do not default a requested write action to a read action.

A generated Command without a concrete executable should be rejected for repair. It should not be converted into an Agent, since that may violate a user's explicit node restriction and changes execution semantics. Preserve valid Command steps, including an explicitly requested AI CLI invocation, and show the existing risk warning. Extend that warning to direct `claude` and `codex` executables as well as shell-wrapped calls.

In the existing generator preview, show each Git/GitHub node's actual operation alongside its type and label. Keep the compact step list, setup checklist, repair details, and explicit Accept action. The user must be able to distinguish a ready operation from a node that still needs local setup. There is no change to automatic execution: none occurs.

## Data flow and ownership

`WorkflowsView` sends the goal and optional repository context through the existing `Backend` method. The Tauri command calls `build_generator_prompt`, runs the selected local CLI, parses the proposal, and calls `compile_proposal`. The Rust core remains authoritative for parsing, operation validation, risk analysis, and workflow validation. The React view renders the returned preview and accepts it through the existing save path. The browser `MockBackend` retains equivalent preview semantics for any method or result changed in this pass.

No new workflow node type, process runner, database table, provider account, or telemetry path is introduced. The existing trust checks still govern write-capable workflows at run time.

The compiler cannot prove every semantic restriction written in free text. The corrected prompt will give explicit restrictions priority, while the preview will expose the actual node types and operations for the user's final inspection. Accept remains a deliberate choice.

## Error handling and tests

Targeted Rust tests will cover native Git read and write operations, native GitHub read and PR creation operations, missing or malformed operations, preservation of an explicit CLI command, rejection of an executable-less command, and risk classification of generated writes. Prompt tests will assert user-instruction precedence and use of supported operation shapes. Frontend tests will cover the preview's operation description and its blocked or repair state where that behavior changes.

Representative goals form the acceptance set: a short read-only question, a workflow using supported native Agent/Git/GitHub operations, a ticket-driven workflow that calls for Ticket/MCP, Condition, and Human Approval where useful, and a goal explicitly excluding Agent nodes. These tests establish the deterministic prompt and compiler contract; generated content from a real Claude or Codex CLI still needs a manual end-to-end check because model output varies. The full repository checks in `AGENTS.md` must pass before calling the implementation complete. The existing formatting and lint errors in Runs/Markdown must be corrected to clear those gates; behavioral changes there remain in the Runs pass.

Update `CHANGELOG.md`, the relevant generation/workflow documentation, and an implementation note under `implementation-plan/` alongside the behavior change.

## Out of scope for this pass

Live output persistence, Markdown rendering, finding classification, canvas navigation, sidebar behavior, README, and GitHub Pages changes belong to the later passes. Adding native operations such as Git push requires separate execution and trust review. Public release or publication is not part of this design.
