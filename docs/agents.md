# AI CLI adapters & Agent Profiles

Orchevia orchestrates AI tools you already installed and authenticated locally.
It is **not** an AI provider: there are no model API keys, accounts, or cloud calls
in Orchevia itself.

## How Orchevia finds local AI CLIs

- On the Environment screen Orchevia probes `claude` and `codex` on your `PATH`
  (plus `git` and `gh`) and runs `<exe> --version` with a short timeout to show
  availability. Nothing is installed or logged in on your behalf.
- If a CLI disappears later, profiles that use it are preserved and show
  **Unavailable**; workflows referencing them fail validation with
  `agent-cli-unavailable` instead of running half-configured.

## What an Agent Profile is

A profile is a persisted, inspectable recipe for invoking one CLI:

| Field                  | Meaning                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                   | Human label, e.g. “Claude — Implementation”                                                                                                     |
| Provider/CLI           | `claude`, `codex`, or a custom CLI with an explicit executable                                                                                  |
| Executable             | Blank = auto-detect the adapter default on `PATH`; or pin an explicit path                                                                      |
| Model                  | Free-form, adapter-specific (e.g. `opus`); validated lightly since names evolve                                                                 |
| Additional arguments   | Passed verbatim as argv (no shell); credential-like flags are rejected                                                                          |
| Working directory mode | Per-node directory, fixed profile directory, or inherit (explicit opt-in)                                                                       |
| Default timeout        | 1–43200 s per run (12-hour cap; default 3600 s)                                                                                                 |
| Skills                 | Optional Claude/Codex skill names; leave empty for automatic CLI selection                                                                      |
| Role                   | Optional default mapping: `planning`, `implementation`, `fastReview`, `deepReview`, `workflowGenerator`, `workflowAssistance`, `generalPurpose` |

Manage profiles in the **Agents** tab: create, rename, reconfigure, **Test** (probes the
CLI without running a workflow), or delete (workflows referencing it fail validation
until remapped).

## How to configure Claude / Codex

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

- Claude: `claude -p --output-format stream-json --verbose [--model <model>] [--effort <level>] [extra args…]`, prompt on stdin
- Codex: `codex exec --json [--model <model>] [-c model_reasoning_effort="high"] [extra args…] -`, prompt on stdin
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
The Test button probes CLI availability; verify a selected skill with a small
workflow run. Personal and fixed-directory skills are discovered locally;
plugin, synced, and per-node project skills can be entered by name.

Claude and Codex receive the prompt on **stdin**, so prompt text can never become
flags, is not limited by the operating system's argument size (128 KiB per argument
on Linux), and does not appear in process listings. Previews show
`<prompt via stdin, N chars>`. Custom CLIs receive it as the final argv element.

## Prompt composition

Agent prompts are small deterministic templates:

- `{{workflow.name}}`, `{{workflow.id}}`
- `{{node.<id>}}` / `{{node.<id>.output}}` — stdout of a completed upstream node
- `{{node.<id>.status}}`, `{{node.<id>.exitCode}}`
- `\{{` escapes to a literal `{{`; missing variables fail the node listing the names

There is no expression language, no conditionals, no script evaluation — by design.

## What Orchevia stores (and does not)

Stored locally in SQLite (`agent_profiles`, `known_folders` tables):

- profile configuration (adapter, model, args, directory mode, timeout, role)
- recently used project folders (paths only, local-only)

Orchevia has no credential configuration fields and does not save environment
dumps. Extra args reject credential-like flags. Run history stores stdout/stderr
without a general secret scrubber, so tool output or pasted prompt text can still
contain sensitive information. Inspect it before sharing.

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
