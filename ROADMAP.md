# Roadmap

Orchevia focuses on repeatable developer workflows using local CLI agents and
integrations. Version 0.1.0 is the first public beta; publishing its installers
follows review and merge of the initial application.

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

1. Complete the first public beta release and verify installers on supported systems.
2. Use real workflow feedback to improve generation accuracy and setup guidance.
3. Improve run observability, failure recovery, accessibility, and interface consistency.
4. Keep documentation, CLI contracts, and installation guidance current.

These priorities improve existing capabilities. New features should follow a
concrete use case, fit the existing architecture, and include tests and documentation.

## Product boundaries

- Orchevia orchestrates tools; it does not provide AI models or manage provider accounts.
- Execution and scheduling remain local. There is no hosted worker or telemetry service.
- The focus is developer workflows rather than general business automation.
- Linux x86_64 and macOS Apple Silicon/Intel are the initial targets. Windows is not
  currently supported.
- Git and GitHub tasks belong in workflows; a separate file-browser Git client is
  outside the current scope.
