# AI CLI adapters & Agent Profiles

Orchevia orchestrates AI tools you already installed and authenticated locally.
It is **not** an AI provider: there are no model API keys, accounts, or cloud calls
in Orchevia itself.

## How Orchevia finds local AI CLIs

- Environment looks for the supported executables, `git` and `gh` on your login
  shell's `PATH`, then runs `<exe> --version` to show availability. Install and
  sign in through the CLI, then choose **Re-detect**.
- If a CLI disappears later, profiles that use it are preserved and show
  **Unavailable**; workflows referencing them fail validation with
  `agent-cli-unavailable` instead of running half-configured.

## Supported CLIs

| CLI                    | Executable      | Setup                                                                                                                                              |
| ---------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code            | `claude`        | [Install](https://code.claude.com/docs/en/quickstart) and sign in in the terminal.                                                                 |
| Codex                  | `codex`         | [Install](https://developers.openai.com/codex/cli) and run `codex login`.                                                                          |
| Muse Code              | `muse`          | [Install](https://dev.meta.ai/docs/muse-code) and complete Meta sign-in.                                                                           |
| Google Antigravity CLI | `agy`           | [Install](https://antigravity.google/docs/cli/tutorial/) and sign in with Google. This is Google's current Gemini CLI experience for individuals.  |
| Gemini CLI             | `gemini`        | Use [an eligible Enterprise or API-key setup](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/). |
| OpenCode               | `opencode`      | [Install](https://opencode.ai/docs/) and use `/connect` to configure a model provider.                                                             |
| Custom CLI             | Your executable | Set its full path and list any arguments before the prompt.                                                                                        |

**Agents** lists each supported CLI with its install command (or the version it
found) and a **Create profile** button. Install commands checked in November 2026:
`curl -fsSL https://claude.ai/install.sh | bash`, `npm install -g @openai/codex`,
`curl -fsSL https://dev.meta.ai/install.sh | bash`,
`curl -fsSL https://antigravity.google/cli/install.sh | bash`,
`npm install -g @google/gemini-cli` and `npm install -g opencode-ai`. Gemini CLI
stops headless runs in folders it does not trust: open `gemini` in the repository
once and trust it.

### More CLIs through the Custom CLI adapter

**Agents → More coding CLIs** prefills a Custom CLI profile for each of these.
Orchevia passes the extra arguments, then the prompt as the last argument; review
the profile, save it and use **Check setup**.

| CLI                | Program    | Arguments before the prompt                | Notes                                                            |
| ------------------ | ---------- | ------------------------------------------ | ---------------------------------------------------------------- |
| GitHub Copilot CLI | `copilot`  | `-s -p`                                    | Add `--allow-all-tools` to let it act without asking.            |
| Cursor CLI         | `agent`    | `-p --output-format text`                  | Print mode can edit files. Older installs use `cursor-agent`.    |
| Qwen Code          | `qwen`     | `-p`                                       | Add `--approval-mode yolo` to let it act without asking.         |
| Amp                | `amp`      | `-x`                                       | Execute mode.                                                    |
| Aider              | `aider`    | `--no-auto-commits --yes-always --message` | Commits stay with the workflow.                                  |
| Goose              | `goose`    | `run --no-session -t`                      | Leave Model empty; choose it with `goose configure`.             |
| Kiro CLI           | `kiro-cli` | `chat --no-interactive`                    | Tools it would ask about are refused unless `--trust-all-tools`. |

A Custom CLI adds `--model <m>` before the extra arguments when Model is set, so
leave Model empty for CLIs whose model flag belongs after a subcommand (Goose,
Kiro CLI).

Every CLI starts with `PWD` set to the step's working folder. OpenCode reads its
project folder from `PWD`; before 0.3.1 it could run in Orchevia's own folder.

Muse Code, both Google CLIs, and OpenCode run headlessly with text output,
their own permissions, and a fresh invocation for each step. The model is
optional. Leave it blank to use the CLI default. Antigravity also supports
profile effort. Orchevia records attempts and transcripts for these profiles.
Structured activity, provider-reported usage, managed session groups and profile
skill selection remain available for Claude Code and Codex.

## What an Agent Profile is

A profile is a persisted, inspectable recipe for invoking one CLI:

| Field                  | Meaning                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                   | Human label, e.g. “Claude — Implementation”                                                                                                     |
| Provider/CLI           | A built-in adapter or a custom CLI with an explicit executable                                                                                  |
| Executable             | Blank = auto-detect the adapter default on `PATH`; or pin an explicit path                                                                      |
| Model                  | Free-form, adapter-specific (e.g. `opus`); validated lightly since names evolve                                                                 |
| Additional arguments   | Passed verbatim as argv (no shell); credential-like flags are rejected                                                                          |
| Working directory mode | Per-node directory (blank uses the workflow's repository directory), fixed profile directory, or inherit (explicit opt-in)                      |
| Default timeout        | 1–43200 s per run (12-hour cap; default 3600 s)                                                                                                 |
| Skills                 | Optional Claude/Codex skill names; leave empty for automatic CLI selection                                                                      |
| Permissions            | App default (the default), the CLI's settings, Allowed tools (Claude Code), or Full access; see [Tool permissions](#tool-permissions)           |
| Role                   | Optional default mapping: `planning`, `implementation`, `fastReview`, `deepReview`, `workflowGenerator`, `workflowAssistance`, `generalPurpose` |

Manage profiles in the **Agents** tab: create, rename, reconfigure, **Test** (probes the
CLI without running a workflow), or delete (workflows referencing it fail validation
until remapped).

## Configure a profile

1. Install and authenticate the CLIs yourself (e.g. `claude` from Claude Code,
   `codex` from Codex CLI) and verify they work in a terminal. Orchevia reads your
   login shell's `PATH` once at startup (and on **Refresh** in Environment or
   Agents), so CLIs installed through nvm, fnm, Homebrew or `~/.local/bin` are found
   even when the app is launched from the desktop menu. When Orchevia is started from
   a terminal it keeps that terminal's `PATH` (including `nvm use` changes). Set the
   profile's executable to a full path to bypass lookup.
2. In Orchevia: Agents → + New profile → pick the CLI → optionally set model,
   working-directory mode, and timeout.
3. Add an **AI Agent** node in a workflow, pick the profile, write the prompt, and
   run explicitly with ▶ Run. Use **Preview agent command** to see the exact argv.

Command shapes (built by the adapter, never by the engine or UI):

- Claude: `claude -p --output-format stream-json --verbose [--model <model>] [--effort <level>] [permission flags] [extra args…]`, prompt on stdin
- Codex: `codex exec --json [--model <model>] [-c model_reasoning_effort="high"] [permission flag] [extra args…] -`, prompt on stdin
- Muse Code: `muse exec [--model <model>] [extra args…] -- <prompt>`
- Antigravity: `agy [--model <model>] [--effort <level>] [extra args…] --output-format text --print=<prompt>`
- Gemini CLI: `gemini [--model <model>] [extra args…] --output-format text --prompt=<prompt>`
- OpenCode: `opencode run [--model <provider/model>] [extra args…] -- <prompt>`
- Custom: `<executable> [--model <model>] [extra args…] <prompt>`

Claude and Codex nodes decode the structured stream into the final response
(conditions, handoffs and templates see only that text), the readable activity log,
and CLI-reported usage (tokens; USD for Claude). If a profile's extra arguments set
the output format themselves (`--output-format` for Claude, `--json` for Codex), the
node uses the text form instead (`claude -p --output-format text …`,
`codex exec … - [extra args…]`) and Runs notes that no usage was reported. A Claude
profile with its own `--input-format` keeps the previous invocation
(`claude -p <prompt> --output-format text …`, prompt as an argument). A stray
non-JSON line (for example from a wrapper script) is kept in the activity log
instead of failing the node; session-group turns stay strict. Workflow generation
and assistance always use the text form.

Optional effort maps to `--effort` for Claude and `model_reasoning_effort` for
Codex. Custom adapters leave effort to the CLI. Selected skills are prefixed
to the prompt as `/skill-name` (Claude) or `$skill-name` (Codex).
**Check setup** sends one short prompt with the profile, in a temporary folder,
at its effective permission level: CLI installed (and its version), signed in
and answering, reads a file in its working folder, and edits one without
asking. A signed-out CLI, a usage limit, a timeout and refused tools each get
their own message and fix. Under CLI settings a refused edit is a warning (steps
that edit will be refused); under Full access it is a failure, because it means
the CLI no longer honours the permission flag headless. Custom CLIs are judged on
their reply only. Verify a selected skill with a small workflow run. Personal and fixed-directory skills are discovered locally;
plugin, synced, and per-node project skills can be entered by name.

Claude and Codex receive the prompt on **stdin**, so prompt text can never become
flags, is not limited by the operating system's argument size (128 KiB per argument
on Linux), and does not appear in process listings. Previews show
`<prompt via stdin, N chars>`. Custom CLIs receive it as the final argv element.

## Tool permissions

Headless Claude Code and Codex cannot stop and ask for permission while a workflow
step runs, so what they may do is decided up front, once. Orchevia passes it only
as command-line flags for that run. It never writes `~/.claude/settings.json`, Codex
config, or any project settings file, because those also govern your interactive
sessions.

### Agent permissions (app-wide)

**Environment → Agent permissions** holds one choice for every profile at the
**App default** level, which is what new profiles and every profile saved without
an explicit level use:

- **Let agents work without asking (full access)**: Claude Code and Codex skip
  their permission checks, so a step is never refused a tool.
- **Follow each CLI's own settings**: no flag, as before v0.1.19. A tool those
  settings do not allow is refused, and the step fails.

Until you choose, the app default means the CLI's own settings, so upgrading
widens nothing. The setup wizard asks on its **Permissions** step. Starting a run,
using a template or importing one asks once more while nothing is chosen, and that
question can also switch profiles that kept their own allow-list (for example from
earlier "Add to allowed tools" grants) back to the app default. Environment lists
the profiles that set their own level and can make them follow the app default.
The choice is stored as the `agents.permissionDefault` setting (`cliSettings` or
`fullAccess`).

### Profile levels

Agents can give one profile its own level, which then wins over the app default:

| Level                            | Claude Code                                     | Codex                                        |
| -------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| App default (default)            | the app-wide choice below                       | the app-wide choice below                    |
| Use Claude Code / Codex settings | no flag                                         | no flag                                      |
| Allowed tools                    | `--allowedTools <rules>` on top of the settings | not offered: Codex has no tool allow-list    |
| Full access                      | `--permission-mode bypassPermissions`           | `--dangerously-bypass-approvals-and-sandbox` |

- **App default** resolves, before each run, to Full access or the CLI's settings.
  A Custom CLI, or a profile whose extra arguments set permissions themselves (for
  example `--permission-mode acceptEdits`), keeps its own behaviour: no flag is
  added. Runs, schedule trust checks, command previews and workflow generation all
  use the resolved level.
- **Use the CLI's settings** keeps the CLI's own settings even when the app-wide
  choice is full access. Headless `claude -p` still refuses any tool the settings
  do not allow; it does not apply `defaultMode: bypassPermissions` from a project's
  `.claude/settings.local.json`. Codex `exec` without a sandbox setting is
  read-only.
- **Allowed tools** lists Claude Code allow rules: a tool name (`Edit`, `Write`), an
  MCP server (`mcp__<server>`) or one of its tools, or a tool with a specifier
  (`Bash(git status *)`, `WebFetch(domain:example.com)`). What the Claude Code
  settings already allow still applies. Rules are validated: at most 64, no
  duplicates, no commas or nested parentheses, and nothing that looks like a
  credential.
- **Full access** skips every permission check, for this profile only. Never the
  default. A workflow whose Agent nodes run with full access (this level, the app
  default resolved to it, or extra arguments that bypass checks, such as
  `--dangerously-skip-permissions`) lists **Run AI CLI with full access** among its
  automation risks, and its schedules need the per-schedule trusted opt-in.

While a profile uses the Allowed tools or Full access level, extra arguments that
set permissions themselves (`--permission-mode`, `--allowedTools`,
`--dangerously-skip-permissions`; Codex `--sandbox`, `--full-auto`) are rejected.

## Abilities from your own setup

A workflow step runs your own Claude Code or Codex, so it already loads what you set
up for them: Claude Code its MCP servers, claude.ai connectors, skills, plugins and
`~/.claude/CLAUDE.md`; Codex its MCP servers, plugins and `~/.codex/AGENTS.md`. Two
things do not carry over to a headless run on their own, and **Environment → Agents
→ Abilities from your own setup** (also the setup wizard's **Abilities** step)
decides them once:

- **Your browser (Claude in Chrome).** `claude -p` starts without Claude in Chrome.
  With the switch on, Claude Code steps run with `--chrome`, so they can open pages
  and act in the browser you are signed in to. Below full access the browser's
  tools (`mcp__claude-in-chrome`) are allowed for those runs. A profile can choose
  for itself in Agents (**Browser**: app default, on or off); `--chrome` or
  `--no-chrome` among a profile's extra arguments wins. Turning it on asks first,
  and a workflow whose steps use the browser lists **Use your browser and its
  signed-in sites** among its automation risks, so its schedules need the trusted
  opt-in.
- **What steps may use without asking.** Under full access, everything. Otherwise a
  connector, MCP server or web tool works in a step only when your Claude Code
  settings allow it, or when you allow it here: each connector has a switch, and
  **Allow all** covers the rest. Allowed rules reach profiles that follow the app
  default as `--allowedTools` on top of your settings (a profile at **Use Claude
  Code settings** gets none; a profile at **Allowed tools** keeps its own list).
  Codex has no allow-list, so its approval settings or full access decide.

**Find what my agents can use** runs only `claude mcp list`, `codex mcp list --json`
and `codex plugin list` (which start your MCP servers to check them) and reads
`~/.claude/settings.json`, the browser extension's native messaging host and your
skill folders. It sends no prompt and changes no CLI settings. Servers you added for
one project appear when a step runs in that project, not in this list.

After **Find**, Orchevia also compares the MCP servers your Agent steps require
(`requiredTools`) with what Claude Code lists, and names any it no longer has
together with the connector it most likely became: reconnecting a claude.ai
connector can rename it, for example from `claude_ai_Atlassian_Rovo_2` to
`claude_ai_Atlassian_Rovo`. Update those steps' required tools and prompts.

The choice is stored as the `agents.abilities` setting:
`{"browser": true, "allowedTools": ["mcp__claude_ai_Slack", "WebFetch"]}`.

## Refused tool calls

Headless `claude -p` never asks for permission. A tool that the Claude Code
settings do not allow is refused, the model carries on without it, and Claude's
final result still reports success. Claude lists the refusals only in that
result's `permission_denials`, so Orchevia reads them:

- A non-empty list fails the Agent node with the failure kind `permissionDenied`.
  Failure routes and run recovery behave as for any other agent failure. The node
  is not retried automatically, because the same profile would be refused again.
- The error names each refused tool and the allow rule that would admit it: an
  MCP tool suggests its server rule `mcp__<server>`, a Bash command suggests
  `Bash(<command prefix> *)` for each command in the line (`git status`,
  `pnpm test`, `touch`), and any other tool suggests its own name (`Write`).
  Heredoc bodies (`cat <<'EOF'` … `EOF`) and redirections (`2>&1`) are data, not
  commands, so they never become rules.
- The refusals stay in the node's structured result. Runs marks the step **tools
  refused**, lists each refused call with its suggested rule, and offers two
  fixes after you confirm: **Let agents work without asking** (the app-wide full
  access choice, which also switches this profile back to the app default) or
  adding the missing rules to the step's profile. A model that is refused one tool
  often tries another next time, so allow-lists can take several rounds; full
  access ends them at once. Then use **Recover failed run** to retry the step. The confirmation also lists any saved
  allowed tools that switching the profile to Allowed tools applies again. A
  profile whose extra arguments set permissions itself (for example
  `--allowedTools`) is not changed automatically: move those rules into Allowed
  tools in Agents first.

Text-output invocations (a profile whose extra arguments set `--output-format` or
`--input-format`, and workflow generation) have no result event, so refused
tools there go undetected. Runs says so in the step's output note.

Codex has no equivalent signal. In `codex exec --json` (checked with Codex CLI
0.162.1), a command blocked by the sandbox produced no `command_execution` item
and no error event, and the turn ended with `turn.completed`. Only the model's
own message said that the command failed. Orchevia does not guess from that text.

## Prompt composition

Agent prompts are small deterministic templates:

- `{{workflow.name}}`, `{{workflow.id}}`
- `{{node.<id>}}` / `{{node.<id>.output}}` — stdout of a completed upstream node
- `{{node.<id>.status}}`, `{{node.<id>.exitCode}}`
- `\{{` escapes to a literal `{{`; missing variables fail the node listing the names

There is no expression language, no conditionals, no script evaluation — by design.

## What Orchevia stores (and does not)

Stored locally in SQLite (`agent_profiles`, `known_folders` tables):

- profile configuration (adapter, model, args, directory mode, timeout, role,
  permission level and allowed tools)
- recently used project folders (paths only, local-only)

Orchevia has no credential configuration fields and does not save environment
dumps. Extra args reject credential-like flags. Run history stores stdout/stderr
without a general secret scrubber, so tool output or pasted prompt text can still
contain sensitive information. Inspect it before sharing. Since v0.2.0 each agent
result also keeps a short digest of the CLI's events (changed file paths, shell
commands and their exit status, its task list), and feedback you send during a run
is stored with that run; both are deleted with the run.

## Privacy implications

Invoking a profile runs a third-party CLI that **may send your prompt and repository
content to its own provider** according to that tool's behavior. Orchevia cannot make
Claude/Codex offline and does not claim to. The Agents UI and node inspector surface
this before every run; approval gates let you review plans before implementation runs.

## Recommended setup

The wizard creates missing recommendations per adapter and role without replacing
your profiles: Claude Opus for implementation and fast review, Claude Fable for
planning, workflow generation, workflow assistance, and deep review, plus Codex gpt-6.1-sol for deep
review. Recommendations use high effort, a 3600-second timeout, the workflow
node directory, and CLI-selected skills. Missing CLIs remain unavailable.
Generated steps may select an exact `profileName` in addition to their role;
missing or duplicate profile names are reported rather than substituted.

The wizard lets you choose the workflow assistant's CLI, model and effort, or
select an existing profile. It remembers the selection for Workflows → Assist.
The default recommendation uses Claude Code, Fable and high effort; existing
profiles are preserved. You can change the profile on each assistance request.

## Profiles in imported templates

Importing a template into the library can preserve logical roles without choosing
machine-local profiles. When you use the template, an explicit profile is kept;
otherwise an enabled global manual/accepted role preference is used, then the
first configured profile with that role in alphabetical name order. No matching
role mapping blocks template use instead of silently choosing another CLI.

The creation notification lists the selected profiles. Select an AI Agent node to
see its effective profile, CLI, model and effort in the inspector. A blank model
or effort means the CLI default for that setting. A missing profile or unresolved
role is shown explicitly; there is no hidden runtime profile fallback. Selecting a
profile manually removes the unresolved role before autosaving.

## Context reuse and handoffs

Agent nodes optionally reuse Claude/Codex context using named session groups and
pass selected bounded outputs to other agents. See [workflow cost controls](workflow-costs.md)
for isolation, retries, CLI constraints and measurement. The wizard also recommends
**Claude — General purpose** (Opus, medium effort, `generalPurpose` role), preserving
existing profiles.
