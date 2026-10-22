# Roadmap

Orchevia focuses on repeatable developer workflows using local CLI agents and
integrations. The 0.1.x beta line focuses on reliable orchestration, readable
workflow authoring and practical adoption. Source, installers and the project page
are public.

## Implemented

| Area            | Current capabilities                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| Workflow editor | Autosaved graph editing, dependency-aware layout, reviewable workflow assistance, JSON, run overlays                  |
| Agent profiles  | Claude Code, Codex, custom CLI, model and effort settings, optional skills, tool permissions, command previews        |
| Execution       | Parallel paths/joins, bounded loops/retries, approvals, dry-run fixtures, deliberate failed-run recovery, spend guard |
| Integrations    | Native Git and GitHub operations, Jira tickets through MCP, generic MCP tools, CLI fallback                           |
| Reuse           | Built-in/user templates, direct workflow JSON import, project playbooks, reviewed suggestions, generation history     |
| Automation      | On-time local schedules/watchers, pause switches, requested-review scope, revision tracking, inbox, background mode   |
| Onboarding      | Tool detection, setup wizard, install/auth guidance, system/light/dark themes                                         |
| Delivery        | Gated validation, tag-driven Linux/macOS installers, checksums, in-app update notices, project page with demo         |

## Current priorities

1. Verify installer smoke tests on supported systems and respond quickly to first-user issues.
2. Use real workflow feedback to improve generation accuracy and setup guidance.
3. Improve run observability, failure recovery, accessibility, and interface consistency.
4. Keep documentation, CLI contracts, and installation guidance current.

These priorities improve existing capabilities. New features should follow a
concrete use case, fit the existing architecture, and include tests and documentation.

## Next improvements to validate with real use

- Clearer per-profile and MCP setup diagnostics, with small real-tool smoke tests.
- Workflow recipes exercised in different languages, using each project's test
  command and accepted project knowledge.
- Exercise dry-run fixtures, deliberate recovery and reported-spend guards against
  real project feedback; verify native parallel timing and provider-report coverage.
- Process-tree cleanup on real systems: cancel, timeout, MCP shutdown and app exit
  stop a CLI's process group on Linux and macOS (verified with automated tests on
  Linux). Verify with real CLIs that spawn MCP servers on both macOS architectures;
  tools that detach into their own session remain out of reach.
- A maintained desktop smoke-test matrix covering local generation, approvals,
  automation, restart recovery and all installer architectures.
- Installing updates in place: signed release metadata for the Tauri updater
  (AppImage, macOS) and an apt repository for the .deb, so `apt upgrade` picks up
  new versions. Until then the app announces new releases and links the installer.

## Product boundaries

- Orchevia orchestrates tools; it does not provide AI models or manage provider accounts.
- Execution and scheduling remain local. There is no hosted worker or telemetry service.
- The focus is developer workflows rather than general business automation.
- Linux x86_64 and macOS Apple Silicon/Intel are the initial targets. Windows is not
  currently supported.
- Git and GitHub tasks belong in workflows; a separate file-browser Git client is
  outside the current scope.
