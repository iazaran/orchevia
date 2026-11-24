# Orchevia 0.3.0

Give developers a clearer way to set up local agents and MCP tools, reuse project
knowledge, and follow what changed in a review loop.

## Implementation and handoff

- [x] [Issue #55](https://github.com/iazaran/orchevia/issues/55): derive review
  visits from successful stored Agent results. Use reviewer step, file and
  normalized title to match, with location to distinguish repeated titles.
  Preserve exact grouping for current findings and the existing severity gate.
  Include visit history, disposition and severity changes in Runs, compare the
  same fixtures in Rust and TypeScript, and summarize in actionable notifications.
  Document opt-in fixer and reconciliation patterns with existing nodes.
- [x] Runs: give history and selected-run details independent keyboard-scrollable
  regions, including at narrow window sizes.
- [x] Project playbooks: lead with repository selection and saved project
  knowledge. Keep reviewed suggestions, global defaults, JSON and generation
  history available. Retain existing storage and scope checks.
- [x] Agents: add Muse Code, Google Antigravity CLI, Gemini CLI and OpenCode using
  the existing executable discovery, profile, preview and setup-check paths.
  Confirm supported invocation flags against provider docs and keep advanced
  capabilities scoped to providers that implement them.
- [x] Environment and setup wizard: surface the new agents, reuse the existing
  stdio MCP server editor and check for Slack, AWS Knowledge, Docs and Gmail recipes. Provider credentials stay outside the Orchevia configuration.
- [x] Templates: show a dry run that teaches the workflow controls, and update
  the developer starters to explain review rounds, approval and live feedback.
- [x] README, changelog and project site: show a first-run path, current release
  capabilities and permanent installer links. Update area docs and version files.
- [x] Self-review the diff against `main` and get a full Claude Fable review.
- [x] Get a targeted Fable review of the final generation and template changes.
- [x] Confirm the final checks before opening the PR. The maintainer owns PR CI
  follow-up, merge and release.

## Resume here

Branch `release/v0.3.0` started at `ea50dd2f` in the main checkout. The 0.2.0
application versions matched at baseline. This checklist is updated with each
completed slice.

- Browser preview: created First Workflow without a repository, ran it in dry-run
  mode and approved it. At 810 × 620 with four runs, keyboard scrolling moved
  the history and the details pane independently.
- Adapter and MCP setup use provider documentation and local fixtures. Live
  sign-in and tool calls for the new providers require the user's own setup.
- The AWS Knowledge recipe started FastMCP 4.2.5 and listed five public tools
  over stdio without AWS credentials.
- Claude Fable 5.2 found two P1s in the first review. The renamed-reviewer test
  was updated, and built-in templates and samples now use a fresh session when an
  adapter cannot resume. User-authored session settings still validate normally.
- Desktop custom model storage now uses the adapter registry. The notification
  explains what its round counts include. Oversized argv prompts get an actionable
  error. Slack checks credential presence, Playbooks distinguishes disabled records,
  and UI labels now use the new view and CLI names.
- OpenCode 1.18.31 was checked locally with `run --help`. The new adapters' test
  contracts use the provider docs. Authenticated setup and end-to-end use of the
  new CLIs are covered by the manual rows in the desktop smoke-test guide.
- Fable 5.2 confirmed both original blockers were fixed. Its follow-up surfaced
  the same session constraint for generated workflows. The compiler now uses
  fresh sessions for affected steps when generating a new workflow, and accepting
  a draft does the same for newly created profiles. Existing workflow assistance
  retains saved session settings. Template fixers retain the original ticket or
  PR feedback as a handoff. The review-loop sample lists affected steps, and the
  prompt limit error distinguishes prompt bytes from the context character setting.
- The Playbooks picker deduplicates trailing slashes. Resolving additional aliases
  would need filesystem-aware handling for symlinks and platform paths.
- The final targeted Fable 5.2 review found no blockers. Optional unset session
  fields are omitted from the desktop payload. Run validation reports unsupported
  session settings explicitly if they are authored through existing-workflow assistance.
- Final checks passed: `pnpm check` (641 UI and 44 delivery tests), `pnpm build`,
  core tests (597 passed, three opt-in canaries ignored), strict core Clippy,
  Rust formatting and the desktop shell check. Vite reported a bundle size warning
  and the desktop shell check reported warnings in vendored GLib.
