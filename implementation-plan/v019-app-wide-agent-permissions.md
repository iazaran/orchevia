# v0.1.19 implementation outcome

Decide agent permissions once. Application version `0.1.18` → `0.1.19`. Workflow
schema unchanged; template and Simple JSON versions stay 1.

## Why

A real "Jira ticket to reviewed PR" run (a private service repository, 2026-10-21)
failed twice on review and implementation steps. Each failure was a different
refused tool: a `WebFetch` to Docker Hub, then an AWS MCP call, then compound
shell lines. After v0.1.16 every refusal fails the step, and the only fix on
offer was to add allow rules to that profile and recover the run. A headless
model that is refused one tool usually tries another, so the user granted rules
step after step and the question kept coming back. Before v0.1.16 the refusals
were silent, which is why the same workflows "just worked" earlier.

The same runs showed a parser bug: a refused `cat > PR_BODY.md <<'EOF' … EOF`
suggested `Bash(The *)`, `Bash(No *)`, `Bash(2. *)`, `Bash(EOF *)` and more,
because the heredoc body was split into "commands". Those rules were saved to
the profile and admitted nothing.

## App-wide level

1. **Model.** `PermissionLevel::AppDefault` (`appDefault`) is the new default
   and is not serialized, so stored profiles stay byte-identical and every
   profile saved without an explicit level follows it. An explicit
   `cliSettings` is now serialized so it can override a full-access default.
   `AgentProfile::with_app_default` resolves it: Full access when the app-wide
   level is `fullAccess`, the adapter is Claude or Codex and the profile's
   extra arguments set no permissions; CLI settings otherwise.
2. **Setting.** `agents.permissionDefault` (`cliSettings` | `fullAccess`),
   validated by `parse_permission_default` in `set_setting` and its mock twin.
   Unset means "not chosen": runs use the CLI settings and the UI asks once.
3. **Resolution points.** `SqliteDb::get_effective_agent_profile` and
   `list_effective_agent_profiles` apply the setting. They replace the raw
   reads where the level decides what a CLI may do: the engine's agent
   execution and start validation, the scheduler's fire-time trust check,
   `may_enable_schedule`, `workflow_risks`, `preview_agent_command` and
   `generate_workflow`. Listing, export, import and role maps keep the stored
   profiles. Managed-session keys hash the resolved profile, so a run in
   flight across the upgrade (or across a change of the setting) starts a
   fresh session for its next turn.
4. **Mirror.** `withAppDefault`, `parsePermissionDefault` and
   `readPermissionDefault` in `src/lib/agents.ts`; `profileGrants`,
   `withAllowedTools` and `missingToolGrants` take the app default;
   `MockBackend` resolves profiles for previews, risks and schedule trust.

## Where the user decides

- **Setup wizard:** a Permissions step (`AgentPermissionsSettings`).
- **Environment → Agent permissions:** the same choice, plus the profiles that
  set their own level and a button that makes them follow the app default.
- **Start run, Use template, template import:** `ToolGrantNotice` shows the
  one-time question (`AgentAccessChoice`) while the setting is unset and the
  workflow has a Claude or Codex Agent step. "Let agents work without asking"
  can also switch profiles with their own CLI settings or allow-list back to
  the app default (a checked box naming them), which is what an upgrading user
  whose profiles collected v0.1.16 grants needs. Once chosen, the notice falls
  back to the declared-tools list, which also offers full access.
- **Runs → tools refused:** "Let agents work without asking" next to "Add N
  rules", after a confirmation.
- **Agents:** "App default (Full access)" / "App default (CLI settings)" is the
  first level, and profile cards show what the profile runs with.

Choosing full access never enables a schedule or watcher; schedules over agents
already need the trusted opt-in, and the trust message names full access.

## Rule suggestions

`split_commands` skips heredoc bodies (`<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<-EOF`,
several per line, unterminated bodies end the command) and treats `2>&1`,
`>&2`, `<&3` and `&>file` as redirections. Here-strings (`<<<`) are untouched.
The refused command from the failed run is a test case. The refusal message
now names Environment → Agent permissions as the one-step fix.

## Review follow-ups

- **Arithmetic.** `$((1 << 2))` read as a heredoc with delimiter `2` and
  swallowed the following commands. `((` … `))` is now arithmetic: no heredocs
  or separators inside it.
- **Exact delimiters.** The delimiter line is matched exactly, as the shell
  does; leading tabs are ignored only for `<<-`. A quoted delimiter with a
  trailing space (`<<'END '`) used to swallow the rest of the line.
- **Save order.** `setAgentPermissionDefault` saved the setting before the
  profiles. A failed profile save then hid the question (the setting was
  already chosen) and its error, with full access on and the profile still
  restricted. Profiles are now saved first and the setting last, so a failure
  leaves the choice unmade and visible, and never grants more than chosen.

## Not changed

- A refusal still fails the step under the CLI settings or an allow-list; full
  access is the way to never see one.
- Codex refusals are still undetected (no signal in `codex exec --json`).
- Saved junk rules from the heredoc bug stay in existing profiles until edited;
  they go unused once the profile follows a full-access app default.

## Verification

- `cargo test -p orchevia-core` (with new tests for resolution, the effective
  DB reads, the engine passing `--permission-mode bypassPermissions` once
  chosen, and heredocs), `cargo test -p orchevia` (setting validation), clippy
  `-D warnings`, `cargo fmt --check`, `cargo check -p orchevia`.
- `pnpm check`: the one-time question on Start run and Use template, keeping
  the CLI settings, the wizard step, the refused-step action, the Agents
  labels, helper parity and mock parity.
- Checked in the browser build: wizard step, Use template question, Environment
  section, Agents labels.
