# Roadmap

Orchevia focuses on repeatable developer workflows using local CLI agents and
integrations. The 0.1.x beta line focuses on reliable orchestration, readable
workflow authoring and practical adoption. Source, installers and the project page
are public.

## Implemented

| Area            | Current capabilities                                                                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow editor | Autosaved graph editing, dependency-aware layout, reviewable workflow assistance, JSON, run overlays, script-file Command steps                                                              |
| Agent profiles  | Claude Code, Codex, custom CLI, model and effort settings, optional skills, tool permissions, command previews, real setup check                                                             |
| Execution       | Parallel paths/joins, bounded and nested loops, retries, approvals, dry-run fixtures, deliberate failed-run recovery, spend guard                                                            |
| Integrations    | Native Git and GitHub operations, Jira tickets through MCP, generic MCP tools, CLI fallback                                                                                                  |
| Reuse           | Built-in/user templates, direct workflow JSON import, project playbooks, reviewed suggestions, generation history                                                                            |
| Automation      | On-time local schedules/watchers, pause switches, requested-review scope, revision tracking, inbox, background mode                                                                          |
| Onboarding      | Tool detection, setup wizard, install/auth guidance, setup check for every profile, system/light/dark themes                                                                                 |
| Delivery        | Gated validation, tag-driven Linux/macOS installers launched before release, checksums, signed in-place updates (AppImage, macOS), apt repository, weekly CLI canary, project page with demo |

## Current priorities

1. Verify installer smoke tests on supported systems and respond quickly to first-user issues.
2. Use real workflow feedback to improve generation accuracy and setup guidance.
3. Improve run observability, failure recovery, accessibility, and interface consistency.
4. Keep documentation, CLI contracts, and installation guidance current.

These priorities improve existing capabilities. New features should follow a
concrete use case, fit the existing architecture, and include tests and documentation.

## Next improvements to validate with real use

- MCP server diagnostics as direct as the agent setup check, with small real-tool
  smoke tests.
- Workflow recipes exercised in different languages, using each project's test
  command and accepted project knowledge.
- Exercise dry-run fixtures, deliberate recovery and reported-spend guards against
  real project feedback; verify native parallel timing and provider-report coverage.
- Process-tree cleanup with real CLIs that spawn MCP servers, on both macOS
  architectures (cancel, timeout, MCP shutdown and app exit are tested in CI on Linux
  and Apple Silicon); tools that detach into their own session remain out of reach.
- Keep the manual rows of the [desktop smoke-test matrix](docs/smoke-tests.md)
  current for every release, including the first in-place update from 0.1.24.

## Product boundaries

- Orchevia orchestrates tools; it does not provide AI models or manage provider accounts.
- Execution and scheduling remain local. There is no hosted worker or telemetry service.
- The focus is developer workflows rather than general business automation.
- Linux x86_64 and macOS Apple Silicon/Intel are the initial targets. Windows is not
  currently supported.
- Git and GitHub tasks belong in workflows; a separate file-browser Git client is
  outside the current scope.
