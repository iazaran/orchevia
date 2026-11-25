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
  Claude's `browser` becomes the flag the run passes (`Some(true)` `--chrome`,
  `Some(false)` `--no-chrome`, `None` nothing, also when its extra args pass a
  browser flag); below full access the browser rule and, for profiles
  following the app default, the allowed abilities become Allowed tools
  (`CliSettings` → `AllowedTools` with just those rules; `AllowedTools` adds them).
  Profiles whose extra args set permissions keep them. `push_browser` adds
  `--chrome` after the permission flags in text, structured and session commands.
- [x] Trust: `RiskCategory::BrowserAgent` ("Use your browser and its signed-in
  sites") from `AgentProfile::uses_browser`, listed among a workflow's risks.
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

- [x] Review (Fable, then Codex once). Fixed:
  - stored grants were invisible and unremovable without a detection (now always
    listed with Remove);
  - **Add to allowed tools** dropped the app-wide grants of a profile at the app
    default (`inheritedAbilities` copies them into its own list);
  - an explicit Off emitted nothing, so a Claude Code default could still turn
    Chrome on (`--no-chrome` now; following an app that leaves it off adds no flag);
  - a full 64-rule list failed once the browser rule was added
    (`validate_for_run` skips the per-list limit; saving still enforces it);
  - `--chrome` in extra arguments with Browser Off (rejected for an explicit choice;
    the card and the save confirmation follow the effective flag);
  - detection rendered whole command lines (`display_target`: program and URL
    origin only);
  - a failed listing produced a "no longer listed" warning (`connectorsListed`),
    and rename suggestions matched any shared `claude_ai_` prefix (copy-number
    only, unique);
  - "Disconnected" and "401" statuses read as usable;
  - the old Gmail/Google Docs setups were offered Google Workspace, which widens
    services (dropped);
  - JSON `null` accepted by the mock but not by serde;
  - Find skipped CLIs set up only through a profile's executable;
  - stale dismissals and tool lists after an edit; jump links did not move focus;
  - wording that promised the app browser reached only app-default profiles.
- [x] Decided, not changed: schedule trust stays one boolean. A schedule trusted
  before the browser was turned on keeps running; the browser confirmation names
  the enabled schedules and watchers that will use it, and the docs say so.
  Allow rules name a server, as Claude Code's own do; project servers stay
  unconnected until approved in Claude Code.

## Notes for the next release

- Not verified end to end: a real Claude Code step driving Claude in Chrome
  unattended (the extension's own site permissions may still ask), and several
  concurrent steps sharing one browser.
- A per-schedule record of the risks it was trusted for would let a newly added
  risk (such as the browser) ask again; today the confirmation names them instead.
- Detection runs only on request and keeps its result for the session; workflow
  generation does not yet use the detected connectors.
