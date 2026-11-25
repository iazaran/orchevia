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
- [x] Dependencies refreshed within their ranges.

## Notes for the next release

- Check `https://iazaran.github.io/orchevia/apt/dists/stable/main/binary-amd64/Packages`
  after each release: a failed Pages run leaves apt on the previous version.
- The run list and run detail are not covered by the shared `--measure`: the
  detail column is meant to use the full width for logs and timelines.
