# v0.1.18 implementation outcome

Built-in templates that run as shipped. Application version `0.1.17` →
`0.1.18`. Workflow schema unchanged; template and Simple JSON versions stay 1.

## Why

A first-time user tried "Implement Ticket" and found it asked for a test command
but no ticket. A replay of all nine built-ins in the real engine (stub CLIs, fake
Jira, temp repo) showed that only three finished, and those three ran their AI
steps in Orchevia's own folder. The causes were partly in the templates and
partly in the engine.

## Engine fixes

1. **Severity.** `review::reported_severity`, mirrored in `src/lib/severity.ts`,
   with one shared table of examples in both test suites:
   - Finding blocks win.
   - Otherwise `P0`–`P3` prose tags count, except lists or ranges (`P0/P1`,
     `P0–P3`) and negations (`no P1`, `zero P0 or P1`).

   `node.<id>.severity` is always set; it is `""` without findings. A later
   visit replaces an earlier one. Before:
   - "No P0/P1 issues found" read as P0.
   - A review without tags failed the condition with "Unknown variable".
   - A stale P1 survived a clean second visit.
2. **Loop exits.** A condition whose taken branch leads back to it through
   another step now keeps its exit branches pending, as the existing sibling
   rule did. Only branches that cannot reach the condition wait, so in-loop
   branches and joins are unaffected. Before, the first "true" round skipped
   the exit path forever and the run ended "Succeeded" without it. This was a
   known trap in real workflows.
3. **Agent folders.** Agent steps in `node` working-directory mode fall back to
   `defaults.repoDir`, like Command, Git and GitHub steps. This covers
   `build_agent_command`, session commands and the managed-session `node_dir`.
   The inspector shows the fallback as its placeholder, and the agent command
   preview uses it.
4. **PR files.** `gh pr view <n> --json files` replaces the non-existent
   `gh pr diff --numstat`. I checked the output shape against gh 2.102.
5. **Ticket links.** `ticket::ticket_key` takes the issue key out of a Jira URL.

## Templates

- **Rust builders.** They were rewritten around small helpers:
  - `implementer` declares `Edit`/`Write` and leaves tests and commits to the
    workflow;
  - `reviewer` uses one finding-block instruction;
  - `severity_gate` checks P0 or P1 for every reviewer;
  - `bound_loop` allows two fix rounds.
- **Browser fixture.** The JSON is generated from the Rust builders, so
  `browser_template_fixture_matches_core` keeps them identical.
- **Ids.** Template ids are unchanged. Two names changed:
  - "Implement Ticket" is now "Implement a Task", with a plain `task` input.
    The maintainer chose this so it works without Jira.
  - "Watch Review Feedback" is now "Address Review Feedback".
- **Pushes.** Every PR-opening template pushes with a visible `git push -u
  origin {{input.branch}}` Command step first. There is no native push
  operation yet.
- **Use template** opens a dialog:
  - the repository (required);
  - the MCP server (auto-picked when exactly one is enabled);
  - the run inputs;
  - a `ToolGrantNotice`.

  It sets `defaults.repoDir` and fills empty ticket/MCP servers before saving.
- **Samples.** The Review loop sample re-runs both reviewers after a fix. The
  Review pull request sample checks P0/P1 for both reviewers and asks for
  approval before posting.

## Tests

- `templates::tests::builtins_run_end_to_end` replays all nine templates in the
  real engine:
  - It uses a stub Claude CLI with resume support, a fake Jira MCP server, a fake
    `gh` (via `ORCHEVIA_GH_BIN`, with Command steps pointed at it) and a temp repo
    with a bare `origin`.
  - It asserts success, that every agent ran in the repository, one fix round
    with both reviewers re-run, the pushed branch and commit message, the PR
    arguments, and the posted comment.
- Engine tests cover:
  - the loop-back exit, which fails without the fix;
  - severity following the latest visit and defaulting to empty;
  - agents running in the workflow repository.
- Other tests cover the severity tables (Rust and TypeScript), ticket URLs,
  `gh pr view --json files`, the Use-template dialog, and the sample fixes.
