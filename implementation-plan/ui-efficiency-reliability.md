# UI refresh and rendering efficiency — v0.1.12

Frontend-only slice of `local-cli-and-ui-efficiency.md`: `src/` components, the
store and their tests. No new Backend methods, Tauri events or native changes.

## Leads checked on `b782dbe`

- **Confirmed:** Runs polls every 1.5 s while any run is running or paused, and each
  tick called `selectRun` for the selected run even when it had finished
  (`RunsView.tsx` `refreshRunData`).
- **Confirmed:** the findings effect depended on the whole `runResults` map, so any
  run's cache update refetched the selected run's findings. It also had no stale
  response guard: a late response for a previous run replaced the current findings.
- **Confirmed:** `MarkdownText` ran `isMarkdown` and `renderMarkdown` on every render,
  including Raw/Formatted toggles and parent rerenders.
- **Confirmed:** `BranchPicker` called `gitBranches` (a native `git` invocation) for
  every keystroke in a repository path field (`DirPicker` updates per keystroke).

## Changes

- Store `selectRun` records the run status each results request saw
  (`runResultStatus`) and keeps the existing array when every field of every row is
  identical (`sameNodeResults` compares all fields, never output length). The
  selection sequence guard is unchanged.
- Runs polling skips a finished selected run whose cached results were fetched at
  that same terminal status. Entry, run selection, Refresh, approve/reject, cancel,
  recovery and spend continuation still reload explicitly. A terminal transition
  fetches the final results once (the recorded status differs), then polling stops
  when no run is active. Running and paused runs (approvals, spend pauses) reload
  every tick; unchanged results cause no rerender or findings request.
- Findings follow the selected run's own results array, ignore late responses after
  a selection change, and keep the run's previous findings when a request fails.
- `MarkdownText` memoizes detection and rendering per text value.
- `BranchPicker` debounces repository-path lookups by 250 ms (the existing
  repository-path debounce in Workflow generation uses 250 ms), with timer cleanup.

## Measurements (vitest, fake timers, backend spies)

| Scenario                                                             | Before                        | After                       |
| -------------------------------------------------------------------- | ----------------------------- | --------------------------- |
| Finished selected run, another run active, 6 s (entry + 4 polls)     | 5 results, 6 findings fetches | 1 results, 1 findings fetch |
| 5 unrelated run-result cache updates                                 | 5 findings fetches            | 0                           |
| Typing a 10-character repository path (40 ms per key)                | 10 `gitBranches` calls        | 1                           |
| `MarkdownText` with unchanged text: 5 rerenders + Raw/Formatted pair | 7 renders, 8 detections       | 1 render, 1 detection       |

These are request and parse counts, not timings. They do not change model spend.

## Tests

`RunsView.test.tsx` (finished run with another active, unrelated cache updates,
terminal transition, paused spend pause, failed poll, late findings after a switch),
`store.test.ts` (field-wise equality, identity reuse, recorded status, rapid
selection), `Markdown.test.tsx` (parse counts, raw text, escaping, unsafe links,
text updates, collapsed preview), `BranchPicker.test.tsx` (rapid edits, empty
path, stale responses, failure, unmount, branch edits).

## Known limits

- A selected run outside the 100-run list has no known status, so polling still
  reloads it while other runs are active (previous behavior).
- Live output still arrives through polling; Tauri events remain deferred.
