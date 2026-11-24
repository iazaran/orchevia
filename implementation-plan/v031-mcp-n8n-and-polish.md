# Orchevia 0.3.1

Connect Orchevia to more of a team's stack, move workflows to and from n8n, and
make every screen calmer and clearer.

## Implementation and handoff

- [x] Shared `Segmented` switch (radio group, roving tab stop, arrow keys) for
  Simple/Advanced JSON, schedule cadence, the usage date range, command or script
  mode and the theme.
- [x] `JsonEditor` and `JsonView`: syntax colors, line numbers, Format, and the
  line and column of the first error from `checkJsonSyntax` (WebKit gives no
  position for `JSON.parse` errors). Used in the workflow JSON, import, dry-run
  fixture and playbook dialogs.
- [x] n8n conversion in `src/lib/n8n.ts` (pure, deterministic ids): export maps
  steps to manualTrigger/set/executeCommand/if/wait/jira/noOp with error outputs
  for failure edges; import maps triggers, executeCommand (agent CLIs back to
  Agent steps), httpRequest, if (v1 and v2), wait/form/send-and-wait, jira get and
  AI nodes, passes data-shaping nodes through, and lists every loss. Workflows →
  Import / Export; Templates import and export accept n8n.
- [x] 22 verified MCP setups in `MCP_PRESETS` (checked against each README or
  registry in November 2026), shown in a searchable picker inside the server
  form with sign-in steps, export lines, a presence check and example tools.
  Google Docs and Gmail became Google Workspace (`workspace-mcp`, since `gws mcp`
  was removed upstream). Placeholder arguments block saving.
- [x] Three MCP templates (web page brief, AWS docs answer, Slack digest) in the
  core with the TypeScript mirror regenerated; the end-to-end replay covers them
  with a stub server. Templates without repository steps no longer ask for one.
- [x] Playbooks: one form with a single Save, an explanation, and
  `detect_project_commands` (core `project_detect.rs`, Tauri command, mock twin
  that refuses relative paths and suggests nothing).
- [x] Agents: profiles first, install commands and Create profile per CLI,
  Custom CLI presets for Copilot, Cursor, Qwen Code, Amp, Aider, Goose and Kiro.
  Child processes get `PWD` = working folder (OpenCode reads it).
- [x] Interface: line icons, brand mark, button/input/card/pill/dialog tokens,
  grouped one-row workflow toolbar, template card tags, run history rows,
  full-width segmented run progress bar.
- [x] README, project site (redesign, three demo scenarios), area docs, smoke
  tests, roadmap, changelog, screenshots and social preview.
- [ ] Manual checks from `docs/smoke-tests.md` (MCP setups with real accounts, a
  real n8n instance, playbook detection on real repositories, OpenCode `PWD`).

## Notes for the next release

- n8n MCP steps export as placeholders; converting them to an AI Agent with the
  MCP Client tool needs a chat model sub-node the export cannot choose.
- Custom CLI presets put `--model` before the extra arguments, so CLIs with a
  subcommand (Goose, Kiro CLI) need the model set in their own config.
- MCP Tool arguments are strings; servers with strict integer schemas may refuse
  them (the Fetch `max_length` argument is coerced by its server).
