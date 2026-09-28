# Changelog

All notable changes are recorded here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-28

First public beta. Installers will be published when the `v0.1.0` tag is pushed.

### Added

- Local desktop application for Linux and macOS, built with Tauri, React, and Rust.
- Visual workflows with Command, AI Agent, Git, GitHub, Jira Ticket, MCP Tool,
  Condition, Human Approval, Start, and End nodes.
- Parallel execution, joins, failure routing, bounded retries and guarded loops,
  workflow inputs, repository defaults, and per-node timeouts up to 12 hours.
- Claude Code, Codex, and custom CLI profiles with models, reasoning effort,
  optional skills, local discovery, and command previews.
- Goal-to-workflow generation grounded in an optional repository, using configured
  profiles and discovered MCP tools; editable previews, setup checklists, and
  repair guidance. Accepting a proposal never starts execution.
- Live per-node output, formatted reports, cancellation, durable human approvals,
  run history, and normalized review findings.
- Reusable built-in and user templates, JSON import/export, local preference memory,
  schedules, GitHub watchers, a notification inbox, and optional tray background mode.
- Setup wizard, tool detection, Jira MCP guidance, dark/light/system themes,
  accessible sidebar controls, and shared dialogs with keyboard focus handling.
- Contributor guides, security documentation, and a responsive project page with
  OS-aware downloads that appear when public release assets are available.
- PR checks and installer builds for Linux, Apple Silicon macOS, and Intel macOS;
  tagged releases with stable asset names, checksums, and version consistency checks.

### Fixed

- Verbose process output is drained while commands run and captured within limits;
  Unicode truncation preserves valid text.
- Custom CLI arguments precede the final prompt; browser previews include model,
  effort, skills, additional arguments, and referenced variables.
- Approval decisions are claimed atomically so repeated requests cannot restart
  the same paused work or decide a later gate; each run keeps its initial workflow definition, active
  workflows cannot be deleted, and run action errors are shown in the interface.
- Interval schedules and dirty-checkout settings use consistent camelCase
  fields across Rust and TypeScript, with compatibility for earlier saved data.
- Invalid schedule offsets and poisoned database locks report errors instead of
  panicking; run controls preserve cancellation during resumed execution.
- Test tooling is updated to the patched Vitest release; CI uses Node.js 22.
- Workflow generation preserves supported native operations and flags missing
  setup or unsupported actions rather than silently substituting them.
- Generator setup guidance matches the Jira MCP Cloud variables `JIRA_URL`,
  `JIRA_USERNAME`, and `JIRA_API_TOKEN`.
- Selected workflow nodes use a crisp outline and distinct kind colors; long
  generator explanations, run output, and history are expandable and scrollable.

### Known limitations

- macOS installers are unsigned and not notarized.
- Automation requires Orchevia to remain running; closing the window keeps it
  active only when background mode is enabled.
- Browser development uses a simulated backend and cannot run local CLIs.
- Skill discovery is metadata only; verify skill invocation with a small workflow.
- Commands are not sandboxed. CLI output is stored locally and can contain
  sensitive information; review logs before sharing them.

[Unreleased]: https://github.com/iazaran/orchevia/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/iazaran/orchevia/releases/tag/v0.1.0
