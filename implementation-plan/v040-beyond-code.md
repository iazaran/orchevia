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
   They now run in `<root>/<Workflow name>`, root `~/Documents/Orchevia` (or
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

## Left for later

- Media MCP presets (see above) once real accounts confirm their tools.
- Recording each step's own files instead of a run-wide time window: two runs of
  the same workflow at the same time share a folder and see each other's files.
- A real unattended `$imagegen` run through `codex exec`.
