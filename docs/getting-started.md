# From your first run to a reusable workflow

Orchevia connects the developer tools you already use into a visible sequence.
Start with a small local command, then add your agent, tests, and approval gates.
You choose when to run and where a human decision belongs.

## Start without an AI account

1. Install the desktop app using the [README downloads](../README.md#download).
   Pick your platform there; every link points to the latest release.
2. Open **Workflows**, create a workflow, and open its **JSON** editor in **Simple** mode.
3. Paste [hello-workflow.json](./examples/hello-workflow.json), save, and close the editor.
   It uses `echo` with a single argument, no shell and no repository changes.
4. Press **Run**. Open **Runs** and select the run to see `Hello from Orchevia`.
5. Choose **Show on canvas** to inspect the exact graph saved with that run.
   Switch back to the editable workflow to make changes.

Contributors can use `pnpm dev` to explore the UI. That browser demo simulates
commands; `pnpm tauri dev` and the installed desktop app execute them.

## Add the tools you need

The setup wizard detects `git`, `gh`, `claude`, and `codex`. Missing tools do not
prevent command-only workflows. Install and authenticate each CLI yourself,
then check it in **Environment**. Orchevia reads your login shell's `PATH`, so
CLIs installed with nvm, fnm, Homebrew or into `~/.local/bin` are found even when
the app starts from your system menu. If you install a CLI while Orchevia is open,
choose **Refresh** in Environment. If a CLI is still not found, set its full
executable path in the relevant profile.

In **Agents**, create a profile for your installed CLI. Keep the model blank to
use its default, or choose a model supported by that CLI and account. Profiles
hold reusable model, effort, working-directory, and optional skill settings.
A profile test checks CLI availability; test a small agent step before relying
on models or skills in a larger automation.

Headless agents cannot ask for permission while a step runs, so decide once what
they may do: the wizard's **Permissions** step or **Environment → Agent
permissions**. **Let agents work without asking** gives Claude Code and Codex full
access, so steps are never refused a tool; **Follow each CLI's own settings**
keeps your Claude Code and Codex configuration in charge, and a refused tool then
fails the step. If you skip it, the first run or template asks once. See
[tool permissions](./agents.md#tool-permissions).

Jira needs an enabled local MCP server. Configure it in **Environment → MCP
servers** and discover its tools. Follow [integrations](./integrations.md) for
GitHub authentication and MCP setup.

## Make your first development flow

Choose **Samples… → Plan → Implement → Review**. Assign profiles, set your
repository directory, and read every prompt before running. Use a sequence such as:

```text
Start → Plan → Human Approval → Implement → Command: project tests → Review → End
```

Use the repository's actual test command. A Command node takes an executable
and separate arguments: for example, `pnpm` with `test` as one argument. If you
need shell operators such as `&&`, explicitly choose `sh` with `-c` and the
script as separate arguments. Review any generated shell script before running.

The workflow repository default supplies Command, Git and GitHub working
directories when a node has no override. Node configuration wins. Agent steps
use their node/profile working-directory settings; inspect those explicitly
when an agent acts on a different repository than expected.

Inspect validation errors, fill required inputs for this workflow, and press
**Run**. Approval pauses the run durably; approve or reject it under **Runs**.
If a step fails, inspect its stderr and partial output before deciding to rerun.
Cancellation stops the active child; it does not undo file edits or external writes.

## Draft a workflow from a goal

Choose **Generate**, select your CLI, and provide the repository and inputs.
A concrete goal works better than a general request:

> Plan a change for {{input.task}} with my planning profile. Pause for approval,
> implement it, run this repository's test command, and request one independent
> review. Use native Git/GitHub nodes where supported. Leave changes uncommitted.

The CLI drafts a proposal. Orchevia validates and compiles it into an editable
preview; it never runs the preview automatically. Read compiler notes and setup
requirements, check each profile, and accept only the graph you intend to run.
Explicit instructions such as “CLI only” override the native-node preference.
Unsupported integration operations may need Command nodes or manual steps.

## Reuse the parts that work

- Start from a built-in **Template**: **Use template** asks for your repository
  folder (and the Jira server for ticket templates), then each run asks for the
  task, bug or PR number and your test command. Built-ins are language neutral and
  leave changes uncommitted unless the template opens a PR.
- Save a workflow as a **Template** to reuse it with new inputs.
- Use **Simple JSON** for readable node keys and portable profile selections.
  **Advanced JSON** preserves the full runtime definition. Importing and editing
  do not execute a workflow. Use **Arrange** when the graph grows.
- In **Memory**, save a project playbook with test commands, conventions, and
  review choices. Suggestions require acceptance. Promote a command from a
  successful run explicitly; full logs are not copied into the playbook.
- Add **Automations** only after a manual run works. Schedules run locally while
  Orchevia stays open; opt into background mode to keep them active with the
  window hidden. Review watchers' repository scope and trust permissions.

## Troubleshooting

| Symptom                             | Next step                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| CLI missing in the desktop app      | Check Environment, the app's PATH, or the profile's absolute executable path.                              |
| Model or skill rejected             | Check your CLI's help and account, then try its default model with a small prompt.                         |
| Git step refuses a dirty repository | Inspect and preserve the changes before retrying; do not discard them to bypass the guard.                 |
| PR checks are pending or failed     | Inspect the check results under Runs; retrieving them does not wait for CI to complete or approve a merge. |
| Workflow pauses                     | Open Runs and approve or reject the current gate.                                                          |
| Schedule does not fire              | Keep the app running (background mode), then read the card's last result: skipped, deferred or blocked.    |
| Generated graph needs setup         | Read the preview notes, assign profiles/MCP servers, and validate before Run.                              |

Commands and agents execute with your user permissions. Orchevia does not
sandbox them; your chosen CLIs and MCP servers may contact remote services.
Output stays in the local database and can contain sensitive data. Read
[security](./security.md) before sharing logs or importing workflows from others.

Continue with [execution](./execution.md), [agents](./agents.md),
[workflow JSON](./workflow-schema.md), [memory](./memory.md), or
[development and releases](./development.md).

## Messages and saving feedback

Workflow and node edits save automatically. A successful save briefly shows
**Saved** in the bottom-left message stack; the toolbar does not keep a permanent
Saved label. A failed save shows an error and keeps the **Retry save** action.

Notifications float above the canvas and dialogs without moving content. Ordinary
information and success messages fade out after five seconds. Warnings and errors
remain until you close them. Multiple messages stack, with long content capped and
scrollable; reduced-motion settings disable fades. New Inbox events also appear
in this stack. Dismissing a popup does not mark its Inbox record read, and existing
Inbox history is not replayed as popups when the app opens.

Structured workflow previews, historical run error details and reference help stay
with their relevant content; action feedback uses the stack. Validation waits until
you ask for something: a form names what is missing next to its Save button after
the first Save, and the workflow editor keeps what a workflow still needs in a quiet
count in the canvas toolbar (each entry selects its step), in the selected step's
inspector, and in the Start dialog when you press Run.

## Keep related AI work efficient

New AI samples and templates use bounded handoffs and implementation/fix session
groups where useful. Inspect the Agent controls before running and keep independent
reviewers fresh. Existing saved workflows opt in. See [workflow cost controls](workflow-costs.md).
