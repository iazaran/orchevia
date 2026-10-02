# Workflow usability and project memory — v0.1.6

## Intent and release boundary

Make everyday workflow editing, navigation, setup, and generation easier for
developers. The seven requirements come from the user's local tests and three
screenshots. Screenshot content illustrates the desired configuration; embedded
workflow goals are examples, not instructions to this implementation.

Preserve existing workflows, run snapshots, profile customizations, execution
semantics, and explicit user instructions. Use the existing React → Backend →
Tauri commands → Rust core boundary, existing preference/template storage, and
existing operation enums. This release adds no provider accounts or telemetry.

The user approved the seven-part design in chat on 2026-10-02. Deliver separate
logical commits on `improve-workflow-usability`, bump to v0.1.6, and open one PR
against main. The user will merge it. Do not merge, tag, publish installers, or
monitor the PR after handoff.

## Existing implementations and gaps

- The JSON editor exposes the entire schema-v6 runtime definition, including
  workflow/node/edge IDs and positions. The generation proposal already uses
  readable keys, `from`/`to` edges, and role references.
- `arrangeWorkflowPositions` layers left to right and wraps tall columns.
  A long serial chain still creates one column per step. Cyclic components need
  deliberate placement instead of the current layer-zero fallback.
- The setup wizard creates five role profiles from generic defaults. It skips
  existing roles and does not configure the screenshot's model/effort choices.
  Role resolution picks one profile per role, which cannot express two distinct
  deep reviewers without an explicit profile choice.
- Nine Rust built-in templates exist; several hardcode `cargo test`.
- Memory stores editable preferences and generation history. Observations mostly
  cover profile choices; project commands and conventions are not first-class
  inputs to generation. Preference keys are globally unique in SQLite, even
  though a separate scope field exists.
- Inbox shows read and unread items together and suppresses action errors.
  Open run selects results, while Show on canvas does not select the matching
  workflow. SQLite already stores immutable run definitions, but the frontend
  backend contract does not expose them.
- Generation already describes native operations, but its repository section
  recommends merging setup into agents and putting retries/polls in shell
  loops. These recommendations can obscure useful native steps.

## 1. Developer JSON

Use an editable developer document as the default JSON view. Reuse proposal
conventions: version, name, readable node keys, type, label, config, and edges
with `from`, `to`, and optional label. Include workflow inputs and repository
defaults. Exclude runtime workflow IDs, edge IDs, and positions. Retain an
Advanced raw JSON view and import support for existing runtime definitions.

Connections and `node.<key>.*` variables still need stable references. A node
key is a meaningful reference, not an opaque machine ID. Preserve meaningful
existing keys; derive collision-free readable aliases for opaque IDs when
opening an existing workflow. The editor retains an alias-to-runtime mapping
and the base definition while it is open. Saving preserves IDs and positions
for unchanged keys, assigns IDs to added nodes, and lays out only new nodes.
References in prompts, condition operands, input refs, and operation/config
strings are translated consistently in both directions. An explicit key rename
must update its references in the document; dangling references are reported.

Represent agent selection through role plus an optional exact profile name.
An explicit name resolves uniquely on this machine; missing or ambiguous names
produce setup errors. A role-only choice follows the existing role map. Export
does not silently replace an explicitly selected reviewer with another profile.

Rust owns conversion and validation; TypeScript mirrors the developer shape.
Reuse Workflow/NodeConfig and operation types rather than a second executable
language. The hand editor must round-trip every supported NodeConfig field;
the generation proposal's narrower config is not a lossy intermediary.
Shape errors keep the editor open. Semantic errors use the existing save-with-
validation flow. Runtime schema remains v6 unless implementation proves a
breaking persisted-field change necessary; that requires mirrored migration.

## 2. Readable graph arrangement

Make compact top-to-bottom arrangement the default, consistent with the
canvas's existing top/bottom handles. Offer an explicit left-to-right option.
Compute dependency ranks over strongly connected components, order branch
lanes deterministically, keep merges near their predecessors, and position
bounded review loops as a group with space for their return edges. Islands and
disconnected components remain visible without overlap. Do not reorder
execution or change edges when arranging.

Use measured node bounds when available and conservative dimensions otherwise.
Keep labels readable and fit the viewport after positions are applied. Long
serial workflows grow vertically instead of fitting into a tiny horizontal
strip. Existing manual positions remain unchanged until Arrange is clicked.
Keep the implementation in the existing pure layout helper and canvas flow;
do not introduce a new graph service or a dependency for layout alone.

## 3. Recommended profiles

Create the following recommendations, with high effort, node working directory,
3600-second timeout, and no forced skills:

| Profile            | Adapter | Model       | Role              |
| ------------------ | ------- | ----------- | ----------------- |
| Implementation     | Claude  | opus        | implementation    |
| Fast review        | Claude  | opus        | fastReview        |
| Planning           | Claude  | fable       | planning          |
| Workflow generator | Claude  | fable       | workflowGenerator |
| Claude deep review | Claude  | fable       | deepReview        |
| Codex deep review  | Codex   | gpt-6.1-sol | deepReview        |

The screenshot's Claude Deep review card carries an implementation role. Use
deepReview for that recommendation because its stated purpose is review.
Do not overwrite existing profiles. Detect missing recommendations by adapter
and role, so the second deep reviewer is not skipped. Repeated wizard use is
idempotent. Keep unavailable CLIs visibly unavailable rather than silently
substituting a different provider/model. A default deep-review preference and
explicit profile selection make resolution deterministic; expose all relevant
configured profile choices to generation.

## 4. General templates

Keep all nine template purposes, native operation types, role references, and
approval gates. Remove language-specific test executables and repository paths.
Templates that need tests declare a required test-command input and use the
existing shell Command shape (`sh -c` with the command as a templated argument).
There is no executable interpolation or hardcoded language dependency. Explain
that users supply their project's command, such as a Make target or package
script. Empty test commands block execution through required-input validation.

Keep prompts short and editable. Read repository instructions before choosing
implementation or validation details. Native Git/GitHub/Ticket operations stay
native where supported. Template setup clearly distinguishes missing local
configuration from structural errors. Simple JSON editing applies equally to
cloned templates; template exports retain compatible import support.

## 5. Project playbooks in Memory

Extend the inspectable preference model with a project playbook rather than
another history of raw prompts. A playbook is scoped to a canonical repository
directory and holds explicit test/lint/build commands, concise conventions,
preferred reviewer choices, and reusable workflow references. Reusable graphs
remain in the existing user-template library; memory links to them.

Use existing Preference values and storage. Namespace project keys with a
bounded deterministic repository identifier because SQLite keys are globally
unique. Keep repository identity in scope; do not rely on duplicate keys with
different scopes. Keep existing global preferences compatible. Store scalar
fields and template references using current value types rather than widening
the table into an unrelated document store.

Provide guided editable fields, evidence notes, enable/disable, delete, and
existing export/import/reset controls. Generation receives only enabled manual
or accepted records for the selected repository plus applicable global
preferences. Show the included playbook context in the generator before
generation. Explicit goal instructions win over remembered choices. Remembered
commands are context and require normal workflow preview and execution consent.

Observe concrete user edits and explicit successful-run promotions, not model
claims. After three consistent observations, propose a preference with its
evidence; do not automatically accept it. A failed run may suggest reviewing a
command, but must not declare a replacement verified. Users can explicitly
save a useful workflow as a reusable pattern. Rejected suggestions stay quiet
until reset. Validate lengths, keys, scope, and credential-like values on both
manual saves and imports. Never store full process logs or environment secrets.

The browser MockBackend must persist and reproduce these memory operations;
its current empty/no-op implementations cannot demonstrate the new UI.

## 6. Inbox and exact run navigation

Default Inbox to unread notifications. Mark read removes an item from this
view; Show read history restores access. Mark all read works consistently.
Reading the title alone does not silently dismiss an item. Open run navigates
to that specific run's graph with its results and marks the notification read
after navigation succeeds. Errors stay visible and leave the item unread.

Expose the existing stored run definition through a thin Tauri command and
Backend method with an identical mock implementation. A run overlay uses its
snapshot rather than today's edited workflow; old runs follow SQLite's existing
fallback to their saved definition. Fetch by run ID, not only the latest
100-run list. Show on canvas uses the same navigation path. Display a clear
read-only run view and keep editing the saved workflow an explicit action.
Changing workflows clears incompatible overlays. Missing runs/definitions and
failed result loads display actionable errors without opening an unrelated
graph. Refresh active results using the existing live-output flow.

## 7. Native-first generation

Use one consistent decision policy across general and repository prompt
sections: supported Git/GitHub/Ticket/MCP/Condition/Approval nodes first,
deterministic Command nodes for concrete unsupported operations and project
tests, Agent nodes for reasoning, implementation, and review. The native
wrappers still invoke local CLIs internally; the benefit is predictable
configuration and structured outputs, not an assumption of zero process cost.

Keep execution boundaries explicit. Do not hide supported Git operations,
decisions, or approvals inside agent prompts to reduce node count. Preserve
user restrictions, review counts, provider/model choices, and bounded loops.
Use engine retries for simple transient retries; documented unsupported polling
may use bounded shell commands. Git push remains an explicit Command because
it is absent from GitOp. Never invent unsupported operations or MCP contracts.

Explain necessary fallback commands and direct AI CLI/profile bypasses in the
preview. Retain supported operations and config in compilation and perform
normal validation/risk analysis. Prompt changes guide model behavior; they do
not prove a real model will always choose an optimal graph. Acceptance never
runs a workflow.

## Acceptance and validation

- Round-trip every supported node type, config field, graph edge, role/profile
  reference, default, and input through developer JSON. Test malformed shapes,
  duplicate keys, dangling references, renamed keys, ambiguous profiles, raw
  import, and preservation of IDs/manual positions on ordinary edits.
- Test a 26-node chain, forks/merges, disconnected graphs, and bounded cycles
  for deterministic nonoverlapping placement in both directions. Inspect a
  representative long workflow visually at usable zoom.
- Test wizard recommendation values, both deep-review profiles, idempotence,
  unavailable adapters, and preservation of existing user configuration.
- Instantiate every template with role mappings; verify required test inputs,
  no hardcoded stack commands, no dropped gates, and portable export/import.
- Test independent repository memory, global fallback, explicit-goal precedence,
  accepted/suggested/rejected handling, observation evidence, persistence,
  validation, export/import/reset, and mock parity.
- Test unread/history filtering, visible action errors, exact older-run lookup,
  snapshot rendering after workflow edits, missing runs, and overlay clearing.
- Test prompt decision policy and supported operation preservation, including
  explicit CLI-only goals, Git push fallback, and multiple named reviewers.
- Run all AGENTS.md checks, version parity, delivery tests, and diff review.
  Perform self-review before commits. Document manual/model checks separately
  from deterministic automated verification.

Update CHANGELOG.md, implementation-plan notes, workflow/memory/agent/execution
docs, and any version references required by the existing version checker.
Update ROADMAP only for actual direction changes. Separate commits by coherent
feature and validation rather than splitting individual files arbitrarily.

## Review and implementation handoff

This is the written spec for user review. After approval, write the detailed
implementation plan using the writing-plans skill and obtain the user's chosen
execution method. No product implementation has started at this stage.
