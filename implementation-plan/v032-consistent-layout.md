# Orchevia 0.3.2

Feedback on 0.3.1: make the layout consistent across views, make a finished
run's progress read as finished, and fix apt upgrades and two site details.

## Implementation and handoff

- [x] Shared layout in `src/styles.css`: `--measure` (760 px) for prose
  (`.section-hint`), single panels (`.section-panel`) and empty states;
  `.section-actions` is a row under the hint, never pushed right. Views use
  `.section-title` instead of inline heading sizes; the centred
  `.playbooks-view` padding and `.section-row` are gone. `src/styles.test.tsx`
  pins the left edge, the shared width and the absence of inline section sizes.
- [x] Toolbar order on every view: actions, then `View →` links (ghost), then
  Refresh. Clear finished is `danger-hover`.
- [x] Run progress: `runProgress` reports `rejected` apart from `failed`; the run
  header (`RunFacts`) uses it whenever the run workflow is known, so header and
  bar count the same working steps. `.seg-skipped` is a hatched success tint.
- [x] Theme switch: `Segmented` with `segmented-fill` (equal options, full
  width). Usage Breakdown keeps its tab semantics with the segmented look.
- [x] `.field-label-row` for a label with a compact action (BranchPicker).
- [x] Pages deploy retries (PR #58): a short wait and up to three attempts, and
  one artifact name per run attempt so re-runs work. Site: demo log height
  follows the graph, apt commands wrap in a full-width card.
- [x] Notices: a repeat of a visible message (same text and variant, from
  `<Notice>` or a plain-string `pushUiNotice`) updates it in place with a new
  `revision`, which restarts its lifetime without remounting the element. Only
  the text span is re-keyed, so screen readers announce the repeat and it flashes
  once. The previous copy's `onDismiss` is not called: after a remount it belongs
  to an unmounted `<Notice>` whose owner has just set the same message again.
- [x] Dependencies refreshed within their ranges.
- [x] Review (two independent reviewers). Fixed: cancelled steps counted as
  failed in the header; a correction round dropped a skip the engine keeps;
  replaced notices unmounted a focused Dismiss button; plain-string notices still
  stacked; Start → End runs showed "Steps 2"; pre-snapshot runs were counted
  against today's workflow; the seven Usage totals wrapped at 1280 px; "→" was
  read as part of button names; layout and apt tests that would pass on the
  regressions they describe; a test that failed lint. Second round: a repeat
  after a remount cleared its owner's message; "Steps" stayed "…" when the run's
  workflow could not be read; an in-place repeat was silent to screen readers;
  the fallback count counted rows and Start/End instead of steps.

## Notes for the next release

- Check `https://iazaran.github.io/orchevia/apt/dists/stable/main/binary-amd64/Packages`
  after each release: a failed Pages run leaves apt on the previous version.
- The run list and run detail are not covered by the shared `--measure`: the
  detail column is meant to use the full width for logs and timelines.
- A run from before workflow snapshots whose workflow later gained a step is
  still counted against today's workflow (the bar shows it unfinished). Telling
  snapshot from fallback needs the backend to say which one `get_run_workflow`
  returned.
- Live progress during a loop still credits a gate from the previous pass until
  the gate runs again (since 0.2.0): the scheduler resets loop nodes but writes
  no row for that, so `runProgress` cannot see it. Exposing the reset would fix it.
