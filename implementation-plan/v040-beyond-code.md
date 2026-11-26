# Orchevia 0.4.0: beyond code

The request after 0.3.3: improve the app everywhere it makes sense, so it works
as an MVP to show, and make it useful to developers and to marketers, researchers
and anyone else who uses their AI for other work, such as images or video. In
order of priority: improve existing features, then UI and UX, then add features.

## Facts checked before building (November 2026)

- `codex exec --skip-git-repo-check` (Codex CLI 0.166.0) is the documented way
  to run outside a Git repository; without it Codex refuses the folder.
- Codex's built-in image tool (`$imagegen`, model gpt-image-2) works on a
  ChatGPT Plus or higher plan without an API key; the Free plan has none.
  Generated images are saved under `$CODEX_HOME/generated_images/<session>/`, not
  in the working folder, so the template asks the agent to copy them in. The
  official docs do not mention `codex exec`; the source shows exec runs the same
  app-server extension. Not verified end to end with a real run.
- Gemini CLI's nanobanana extension needs a Gemini API key (Google sign-in alone
  does not work), and Ollama removed its experimental image generation in
  v0.32.6. Neither became a template.
- Media MCP servers: Replicate (`npx -y replicate-mcp`, `REPLICATE_API_TOKEN`),
  fal (remote, OAuth), ComfyUI's official `comfy-mcp` (local, beta) and Hugging
  Face (remote, OAuth or `HF_TOKEN`). ElevenLabs' local `elevenlabs-mcp` and
  Runway's `runway-api-mcp-server` are archived. None became a preset yet: their
  tool names change often, and the remote ones need OAuth that the preset model
  (command, arguments, variable names) does not cover.
- ImageMagick 7 is `magick`; distributions with version 6 ship `convert`.
  `ffmpeg` and `magick` print their version with `-version`.

## What changed

1. **Workspace folders** (`crates/core/src/workspace.rs`). Folderless Command
   and Agent steps used to run in the app's own folder (`/` for a desktop launch).
   They now run in `<root>/<Workflow name> (<id>)`, root `~/Documents/Orchevia` (or
   `~/Orchevia`) or the `workspace.root` setting. The engine creates the folder
   when it dispatches such a step (`task_workspace`), never in a dry run, and
   falls back to the old behavior if it cannot. Tests use a temporary home
   folder: an early test run created empty folders in the real
   `~/Documents/Orchevia`.
2. **Files on runs** (`crates/core/src/outputs.rs`). The run's folders come from
   its workflow snapshot: the project folder, step folders, profile folders and
   the workspace folder, canonical, nested ones merged. A file counts when its
   modification time falls between the run's start (minus 2 s) and end (plus
   10 s). Walks skip hidden entries and dependency or build folders, never follow
   links, stop at 50,000 entries and list at most 300 files. Reads and opens
   re-check that the canonical path is inside a run folder and outside hidden or
   skipped folders; Open is limited to documents and media. Previews are base64
   for media (≤ 20 MiB) and text for documents (≤ 512 KiB); the CSP allows data
   URLs already.
3. **Inputs** gain `description`, `multiline` and `options` on both sides, with
   `input-settings-invalid` in the shared parity fixture and a run-start
   `input-choice-invalid` check in the engine and the mock.
4. **Templates.** Eight built-ins in `templates.rs` with `creator` and
   `content_reviewer` helpers. The replay test now puts a stand-in `ffmpeg` on the
   steps' PATH. The browser fixture is regenerated with
   `cargo test -p orchevia-core write_browser_template_fixture -- --ignored`.
5. **UI.** Home (`HomeView.tsx`), the command palette (`CommandPalette.tsx`,
   inside the shared `Modal`), Templates search and kind filters
   (`lib/template-domains.ts`), the Files panel (`RunFiles.tsx`), the Workspace
   section and media tools in Environment, and the input details editor. Home and
   the palette hand the Workflows view a one-shot `pendingIntent` (draft a goal,
   run the selected workflow, create a workflow).
6. **Generator.** The prompt covers work beyond code: files as deliverables,
   separate drafting and review, approvals before publishing, inputs kept as
   arguments in media scripts, images through the agent's own tool, input help
   text and choices.

## Review round 1 (Fable)

No high findings. Fixed: palette requests made while Workflows is open (they
were lost, then fired on a later visit) and a StrictMode double create; the
Spreadsheet template's checker had no Python rule and could install packages;
Files dropped edits made while a run waited for approval; copy-in templates
pass an absolute path so profile-folder agents find the file; same-named
workflows shared a folder (now `(<id>)`); ctime counts for copies that keep
their modification time; each run folder gets its own scan budget; web pages
and XML are no longer opened; relative script files keep their old error; a
workspace that cannot be created fails the step; video cuts use `yuv420p`;
the mock lists run folders like the desktop app; the palette's template search
no longer sticks. Kept: previews read any listed-folder file (not only ones in
the run's window), since a file edited after a run should still open.

## Review round 2 (Fable) and the Codex review

Fixed: a file counts when its modification or status change time is in the
window (the max of both hid renamed files), SVG is never opened, the palette's
"Run" reads the active workflow from the store, the template search resets in
`setView` (an effect cleanup ran under StrictMode), the spreadsheet checker
creates no files, and Files has a Refresh button. From the Codex review: the
workspace folder is recorded on the run (`RunExecution.workspace`) and a
workflow working there takes one open run at a time; copy-in stages under
`inputs/` without replacing or following anything; Codex drafts without a
repository and never get the flag twice; previews read through the opened
file's real path (`/proc/self/fd`, `F_GETPATH`) re-checked against the run's
folders; video templates need a local file; padded choice defaults show as
their choice and optional choices can be cleared; Home refreshes runs; the
mock keys files by path. Kept: folderless commands that relied on the app's
launch folder need a project folder (documented), and Open still hands a path
to the system opener after a late check.

## Second Codex review (asked for by the maintainer)

No P0. Fixed: recovering a run from before 0.4.0 takes today's workspace folder
and waits like a new run; a repeated recovery request returns its run before
the open-run check; a schedule or watcher that loses the folder to a run started
by hand waits instead of failing; a value naming a choice is stored trimmed in
the engine and the mock; Git detection for Codex uses the resolved folder;
Files keeps Refresh on a waiting run with no files yet and after an error;
Home's clock moves with its polling; the video templates treat `-` as a file and
refuse a `cuts` link; the copy step compares only regular files. Kept as
documented limits: an old run's folders follow a later profile folder change,
and Open hands the system a path after the last check (a step runs as the user
and can already read what Files could show).

## Left for later

- Media MCP presets (see above) once real accounts confirm their tools.
- Recording each step's own files instead of a run-wide time window: two runs of
  the same workflow at the same time share a folder and see each other's files.
- A real unattended `$imagegen` run through `codex exec`.
