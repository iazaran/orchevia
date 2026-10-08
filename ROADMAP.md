# Roadmap

Orchevia focuses on repeatable developer workflows using local CLI agents and
integrations. The 0.1.x beta line focuses on reliable orchestration, readable
workflow authoring and practical adoption. The repository and downloads remain
private while public access is prepared.

## Implemented

| Area            | Current capabilities                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| Workflow editor | Autosaved graph editing, dependency-aware layout, reviewable workflow assistance, JSON, run overlays                  |
| Agent profiles  | Claude Code, Codex, custom CLI, model and effort settings, optional skills, command previews                          |
| Execution       | Parallel paths/joins, bounded loops/retries, approvals, dry-run fixtures, deliberate failed-run recovery, spend guard |
| Integrations    | Native Git and GitHub operations, Jira tickets through MCP, generic MCP tools, CLI fallback                           |
| Reuse           | Built-in/user templates, direct workflow JSON import, project playbooks, reviewed suggestions, generation history     |
| Automation      | Bounded local schedules/watchers, requested-review scope, revision tracking, check outcomes, inbox, background mode   |
| Onboarding      | Tool detection, setup wizard, install/auth guidance, system/light/dark themes                                         |
| Delivery        | Gated PR/main validation, tag-driven Linux/macOS installers, checksums, private-beta project page                     |

## Current priorities

1. Verify installer smoke tests on supported systems and prepare public access.
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

## Product boundaries

- Orchevia orchestrates tools; it does not provide AI models or manage provider accounts.
- Execution and scheduling remain local. There is no hosted worker or telemetry service.
- The focus is developer workflows rather than general business automation.
- Linux x86_64 and macOS Apple Silicon/Intel are the initial targets. Windows is not
  currently supported.
- Git and GitHub tasks belong in workflows; a separate file-browser Git client is
  outside the current scope.
