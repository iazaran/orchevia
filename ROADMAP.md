# Roadmap

Orchevia focuses on repeatable developer workflows using local CLI agents and
integrations. The 0.1.x beta line focuses on reliable orchestration, readable
workflow authoring and practical adoption. The repository and downloads remain
private while public access is prepared.

## Implemented

| Area            | Current capabilities                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| Workflow editor | Visual nodes and connections, validation, repository defaults, JSON editing, layout, run overlays                 |
| Agent profiles  | Claude Code, Codex, custom CLI, model and effort settings, optional skills, command previews                      |
| Execution       | Parallel paths and joins, conditions, retries, bounded loops, approval gates, timeouts, cancellation, live output |
| Integrations    | Native Git and GitHub operations, Jira tickets through MCP, generic MCP tools, CLI fallback                       |
| Reuse           | Built-in templates, user templates, import/export, local preferences and generation history                       |
| Automation      | Local schedules, GitHub watchers, inbox, trust settings, optional background mode                                 |
| Onboarding      | Tool detection, setup wizard, install/auth guidance, system/light/dark themes                                     |
| Delivery        | Gated PR/main validation, tag-driven Linux/macOS installers, checksums, private-beta project page                 |

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
- Recovery from a failed step with explicit handling of prior side effects;
  never silently repeat commits, pushes, comments or other writes.
- Process-tree lifecycle handling for tools that spawn descendants. Current
  cancellation stops the direct child and preserves output; descendant cleanup
  requires platform-specific verification.
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
