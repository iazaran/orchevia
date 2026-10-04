# Developer quality release — v0.1.7

## Intent and scope

Make existing developer workflows more dependable and easier to adopt. Keep the
Tauri/core/typed Backend boundaries and runtime schema v6. This is a beta
maintenance release, not a new subsystem or a v0.2.0 architecture change.

## Audit findings and implementation tasks

- [x] Share AppState's cancellation registry with scheduled/watcher runs and test
  cancellation through the same starter used at app boot, retaining partial output.
- [x] Replace unsupported `gh pr checks` JSON fields with the documented `bucket`
  and `state` fields, normalize the existing result contract, and test failed,
  pending, passing and CLI-error responses.
- [x] Persist unreachable-node skips before scheduling; preserve warnings, joins,
  and approval replay without duplicate results.
- [x] Bind newly created Agent Profiles to generated nodes before saving.
- [x] Preserve newer unsaved edits and navigation when an older save returns;
  serialize saves for a workflow so older persistence cannot win.
- [x] Scope run-input values and review state to the active workflow.
- [x] Expand the static site with practical examples, benefits, authoring, memory,
  setup and limitations; add a getting-started guide and executable JSON example.
- [x] Replace historical release handoffs in the development guide with a durable
  merge → tag → verify procedure. Align v0.1.7 manifests, changelog and permanent
  installer links; keep private downloads off the public Pages site.
- [x] Run all AGENTS.md checks, production build, desktop tests, documentation and
  delivery tests. Self-review and independently review the final diff before push.

- [x] Parse Git tracking counts using the existing status contract and a real
  divergent-repository regression.
- [x] Preserve watcher feedback through failed polling/starts with a successful
  watermark in the existing settings store; no schema change.

## Verification and review

All required checks passed on the final implementation: `pnpm check` (158 UI
unit tests and 15 delivery tests), `pnpm build`, 282 core tests, Clippy with
warnings denied, Rust formatting, desktop compilation and 3 desktop tests.
Documentation checks validate site links and the executable getting-started JSON.
The static site was inspected at narrow and desktop widths without horizontal
overflow. Git diff whitespace checks and manifest/version checks passed.

Independent review exposed an approval-resume regression when an unreachable
chain feeds a reachable join. A failing regression and independent reproduction
confirmed it; replay now resolves each skipped edge once, and both checks pass.
One existing GitHub authentication fixture failed transiently during a full run;
it passed unchanged in isolation and the subsequent complete suite passed.

Real desktop interactions, live CLI generation and installation on Linux/macOS
architectures were not manually exercised. Release packaging and v0.1.7 assets
must be verified after tagging. Process cancellation currently kills the direct
child; portable cleanup of detached descendants remains a future design task.

## Sources and consistency rules

Use the existing cancellation registry, EngineStarter, generation compiler,
workflow state and mock backend. Keep TypeScript exact optional properties and
checked indexing; use request identity/cleanup to prevent stale async writes.
Keep core failures explicit and process cancellation compatible with retained
output. No dependencies or language/framework migrations are needed.

Official references checked for this release:

- [React effect cleanup and stale responses](https://react.dev/reference/react/useEffect#fetching-data-with-effects)
- [TypeScript exact optional properties](https://www.typescriptlang.org/tsconfig/exactOptionalPropertyTypes.html)
- [TypeScript checked indexing](https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html)
- [Rust child lifetime, kill and wait](https://doc.rust-lang.org/std/process/struct.Child.html)
- [GitHub CLI check fields and exit codes](https://cli.github.com/manual/gh_pr_checks)

## Review conclusions and future priorities

The product's advantage is inspectable orchestration of developers' existing
CLIs: portable workflows, human gates, independent review, native tool operations,
local run history and project knowledge. Improve those flows through real usage
before expanding the platform. Avoid claims of better model output than competitors.

Follow-up candidates require their own concrete use cases: an opt-in retry from a
failed step with explicit side-effect handling; clearer setup diagnostics for
profiles and MCP; a maintained real desktop smoke-test matrix; and portable
workflow recipes tested in multiple languages. Do not silently rerun write steps.

## Release follow-through

A merge deploys changed Pages content and runs main CI. The matching version tag
builds the permanent installers. Publication requires all four nonempty files and
SHA256SUMS; temporary Actions artifacts are not download guidance. Keep merge and
release publication distinct, verify actual assets, and report platform testing
limits. The maintainer retains ownership of merging and creating the release tag.
