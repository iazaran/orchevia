# Workflow Usability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Ship the seven approved usability improvements as v0.1.6, preserving existing workflows and producing logical commits and one PR for the user to merge.

**Architecture:** Extend existing workflow conversion, layout, profile, preference, template, and run-snapshot paths. Rust owns document conversion, profile resolution, memory validation, and stored-run lookup; thin Tauri commands expose those operations through Backend with equivalent browser implementations. React uses the existing store and shared UI components.

**Tech Stack:** Rust/serde/SQLite/Tauri 2, React/TypeScript/Zustand/React Flow, Vitest and colocated Rust tests; no new dependencies.

**Spec:** [Approved design](../specs/2026-10-02-workflow-usability-design.md)

## Global Constraints

- Work on `improve-workflow-usability`; keep `main` at the fetched merged v0.1.5 commit.
- Target v0.1.6. Preserve runtime schema v6 and generation proposal v1 through additive changes.
- Follow AGENTS.md and CLAUDE.md; reuse Backend, NodeConfig, operation enums, preference/template storage, and shared UI components.
- Preserve profile customizations, manual node positions, run snapshots, explicit user instructions, native approval gates, and execution semantics.
- Every changed Backend method has an identical mock contract, including errors and persistence where the feature requires it.
- Add tests for every behavior change; run the complete required checks before completion.
- Commit coherent features separately, then push and create one PR. Attach the PR to this chat. Do not merge, tag, publish, or monitor after handoff.
- Use the current client date for the release changelog. Do not change historical changelog dates.

## Review Focus

1. Opaque or overlapping node IDs and literal strings resembling references must round-trip without losing config or rewriting unrelated text. Task 2 owns these tests.
2. A slow request for run A completing after the user opens run B must not replace B's graph or mark a failed navigation read. Task 4 owns these tests.
3. Two reviewers with the same role or duplicate display names must never resolve to the wrong provider silently. Tasks 1 and 7 own these tests.
4. A repository playbook must not leak into another repository or promote rejected/failed observations as accepted facts. Task 6 owns these tests.
5. Template test commands must remain required, preserve argument boundaries, and never become a successful no-op. Task 5 owns these tests.

## File map and order

1. `src/lib/agents.ts`, wizard, Rust agents/generation: recommended profiles and explicit profile-name resolution.
2. New focused `workflow_document` Rust module and TS mirror: lossless developer JSON, existing workflow editor and template I/O integration.
3. Existing workflow layout helper and canvas: dependency layout options and bounds.
4. Existing database/run commands/backend/store/inbox/canvas: exact immutable run navigation.
5. Existing templates: language-neutral required test commands.
6. Existing memory module/backend/views: project playbooks, observations, context, promotion, and browser persistence.
7. Existing generation prompt/compiler/preview: consistent native preference, all profile choices, memory context.
8. Version manifests, changelog, implementation note, area docs: release and final checks.

Each task is a separately testable change in the same release; the document,
profile, and memory interfaces below define the dependencies between them.
Before each task, read its affected implementation and colocated tests. Write
the regression tests first, run them and observe the relevant failure, then
implement and verify. Commit after self-review and focused checks pass.

---

### Task 1: Recommended profiles and exact profile resolution

**Files:** Modify `src/lib/agents.ts`, `src/lib/agents.test.ts`, `src/components/OnboardingWizard.tsx`, `crates/core/src/agents.rs`, `crates/core/src/generation.rs`, and `docs/agents.md`. Create `src/components/OnboardingWizard.test.tsx`.

**Interfaces:**

- TS `recommendedProfiles(existing: AgentProfile[]): AgentProfile[]` returns only missing adapter/role recommendations using `createDefaultProfile`.
- Rust `resolve_profile_name(name: &str, profiles: &[AgentProfile]) -> Result<String, String>` returns exactly one profile ID or an actionable error.
- Add `ProposalNodeConfig.profile_name: Option<String>` (JSON `profileName`) and `compile_proposal_with_profiles(proposal: &GenerationProposal, role_map: &HashMap<String, String>, workflow_id: &str, defaults: Option<WorkflowDefaults>, profiles: &[AgentProfile]) -> Result<CompiledPreview, String>`; retain the existing `compile_proposal` wrapper for callers without named selections. `CompiledPreview` is the existing generation result type.

- [x] Write `recommended_profiles_match_user_configuration`: six recommendations, five Claude and one Codex, models `opus/opus/fable/fable/fable/gpt-6.1-sol`, high effort, 3600 seconds, node working directory, empty skills. Write idempotence and preserve-custom-profile cases.

```typescript
it('recommended_profiles_match_user_configuration', () => {
  const profiles = recommendedProfiles([]);
  expect(profiles.map((p) => p.model)).toEqual([
    'opus',
    'opus',
    'fable',
    'fable',
    'fable',
    'gpt-6.1-sol',
  ]);
  expect(profiles.filter((p) => p.role === 'deepReview')).toHaveLength(2);
  expect(
    profiles.every((p) => p.effort === 'high' && p.defaultTimeoutSecs === 3600),
  ).toBe(true);
  expect(recommendedProfiles(profiles)).toEqual([]);
});
```

- [x] Write Rust `named_profiles_resolve_uniquely` and compiler cases: select Claude and Codex deep reviewers independently; missing/duplicate names fail; role-only proposals retain existing behavior.
- [x] Run `pnpm exec vitest run src/lib/agents.test.ts src/components/OnboardingWizard.test.tsx` and `cargo test -p orchevia-core named_profile`; confirm failures concern the missing feature.
- [x] Implement the interfaces, seed missing recommendations by adapter and role, and preserve absent-CLI availability display. Resolve a supplied profile name before the role fallback; persist the chosen role/profile ID in existing NodeConfig, without adding a new runtime field.
- [x] Run the focused tests and `cargo test -p orchevia-core generation::tests`; update agent documentation and self-review provider selection.
- [x] Commit as `Improve recommended agent profiles`.

### Task 2: Lossless developer JSON

**Files:** Create `crates/core/src/workflow_document.rs`, `src/lib/workflow-document.ts`, `src/lib/workflow-document.test.ts`, and `src/components/WorkflowsView.test.tsx`. Modify Rust `lib.rs`, templates, Tauri commands/main, TS backend/tests, generation types, WorkflowsView, TemplatesView, and `docs/workflow-schema.md`.

**Interfaces:**

- `DeveloperWorkflow { version: 1, name, nodes, edges, inputs?, defaults? }`; `DeveloperNode { key, type, label?, role?, profileName?, config }`; `DeveloperEdge { from, to, label? }`.
- Rust DeveloperNode config reuses NodeConfig after stripping `agent_profile_id`/`agent_role`; TS uses `Omit<NodeConfig, 'agentProfileId' | 'agentRole'>`. Selection lives in the node's role/profileName fields. Every other existing config field survives conversion.
- `DocumentSession { json: String, node_ids: HashMap<String, String> }` (TS `json`, `nodeIds`) contains hidden editor context, not exported JSON.
- Rust `export_document(workflow: &Workflow, profiles: &[AgentProfile]) -> Result<DocumentSession, String>` and `import_document(json: &str, base: Option<&Workflow>, node_ids: &HashMap<String, String>, profiles: &[AgentProfile], role_map: &HashMap<String, String>, workflow_id: &str) -> Result<Workflow, String>`.
- Backend `encodeWorkflowDocument(workflow: Workflow): Promise<DocumentSession>` and `decodeWorkflowDocument(json: string, base?: Workflow, nodeIds?: Record<string, string>): Promise<Workflow>`. Add `encode_workflow_document`/`decode_workflow_document` Tauri commands and register them.
- Template import accepts existing runtime envelopes plus developer envelopes; export uses the same converter with role references, retaining template metadata and avoiding machine IDs. Existing Template storage remains unchanged.

- [x] Write Rust `developer_document_round_trips_all_config` with every node kind and every NodeConfig field, role plus exact profile selection, condition operands, operation strings, MCP arguments, inputs/defaults, and two similarly named nodes.
- [x] Assert exported JSON has no `position`, workflow `id`, edge `id`, `agentProfileId`, or opaque node IDs. Assert decoding with base/session preserves workflow/node/edge IDs, config, and manual positions.
- [x] Write malformed/duplicate key, dangling edge/reference, key-rename, raw legacy import, unknown config field, literal-text, and ambiguous profile cases. Preserve semantic-invalid documents for the existing validation/save-anyway flow; reject invalid shape and reference mappings without truncation or silent drops.
- [x] Run `cargo test -p orchevia-core workflow_document` and the TS document tests; confirm expected failures.
- [x] Implement conversion with collision-free aliases. Rewrite only recognized node-reference tokens and inputRefs, including bare condition operands; match longest identifiers first and preserve unrelated strings. Derive aliases for opaque IDs from labels with numeric suffixes, map stable keys to base IDs, and allocate only added nodes/edges. Added-node positions use free space beyond occupied base bounds.
- [x] Mirror conversion in the mock backend using the focused TS module. Make Simple the default editor mode with an Advanced raw toggle. Keep asynchronous conversion/save errors visible in the modal and retain unsaved text. Run backend semantic validation before saving.
- [x] Extend existing template import/export around the converter, preserving all metadata and old file support. Test cloned-template edits and export/import round-trips.
- [x] Run `cargo test -p orchevia-core workflow_document`, `cargo test -p orchevia-core templates::tests`, and `pnpm exec vitest run src/lib/workflow-document.test.ts src/lib/backend.test.ts src/components/WorkflowsView.test.tsx`; document format examples and self-review all fields against NodeConfig.
- [x] Commit as `Add simple workflow JSON editing`.

### Task 3: Dependency layout with explicit direction

**Files:** Modify `src/lib/workflow.ts`, `src/lib/workflow.test.ts`, `src/components/WorkflowCanvas.tsx`, `src/components/FlowNode.tsx`, `src/styles.css`, and workflow documentation. Create `src/components/WorkflowCanvas.test.tsx`.

**Interfaces:**

- Add `LayoutOptions { direction?: 'vertical' | 'horizontal'; sizes?: Record<string, { width: number; height: number }> }` as the optional third argument of `arrangeWorkflowPositions`; return type remains `Record<string, Position>`.
- `WorkflowCanvas` retains its workflow prop; Task 4 later adds `readOnly?: boolean`.

- [x] Add layout tests for a 26-node serial chain (default increasing y), horizontal option (increasing x), forks/merges, SCC review loops, islands, missing edge endpoints, unequal measured heights, and determinism. Compare rectangles for nonoverlap instead of pinning incidental coordinates.

```typescript
it('arranges_a_long_chain_vertically_by_default', () => {
  const nodes = Array.from({ length: 26 }, (_, i) => ({ id: `step-${String(i)}` }));
  const edges = nodes.slice(1).map((node, i) => ({
    source: nodes[i]?.id ?? '',
    target: node.id,
  }));
  const positions = arrangeWorkflowPositions(nodes, edges);
  expect(Object.keys(positions)).toHaveLength(26);
  expect(positions['step-25']?.y).toBeGreaterThan(positions['step-0']?.y ?? 0);
  expect(positions['step-25']?.x).toBe(positions['step-0']?.x);
});
```

- [x] Run `pnpm exec vitest run src/lib/workflow.test.ts` and confirm the serial/direction cases fail.
- [x] Compute SCCs, rank the resulting DAG, use deterministic predecessor ordering for branch lanes, and allocate component/group bounds before placing nodes. Keep cyclic members in a readable local lane with loop space. Use conservative bounds when measured sizes are absent.
- [x] Add a labeled direction control beside Arrange. Pass measured sizes, apply positions, then fit the viewport after React Flow has committed them. Keep existing manual positions until an explicit arrangement action. Align handles with the chosen display direction without changing saved edge semantics.
- [x] Test Arrange does not change configs or edges; test fit follows state application and changing the direction control alone does not rearrange nodes.
- [x] Run focused tests, inspect a long-chain/branch/review-loop canvas in the browser, document the choices, and self-review.
- [x] Commit as `Improve workflow graph arrangement`.

### Task 4: Unread inbox and exact run graph

**Files:** Modify Rust db/tests, Tauri commands/main, TS Backend/tests, store, InboxView, RunsView/tests, WorkflowsView, WorkflowCanvas, NodeInspector, and `docs/execution.md`. Create `src/store.test.ts` and `src/components/InboxView.test.tsx`.

**Interfaces:**

- Backend `getRun(runId: string): Promise<StoredRun | null>` and `getRunWorkflow(runId: string): Promise<Workflow | null>`; Rust SqliteDb `get_run(id: &str) -> DbResult<Option<StoredRun>>` plus existing `get_run_workflow`.
- Register `get_run` and `get_run_workflow` commands. No database migration is needed.
- Store `overlayWorkflow: Workflow | null` and `openRunOnCanvas(runId: string): Promise<void>`; keep `showRunOverlay` as a compatible wrapper or migrate all callers in the same task.
- `WorkflowCanvas({ workflow, readOnly = false })` disables every graph mutation in run mode; NodeInspector/run toolbar render read-only information and an explicit return-to-workflow action.

- [x] Add DB/mock tests for lookup beyond the list limit, immutable snapshot after saved workflow edits, legacy definition fallback, and missing run IDs.
- [x] Add store/navigation tests: run B wins over a slow A request, failed lookup does not change the displayed graph, selecting another workflow clears the overlay, overlay refresh updates only the active run.
- [x] Add inbox tests: unread default; mark read disappears; history shows it; all-read shows the empty state; Open run calls the exact navigation action and marks read only after success; rejected actions display errorMessage via Notice and leave unread state unchanged.
- [x] Run the focused Rust/TS tests and confirm failures.
- [x] Implement direct lookups and atomic guarded navigation. Fetch run metadata, snapshot, and results before committing the navigation state. Use a request sequence guard for stale completions. Render the snapshot without replacing or saving the editable workflow definition.
- [x] Route Inbox Open run and Runs Show on canvas through the same action. Offer read history, pending action states, and visible errors. Disable add/delete/duplicate/drag/connect/arrange, JSON/save/run/template mutations in overlay mode; retain node-result inspection and live output.
- [x] Run `cargo test -p orchevia-core db::tests`, `pnpm exec vitest run src/store.test.ts src/lib/backend.test.ts src/components/InboxView.test.tsx src/components/RunsView.test.tsx src/components/WorkflowCanvas.test.tsx`; self-review every mutation handler.
- [x] Commit as `Open exact run graphs from inbox`.

### Task 5: Language-neutral templates

**Files:** Modify `crates/core/src/templates.rs`, template/engine tests, `src/lib/backend.ts`, `src/lib/backend.test.ts`, `src/components/TemplatesView.tsx`, `docs/memory.md`, and workflow documentation. Create `src/lib/templates.ts` and `src/lib/templates.test.ts` for the browser equivalents of the existing built-ins and role instantiation.

**Interfaces:** Existing template constructors/instantiate contract. Add private `test_command(id: &str, y: f64) -> Node` and required workflow input `testCommand` only to templates with test steps. TS `builtinTemplates(): WorkflowTemplate[]` mirrors the nine core definitions; `instantiateTemplateLocal(template: WorkflowTemplate, roleMap: Record<string, string>): InstantiationPreview` mirrors role resolution, fresh IDs, setup-needed classification, and blocking errors.

- [x] Add `builtin_test_steps_use_required_command_input`: for every template with tests, assert executable `sh`, args `['-c', '{{input.testCommand}}']`, a declared required input with no default, and no language-specific executable/path. Assert all nine templates retain their purposes, role references, gates, and setup notices.
- [x] Add an engine fixture proving a supplied compound test command remains one shell argument and a blank required command is rejected before run start. Test validation-failure propagation rather than a mocked success.
- [x] Run `cargo test -p orchevia-core templates::tests` and the new engine case; confirm failures.
- [x] Replace repeated cargo commands with the helper, add required inputs without duplication, and shorten prompts to repository-informed instructions. Expose command setup clearly in template preview. Preserve native Git/GitHub/Ticket nodes.
- [x] Implement the existing mock template list/save/export/import/instantiate methods with equivalent validation and persistence, reusing Task 2's document converter. Test all nine browser templates against the same purpose, role, operation, gate, and input expectations as core; test missing role and missing local setup separately.
- [x] Run `cargo test -p orchevia-core templates::tests` and `cargo test -p orchevia-core engine::tests`; update docs and self-review export/import via Task 2.
- [x] Commit as `Make built-in templates language neutral`.

### Task 6: Editable project playbooks and observed suggestions

**Files:** Modify Rust memory/db/tests, Tauri commands/main, TS backend/tests, generation types, MemoryView, WorkflowsView, RunsView, NodeInspector, AgentsView, and docs/memory.md. Create `src/lib/memory.ts`, `src/lib/memory.test.ts`, and `src/components/MemoryView.test.tsx`.

**Interfaces:**

- `ProjectMemoryContext { scope: string; preferences: Preference[]; text: string }`.
- Backend `getProjectMemoryContext(repoDir?: string): Promise<ProjectMemoryContext>` and `saveProjectPreference(repoDir: string, field: string, value: Preference['value'], note: string): Promise<Preference>`; register corresponding snake_case Tauri commands.
- Allowed project fields: `testCommand`, `lintCommand`, `buildCommand`, `conventions`, `fastReviewProfile`, `deepReviewProfile`, `templateId`. Use manual source for explicit saves.
- Rust `project_scope(repo_dir: &str) -> Result<String, String>` canonicalizes existing directories; `project_key(scope: &str, field: &str) -> Result<String, String>` produces `project.<16-hex-FNV1a64-of-scope>.<field>`. Mirror the hash in TS. Reject any stored-key collision with a different scope rather than overwriting it.
- Rust `validate_preference(preference: &Preference) -> Result<(), String>` is shared by manual save/import/observation; `project_context(preferences: &[Preference], scope: Option<&str>) -> ProjectMemoryContext` includes only enabled manual/accepted applicable fields and global preferences.
- Rust SqliteDb `import_preferences(preferences: &[Preference]) -> DbResult<usize>` validates before writing and uses one transaction; existing memory import delegates to it. TS mock validates every record before modifying stored preferences.
- Existing `observeEdits` records scoped changes using the same namespaced keys. The threshold remains three. Existing template APIs store reusable graphs; memory stores only template references.

- [x] Write tests for repository isolation, stable namespace/hash parity, global applicability, disabled/pending/rejected exclusions, malformed scopes/fields, length bounds (key 120, scope 600, command/conventions/note 4000 each), credential rejection, and collision refusal.
- [x] Write suggestion tests: three consistent concrete edits produce one pending suggestion with evidence; rejected keys are not suggested again; learning disabled stays quiet; profile choices and commands remain distinct across projects.
- [x] Test the global deep-review selector: an explicitly accepted default referencing an existing profile overrides first-profile-by-role fallback; a stale profile reference is ignored; an explicit node profile always wins. Update memory role application and role_map_for_db together without changing node selection precedence.
- [x] Write mock persistence/export/import/reset tests; reconstruct the backend and confirm preferences survive. Assert invalid imports are rejected before any partial write.
- [x] Add UI tests for guided fields, explicit editing, acceptance/rejection/disable/delete, relevant generator context, saving a user-template reference, and a successful-run promotion. Failed runs cannot promote a command as verified.
- [x] Run focused memory/backend/view tests and confirm relevant failures.
- [x] Implement validators and canonical scoped operations using existing preference/observation tables. Browser operations normalize syntactic paths and use the same namespace algorithm; no browser filesystem access. Reuse guarded storage helpers.
- [x] Make the existing mock memory methods functional. Add guided repository fields to Memory, preserve generation history and generic preference controls, show evidence and pending suggestions, and observe changed command/profile settings after successful saves.
- [x] Add the global deep-review default selector and apply its accepted, valid profile choice before first-profile fallback in role_map_for_db. Keep explicit per-node profile choices authoritative and ignore stale references.
- [x] Let users explicitly promote a successful run's Command into the matching playbook field; use only its saved command and success record, with an evidence note naming the run. Do not copy stdout/stderr or infer replacements from failed runs. Reuse Save as template for reusable graph capture and save its reference through the project preference API.
- [x] Display applicable context in the generator via getProjectMemoryContext, with loading/error states. Keep scope selection explicit and derived from the chosen repository.
- [x] Run `cargo test -p orchevia-core memory::tests`, `cargo test -p orchevia-core db::`, and `pnpm exec vitest run src/lib/memory.test.ts src/lib/backend.test.ts src/components/MemoryView.test.tsx`; self-review data provenance and update memory docs.
- [x] Commit as `Add project playbooks to memory`.

### Task 7: Consistent native-first generation

**Files:** Modify Rust generation/tests and Tauri generation command, TS generation helpers/tests, WorkflowsView/tests, and implementation-plan/generation-fidelity.md.

**Interfaces:** Consume Task 1's named-profile compiler and Task 6's `ProjectMemoryContext`. Keep `build_generator_prompt` signature; append applicable playbook and all profile choices to its existing data-only profile_context argument.

- [x] Add prompt cases for native Git/GitHub/Ticket/MCP/Condition/Approval operations, deterministic tests, supported transient retries, explicitly CLI-only goals, unsupported Git push/polling fallback, and exact named reviewers with duplicate roles.
- [x] Assert contradictory repository instructions about merging supported operations into agents or forcing retries into shell loops are absent. Assert explicit user instructions outrank remembered data and no pending/rejected preference is included.
- [x] Run `cargo test -p orchevia-core generation::tests` and TS generation tests; confirm the new cases fail.
- [x] Unify general/repository decision guidance. Enumerate all relevant profile names/providers/models plus the default role map. Use compile_proposal_with_profiles in the Tauri generation path. Include playbook values as labeled data, bounded in size, and require rechecking commands against repository evidence.
- [x] Surface fallback and direct-AI-CLI bypass reasons through existing preview warnings/steps/explanation; preserve supported operations, requested boundaries, review counts, bounded loops, and acceptance-without-execution behavior.
- [x] Run focused generation/compiler/preview tests and inspect representative native, ticket, review-loop, and explicitly CLI-only draft previews. If a live local model check is unavailable, document that limit instead of claiming it passed.
- [x] Commit as `Prefer native workflow operations in generation`.

### Task 8: Version, release documentation, and whole-branch review

**Files:** Modify package.json, crates/core/Cargo.toml, src-tauri/Cargo.toml, src-tauri/tauri.conf.json, Cargo.lock (only the two application packages), CHANGELOG.md, relevant docs, and README version references if required. Create implementation-plan/workflow-usability.md. Update ROADMAP only if the shipped direction changes.

- [x] Record completed behavior, compatibility, remaining manual verification limits, and a dated v0.1.6 changelog entry. Preserve historical release links and installer claims; do not claim new assets exist before publication.
- [x] Bump the five application-version files checked by scripts/check-version.mjs to `0.1.6`, including both application entries in Cargo.lock; preserve unrelated lockfile/dependency versions.
- [x] Run `pnpm check`, `cargo test -p orchevia-core`, `cargo clippy -p orchevia-core --all-targets -- -D warnings`, `cargo fmt --check`, and `cargo check -p orchevia`. Run Rust checks sequentially to avoid build-lock contention; frontend validation can run independently. Use elevated execution only for environment restrictions such as the temporary Git fixture.
- [x] Run `pnpm build`, `pnpm version:check`, and `git diff --check`. Inspect representative desktop/browser layouts, simple/raw JSON, template setup, memory, and exact-run navigation; document what was and was not observed.
- [ ] Review the entire branch against every acceptance item in the spec, including API/mock parity, snapshot immutability, reference remapping, typed validation, loading/error/empty states, and destructive confirmations. Fix findings and rerun only the checks affected by fixes before the final required gate if needed.
- [x] Commit release files as `Prepare v0.1.6`. Mark completed plan checkboxes and record validation evidence in the implementation note.
- [ ] Push `improve-workflow-usability`, create one PR against `main` with a short neutral description of the seven shipped changes and validation, then call attach_artifact with its URL.
- [ ] Return the PR link, version, logical commit count, validation result, and material remaining limitations. Stop before merge and do not watch CI/PR progress.

## Execution handoff

The plan has been checked against every section of the approved spec. The user
must review this written plan and choose the execution method before product
implementation, as required by the writing-plans skill. Native implementation
is recommended because JSON/profile/memory contracts are shared across several
tasks and keeping their integration in one implementer reduces repeated context.
If the user chooses Native, use executing-plans; if they choose Subagent-driven,
use subagent-driven-development. Do not dispatch agents before that choice.
