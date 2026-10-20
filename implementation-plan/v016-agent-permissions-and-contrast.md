# v0.1.16 implementation outcome

Agent tool permissions and dark-theme contrast. Application version `0.1.15` →
`0.1.16`. Workflow schema unchanged (no bump); template and Simple JSON versions
stay 1.

## Why

A "Jira ticket to reviewed PR" run reported Succeeded although its first agent
was refused every Jira tool call and printed `TICKET_STATUS=none`. Orchevia passed
no permission flags; headless `claude -p` (Claude Code 2.1.303) ignores
`defaultMode: bypassPermissions` from a project's `.claude/settings.local.json`,
refuses tools its settings do not allow, and still ends with
`"subtype":"success"`, `"is_error":false`. The refusals appear only as
`permission_denials` on the final result event, which Orchevia dropped.

## Delivered

1. **Detection** (`permissions.rs`, `agent_output.rs`, `engine.rs`): a non-empty
   `permission_denials` fails the node with the `permissionDenied` failure kind.
   Each denial records the tool, a short input summary and the suggested allow
   rule (`mcp__<server>` for MCP tools, `Bash(<command prefix> *)` per command of
   a Bash line, otherwise the tool name). The node result keeps
   `permissionDenied {profileId, denials, rules}`. Failure routes and recovery are
   unchanged; automatic retries are skipped because the same profile would be
   refused again.
2. **Profile permissions** (`agents.rs`, `agents.ts`): `permissionLevel`
   (`cliSettings` default, `allowedTools`, `fullAccess`) and `allowedTools`,
   both omitted from stored JSON at their defaults, so existing
   `agent_profiles.definition` rows and session keys are unchanged. Flags only:
   `--allowedTools <comma-joined rules>`, `--permission-mode bypassPermissions`,
   Codex `--dangerously-bypass-approvals-and-sandbox`. Conflicting extra
   arguments are rejected at non-default levels.
3. **Trust** (`trust.rs`): `FullAccessAgent` risk via
   `workflow_risks_with_profiles`, used by schedule enabling, the fire-time gate
   and the risk summary. Role-only nodes count every profile with that role.
4. **Declared tools** (`NodeConfig.required_tools`, `missingToolGrants`): carried
   in Simple JSON and templates, validated like profile rules
   (`agent-required-tools-invalid` / `-misplaced`), checked against the chosen
   profile on template import, in the workflow editor and in the start-run form.
5. **UI**: Permissions editor and card fact (Agents), refused-calls panel with an
   add action (Runs), declared-tools notice and inspector field, and dark-theme
   control tokens (`--btn-*`, `--border-card`, `--input-border`,
   `--tab-selected-*`) mapped to the existing light values.

## Codex parity check

`codex exec --help` (Codex CLI 0.162.1) offers `--sandbox`
(`read-only`/`workspace-write`/`danger-full-access`) and
`--dangerously-bypass-approvals-and-sandbox`, and no tool allow-list. A
`--sandbox read-only --json` probe asked to write a file produced no
`command_execution` item and no `error` event for the blocked command; the turn
ended with `turn.completed`, and only the model's message said the write failed.
There is no reliable signal, so Codex refusals are not detected.

## Verification

`pnpm check`, `cargo test -p orchevia-core`, `cargo clippy -p orchevia-core
--all-targets -- -D warnings`, `cargo fmt --check`, and `cargo check -p orchevia`
(after `pnpm build`). The dark and light themes were checked in the mock-backend
dev server; light-theme computed button, ghost and input colors match v0.1.15.
