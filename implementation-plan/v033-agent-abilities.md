# Orchevia 0.3.3

Feedback on 0.3.2:

1. Environment: put **+ New MCP server** on top, let listed tools be hidden again,
   rearrange the page so its important parts are easy to find, leave setups already
   connected out of the new server list, and fix the Jira server whose setup now has
   a different name.
2. Let workflow agents work as they do in the user's own terminal, such as using the
   browser, when the user already set that up.
3. Ask once (setup wizard, and a good place such as agent profiles), ask for
   permission only where needed, and otherwise just use those abilities.

## Facts checked before building (November 2026)

- Headless `claude -p` (Claude Code 2.1.326) already loads user MCP servers,
  claude.ai connectors, skills and plugins: the `init` event of a `stream-json`
  run lists them all. Claude in Chrome is not there unless the run passes
  `--chrome`; with it, the `claude-in-chrome` server connects and adds 20
  `mcp__claude-in-chrome__*` tools.
- Claude Code names a server inside tool names by replacing characters other than
  letters, digits, `_` and `-` with `_`; claude.ai connector names also collapse
  repeated underscores and trim them: `claude.ai Atlassian Rovo (2)` →
  `claude_ai_Atlassian_Rovo_2`.
- `claude mcp list` health-checks each server and prints
  `name: target - <mark> status`; it starts stdio servers but sends no prompt.
- `codex exec` (0.166.0) already reaches its MCP servers, plugins and web search
  (`web__run`). `codex mcp list --json` is structured; `codex plugin list` prints
  `name@marketplace  installed, enabled …`. Codex's browser use comes from its own
  plugins, so Orchevia only reports it.
- Claude in Chrome's native messaging host is
  `com.anthropic.claude_code_browser_extension.json` under each browser's
  `NativeMessagingHosts`; `~/.claude.json` keeps `cachedChromeExtensionInstalled`.
- The user's Jira server was saved from the v0.3.0 "Jira" setup (`uvx
  mcp-atlassian`); v0.3.1 renamed the setup "Jira & Confluence" and added
  `--read-only`.

## Implementation and handoff

- [x] `crates/core/src/abilities.rs`: `AppAbilities` (`agents.abilities`:
  `browser`, `allowedTools`), validated on save (`parse_abilities_setting`) and
  read fail-closed (`stored_abilities`). Detection (`detect_abilities`) runs the
  listing commands with a 60 s bound and reports connectors, browser, skills,
  plugins, instruction files and the Claude settings rules that matter
  (`mcp__…`, `WebFetch`, `WebSearch`). Parsers are unit-tested against recorded
  output; a fake-CLI test proves only the listing commands run.
- [x] `AgentProfile.browser: Option<bool>` (absent follows the app).
  `AgentProfile::for_run(&AppAgentSettings)` replaces `with_app_default` in
  `SqliteDb::get_effective_agent_profile` / `list_effective_agent_profiles`, so
  engine, previews, setup checks, generation and trust all see the same profile:
  Claude gets `browser: Some(on)` (never when its extra args pass
  `--chrome`/`--no-chrome`); below full access the browser rule and, for profiles
  following the app default, the allowed abilities become Allowed tools
  (`CliSettings` → `AllowedTools` with just those rules; `AllowedTools` adds them).
  Profiles whose extra args set permissions keep them. `push_browser` adds
  `--chrome` after the permission flags in text, structured and session commands.
- [x] Trust: `RiskCategory::BrowserAgent` ("Use your browser and its signed-in
  sites") from `AgentProfile::uses_browser`, so schedules need the trusted opt-in.
- [x] Tauri: `detect_agent_abilities(adapter)` (blocking pool; the executable from
  the first profile of that adapter with its own path); `agents.abilities` in
  `ALLOWED_SETTINGS` with an 8000-byte limit.
- [x] TS mirror (`src/lib/abilities.ts`, `resolveForRun`, `browserArgs`,
  `usesBrowser`, `browserAgent` risk) and MockBackend parity (preview args,
  setting validation, risks). The mock's detection returns demo data marked as
  such.
- [x] UI: `AgentAbilitiesPanel` (Environment and the wizard's new **Abilities**
  step): Find, browser switch (confirms), web tools switch, per-connector switches
  and **Allow all**, Codex servers/plugins, and the renamed-connector warning
  (`missingConnectors`). Agents: **Browser** select per Claude profile, confirmed
  on save, and a Browser fact on the card.
- [x] Environment: top-bar **+ New MCP server**, jump bar (links), sections Agents
  → MCP servers → Local tools → Updates → Diagnostics; `McpServerCard` with
  setup mark, "From the … setup", hide toggles for tools and checks.
- [x] MCP setups: `legacy` setups per preset, `matchMcpPreset` matches them,
  `presetsInUse` hides used setups in the picker, `mcpSetupUpdate` offers the
  current name/arguments only for what the user left unchanged; dismissals are
  remembered per server and offer in `localStorage`.

## Notes for the next release

- Not verified end to end: a real Claude Code step driving Claude in Chrome
  unattended (the extension's own site permissions may still ask), and several
  concurrent steps sharing one browser.
- Detection runs only on request and keeps its result for the session; workflow
  generation does not yet use the detected connectors.
