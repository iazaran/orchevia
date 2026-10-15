# v0.1.15 implementation outcome

UI maintenance release: usage reporting polish, Inbox run navigation, and
restrained shared UI polish. Implemented on branch
`opencode/v0.1.15-ui-polish-and-run-navigation` from base `3acb4718`
(origin/main, including merged PR #32 plus dependency updates #30/#31).
Application version `0.1.14` → `0.1.15`. Workflow schema unchanged (no bump).

## Delivered

1. **Daily activity chart** (`UsageView.tsx`, `styles.css`): bounded-height
   panel (240px SVG, height never grows with short ranges), labeled Agent
   attempts axis with integer ticks (1/2/5 steps), gridlines, zero baseline,
   capped bar widths (34px), adaptive date-label density (~10 labels), UTC-day
   grouping stated next to the chart, zero-filled calendar days (backend only
   returns active days) so sparse activity never implies consecutive dates, no
   bar for zero attempts, and an expandable daily table (day/runs/attempts/
   reported-USD-subtotal) as the accessible value source. Daily USD keeps its
   reported-subtotal meaning with an explicit incomplete-coverage note.
2. **Usage hierarchy**: short cost/coverage intro with the rest in a "What each
   figure means" disclosure; Last-7/30-day presets, reset-filters, inline
   reversed/invalid-date validation that blocks the request; six one-value
   overview cards (runs, attempts, estimated API value, tool calls, subagents,
   reused) each with CLI-reported coverage beside the figure and technical
   counting notes in a disclosure; one tabbed breakdown (Workflow / AI profile
   / Provider & model); thousands separators, right-aligned tabular numerals,
   two-decimal USD with exact precision in tooltips (`< USD 0.01` floor so small
   positives never read as zero); `Unknown USD` renamed to `Attempts missing
   USD`; measured-zero vs partial vs unknown distinguished per figure;
   provider rows show only reported cache/reasoning metrics with full counters
   behind a per-row disclosure (nothing invented from missing data).
3. **Subscription settings**: `.field`-grid forms with visible labels above
   controls, narrow amount/percentage inputs, fee/extra rows as a readable
   table (label, amount, period, allocation status, Remove with confirmDialog),
   legacy/outside-allocation entries preserved, UTC billing semantics kept,
   dirty tracking with Save disabled while clean/saving, "Unsaved changes"
   hint, stale "saved" feedback cleared on edit, all-or-nothing success claim,
   drafts preserved on failure. Sections render even with no matching history.
4. **Inbox navigation** (`store.ts`, `InboxView.tsx`): new `openRunInRuns`
   store action fetches by run ID (works outside `listRuns(100)` and for runs
   whose workflow was deleted — only the run row is read), commits view/runs/
   selection/results under navigation+selection sequence guards, and returns
   false (no commit) when superseded. `refreshRuns` retains the selected run by
   fetching it when absent from the recent list. Inbox uses an inbox-specific
   kind/content/actions layout (shared `.run-row` untouched), restrained
   read/unread treatment (accent edge + marker, no whole-card dimming),
   per-item pending with a ref guard against duplicate clicks, mark-read only
   after committed navigation, errors leave the item unread. Canvas overlay
   path (`openRunOnCanvas`, Show on canvas) unchanged.
5. **Shared polish** (`styles.css`): table header treatment + row hover,
   numeric `.num` columns, active tab state, light-theme form-error color,
   inbox/chart/form styles in existing variables. No redesign, no new deps.

## Contract notes

- No backend contract changes: `getRun`/`getRunResults`/`listRuns`/
  `usageSummary`/settings already covered everything; MockBackend semantics
  untouched. `openRunInRuns` composes existing Backend methods.
- Money lanes stay separate; no forecasts, savings claims, or fee-vs-estimate
  comparisons added. Screenshot labels/prices/dates were fixtures only; no
  hardcoded provider data entered the code.
- Test-only discovery: zustand `setState` merges copy spied store methods into
  new state objects, so `restoreAllMocks` alone cannot un-spy after a store
  write — `InboxView.test.tsx` reseeds pristine store methods in `afterEach`.

## Verification

- `pnpm vitest run`: 318 passed (13 UsageView incl. chart/validation/save
  failure/coverage, 7 InboxView incl. exact-run/outside-100/orphan/missing/
  dedup, 25 store incl. navigation race + refresh retention).
- Browser verification with seeded mixed-provider/partial fixtures in
  `pnpm dev` + system Chrome: 1685×1000, 1280×800, 960×600, dark + light,
  keyboard-focus ring; chart geometry asserted (240px SVG, capped widths,
  30-row table). Shots in `/tmp/opencode/shots/` (scratch, not committed).
- Full gate before handoff: `pnpm check`, `pnpm build`,
  `cargo test -p orchevia-core`, clippy `-D warnings`, `cargo fmt --check`,
  `cargo check -p orchevia`, `cargo test -p orchevia`,
  `pnpm version:check v0.1.15`, `git diff --check`.

## Remaining limits

- Browser/mock validation only: no installed-desktop check, no paid CLI
  sessions, no real provider data (all usage figures above are mock/seeded).
- CSS layout correctness is asserted by screenshot inspection, not jsdom.
- Daily table caps its zero-filled span at 366 days with an explicit note.
- Toast popups from the app's 5s notification poll are a separate pre-existing
  behavior, unaffected by the Inbox layout change.
