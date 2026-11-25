# Roadmap

Orchevia focuses on repeatable developer workflows using local CLI agents and
integrations. The 0.2 line adds a run you can read and steer while it works: step
cards that say what each step is doing and achieved, and feedback on a step that is
checked, applied and rerun before anything is published. Source, installers and the
project page are public. The 0.3 release adds review comparisons, a repository-first
Playbooks page and setup for more agents and MCP servers; 0.3.1 connects Orchevia to
more of a team's stack (22 MCP setups, seven more coding CLIs), moves workflows to and
from n8n, and refreshes the interface. 0.3.3 lets workflow steps keep what your agents
already have: your browser through Claude in Chrome, and the connectors and MCP servers
you set up in Claude Code and Codex, chosen once.

## Implemented

| Area            | Current capabilities                                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow editor | Autosaved graph editing, dependency-aware layout, reviewable workflow assistance, JSON, run overlays, script-file Command steps, publishing-step marker                                                                            |
| Agent profiles  | Claude Code, Codex, Muse Code, Google Antigravity CLI, Gemini CLI, OpenCode and custom profiles (one-click Copilot, Cursor, Qwen Code, Amp, Aider, Goose, Kiro), setup checks, abilities from your own setup (browser, connectors) |
| Execution       | Parallel paths/joins, bounded and nested loops, retries, approvals, dry-run fixtures, deliberate failed-run recovery, spend guard, feedback on steps during a run with correction rounds                                           |
| Integrations    | Native Git and GitHub operations, Jira tickets through MCP, 22 MCP setups (Google Workspace, Microsoft 365, Slack, Notion, GitHub, Linear, Sentry…), server checks, n8n import and export                                          |
| Reuse           | Built-in/user templates (three with MCP), JSON and n8n import, project playbooks with command detection, reviewed suggestions, generation history                                                                                  |
| Automation      | On-time local schedules/watchers, pause switches, requested-review scope, revision tracking, inbox, background mode                                                                                                                |
| Onboarding      | Tool detection, setup wizard, install/auth guidance, setup check for every profile, system/light/dark themes                                                                                                                       |
| Delivery        | Gated validation, tag-driven Linux/macOS installers launched before release, checksums, signed in-place updates (AppImage, macOS), apt repository, weekly CLI canary, project page with demo                                       |

## Current priorities

1. Verify installer smoke tests on supported systems and respond quickly to first-user issues.
2. Use real workflow feedback to improve generation accuracy and setup guidance.
3. Improve run observability, failure recovery, accessibility, and interface consistency.
4. Keep documentation, CLI contracts, and installation guidance current.

These priorities improve existing capabilities. New features should follow a
concrete use case, fit the existing architecture, and include tests and documentation.

## Next improvements to validate with real use

- n8n round trips with real workflows: which nodes people need converted next, and
  whether MCP steps should become an n8n AI Agent with the MCP Client tool.
- Abilities in real runs: Claude in Chrome in unattended steps (site permissions in
  the extension, several steps sharing one browser), and whether Codex's browser
  plugin works the same in `codex exec`.
- MCP setups against real accounts: sign-in friction per service, and whether an MCP
  Tool step should offer the tools a selected setup lists.

- Feedback during real runs: whether checks decide well, how often a correction is
  needed, and whether the correction-round limit fits; a way to send feedback from
  the canvas as well as the Runs page.
- Readable runs against more CLI versions: keep the recorded event fixtures current
  and add Codex task-list and MCP-call shapes once recorded.
- Workflow recipes exercised in different languages, using each project's test
  command and accepted project knowledge.
- Exercise dry-run fixtures, deliberate recovery and reported-spend guards against
  real project feedback; verify native parallel timing and provider-report coverage.
- Process-tree cleanup with real CLIs that spawn MCP servers, on both macOS
  architectures (cancel, timeout, MCP shutdown and app exit are tested in CI on Linux
  and Apple Silicon); tools that detach into their own session remain out of reach.
- Keep the manual rows of the [desktop smoke-test matrix](docs/smoke-tests.md)
  current for every release, including the first in-place update from 0.1.24 to
  0.2.0.

## Product boundaries

- Orchevia orchestrates tools; it does not provide AI models or manage provider accounts.
- Execution and scheduling remain local. There is no hosted worker or telemetry service.
- The focus is developer workflows rather than general business automation.
- Linux x86_64 and macOS Apple Silicon/Intel are the initial targets. Windows is not
  currently supported.
- Git and GitHub tasks belong in workflows; a separate file-browser Git client is
  outside the current scope.
