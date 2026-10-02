# Workflow usability — v0.1.6

Implemented from the [approved design](../docs/superpowers/specs/2026-10-02-workflow-usability-design.md) and [implementation plan](../docs/superpowers/plans/2026-10-02-workflow-usability.md).

## Behavior

- Simple workflow JSON uses readable keys and connections, with configuration intact. Internal IDs and manual positions survive editing through the editor session; Advanced JSON remains available. Template sharing uses the same document conversion.
- Arrange follows dependencies vertically by default, supports horizontal layouts, branches and guarded cycles, and reserves measured node bounds. Large graphs focus the first six steps at readable zoom; pan, minimap and full Fit View remain available. External JSON additions, removals and position changes reconcile with the canvas.
- Wizard recommendations preserve existing profiles and add missing adapter/role combinations. Claude implementation and fast review use opus; planning, workflow generation and deep review use fable; Codex deep review uses gpt-6.1-sol. All use high effort, 3600 seconds and per-node working directories. Exact profile names resolve uniquely before role defaults.
- All nine built-in templates preserve their purpose and native operations. Test steps require the project's testCommand input rather than assuming a language/toolchain. Command arguments interpolate independently so compound shell scripts retain their argument boundaries.
- Project playbooks store test/lint/build commands, conventions, preferred reviewer names and a reusable template reference. Values are scoped, editable and evidence annotated. Three consistent saved command edits can suggest knowledge; users accept or reject it. Successful runs can explicitly promote their saved command without copying process logs. Generator context excludes disabled, pending and rejected values, and global role defaults ignore stale profile references.
- Inbox shows unread notifications with optional read history. Successful exact-run navigation marks the notification read. Runs of every status open their immutable saved graph, with node results and mutation controls disabled; request guards prevent stale navigation or refresh overwrites.
- Generation prefers native deterministic operations, conditions, retries and approval gates. Unsupported operations and test/build commands retain explicit CLI fallbacks. Profiles and applicable playbook values ground drafts; explicit user instructions remain authoritative and preview acceptance never runs a workflow.

## Compatibility

Runtime workflow schema stays v6; proposal schema stays v1. New APIs are thin Tauri commands over core with browser mock counterparts. Canonical GitHub node spelling is `github`, with legacy `gitHub` accepted by Rust. Existing workflows, profile customizations, generation history and saved run snapshots remain supported. No dependencies or new storage tables were added.

Application manifests and the two application Cargo.lock entries are 0.1.6. README source version is 0.1.6; installer links remain on published v0.1.5. This PR does not tag or publish release assets.

## Verification

All local gates passed before independent review: 140 frontend tests, 15 delivery tests and 271 core tests. Required gates: pnpm check; cargo test -p orchevia-core; cargo clippy -p orchevia-core --all-targets -- -D warnings; cargo fmt --check; cargo check -p orchevia. Additional gates: pnpm build, pnpm version:check and git diff --check. Focused tests accompanied each feature, including reference round trips, snapshot navigation races, required command arguments, scoped memory validation and explicit profile precedence.

Browser QA at 1920 × 1080 used the local mock backend: a 26-node JSON graph, vertical and horizontal arrangement with readable viewport, project playbook save/evidence, all nine template setup cards, completed-run snapshot navigation with disabled mutation controls, and inbox empty/history states. QA exposed and fixed external canvas synchronization, cancelled Arrange fitting and finished-run canvas navigation. Native desktop compilation is checked; native GUI execution, live local-model generation and installer packaging are not manually exercised. The browser mock does not spawn processes. The build retains its existing large-chunk warning.

## Implementation decisions

- Reuse the approved feature checkout; a separate worktree adds no isolation beyond the requested branch here. Cost if wrong: another task using this checkout could interfere.
- Canonicalize GitHub JSON to the TypeScript `github` contract while keeping Rust's legacy read alias. Cost if wrong: legacy spelling requires normalization by an importer.
- Reuse existing direct-ID SqliteDb::get_run. Cost if wrong: future changes to that shared method affect navigation.
- Mirror Rust built-in template constructors through a checked-in fixture and a parity test. Cost if wrong: constructor edits require fixture regeneration.
- Reuse document reference remapping when cloning templates. Cost if wrong: clones could point at the wrong node; regression coverage checks references.
- Render each Command argument and trim required inputs. Cost if wrong: literal recognized tokens need the existing escape syntax; tests cover argument boundaries.
- Centralize valid global role-default precedence in core memory. Cost if wrong: an incorrect default could choose the wrong reviewer; explicit node selections win and tests cover stale IDs.
- Observe command edits through saveActiveWorkflow. Cost if wrong: command labels can misclassify a pending suggestion; acceptance remains explicit.
- Focus the first six dependency positions for long Arrange views. Cost if wrong: users must pan or use the minimap for later steps.
- Finish independent review before push/PR. Cost if wrong: additional fix commits precede publication.

- Allocate unique IDs for every template instantiation using existing helpers. Cost if wrong: clone identity changes; repeat-use and reference tests cover it.
- Pin installer documentation tests to verified published v0.1.5 while checking source v0.1.6 separately. Cost if wrong: advance the installer test pin when release assets are verified.

## Independent review fixes

The fresh reviewer identified seven Important findings and one Minor. The JSON-save learning gap was regraded Important because JSON editing is a primary approved workflow. All eight enter one fix pass, with regressions observed failing before implementation: effective required-command overrides; whitespace and opaque MCP references; malformed browser shapes; legacy kind normalization; cancelled same-run navigation; working-directory observations; and JSON-save observations. Native shape tests pin browser/core expectations. A further runtime-contract test preserves condition right operands as literals.

- Keep Windows canonical-path handling outside this release because Windows is unsupported. Cost if wrong: a future Windows port needs extended-path normalization before playbooks work.
- Preserve condition right operands as literals, following the existing evaluator rather than the review suggestion to rewrite both sides. Cost if wrong: future right-side variable support requires an explicit converter update.

After the fix pass all gates passed: 150 frontend tests, 15 delivery tests and 276 core tests, Clippy with warnings denied, Rust formatting, desktop compilation, production build, version parity and whitespace checks. An initial core pass hit a temporary gh fixture Text file busy failure; its focused tests and the complete rerun passed without rule changes.

No deferred minor findings remain. Live AI/native GUI and packaging limits remain as stated above.
