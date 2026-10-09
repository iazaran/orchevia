# Run UI polish — v0.1.13

Scope: the four UI notes explicitly authorized on 2026-10-09. Existing components,
Backend methods and stored metadata remain the authority; no new architecture,
provider polling, subscription estimates, workflow schema or engine behavior.

- Notifications: replace opacity transition with left entrance/exit animations;
  hold the final exit position, remove on animation completion, retain a timer
  fallback and reduced-motion support. Warn/error persistence is preserved.
- Usage: trace Claude result `total_cost_usd` to stored `reported_cost_usd`; label
  its value as an API estimate in collapsed details, disclose missing coverage and
  unavailable subscription quota, hide summaries with no finished agent attempts.
  Keep the existing guard calculation and clarify its UI. Source:
  [Claude cost guidance](https://code.claude.com/docs/en/costs).
- Output: remove misleading newline counts; bound all streams in one scroll
  viewport, follow expanded live text, pause on scroll-up and resume explicitly.
  Fix the activity stream's incorrect expansion default on the last step.
- Findings: reuse backend grouping, associate source strings with the latest
  successful result used by native extraction, retain unmatched-source fallback,
  wrap text/code/tables and allow the Runs detail grid column to shrink.
- Release preparation: synchronize application manifests, Cargo.lock, changelog and
  README installer targets to 0.1.13. No publication or installer availability claim.

## Verification

Regression tests cover animation completion and fallback/persistent notifications,
empty/partial usage summaries, output expansion/following/pause/resume and activity,
and findings shared across source agents with retries and unmatched sources.
The independent review's two findings were reproduced and resolved: follow the
terminal response update, and move unverified plain-text dollar hints into the
same usage disclosure. The reviewer rechecked the corrections with 25 focused
tests passing and no remaining P0–P2 findings.

Browser fixture checks at 329px and 1440px confirmed finding cards, long paths,
fenced code and tables stay within their available width with no horizontal page
scroll. Expanded live output follows appended text, pauses when scrolled up and
resumes through Follow latest. Notification entry uses the slide animation and
expiry removes it once. The narrow-width check also caught and fixed a squeezed
detail column by stacking the run list above details below 900px.

All required gates passed on the final implementation:

- `pnpm check`: matching 0.1.13 versions, Prettier, ESLint, TypeScript, 15 delivery
  tests and 267 frontend tests. The delivery fixture's Git subprocess required an
  unsandboxed rerun; its disposable repository remained under `/tmp`.
- `cargo test -p orchevia-core`: 362 tests passed.
- `cargo clippy -p orchevia-core --all-targets -- -D warnings`, `cargo fmt --check`
  and `cargo check -p orchevia` passed.
- `pnpm build` passed; the existing large-bundle warning remains.
- `git diff --check` passed. Temporary browser fixtures were removed.

No native GUI, authenticated provider execution, subscription quota integration
or installer/release publishing was performed.
