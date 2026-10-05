# Setup and notification polish — v0.1.9

Scope: the five new testing notes collected on 2026-10-05. The bottom-left message
stack supersedes the earlier top-right Saved placement. Previous withdrawn notes
are not part of this change.

## Implementation

1. Fix the native settings allowlist for `workflow.assistanceProfileId`, using the
   existing settings commands and SQLite access. Mirror access, interval/value
   validation and settings persistence in the browser mock.
2. Reuse the existing Zustand store, Notice and CloseButton for one body-portal
   message stack: no layout space, above dialogs, 200 ms fade transitions,
   five-second information expiry, persistent user-dismissible warnings/errors,
   bounded scrollable content and reduced-motion support. Preserve view changes
   and avoid re-emitting unchanged JSX messages on unrelated renders. Explicit
   action identities allow identical retries to emit again after dismissal.
3. Emit Saved only after a current draft saves successfully. Keep failed drafts
   and Retry save. Apply explicit severity to action feedback and move workflow
   validation messages into the shared stack. Preserve structured previews,
   historical run detail and reference prose as contextual content.
4. Show selected agent profile/CLI/model/effort and explicitly describe unresolved
   roles, absent selections and missing profile IDs. Clear a role on manual profile
   selection; show the profiles chosen on template use. Match native alphabetical
   role-default fallback in the mock backend.
5. Put automation status badges and shared delete buttons in the same flex row.
6. Poll Inbox updates through Backend while the app is open. Show new events once
   with appropriate severity; retain Inbox read state/history and do not replay the
   initial snapshot. Include message dismiss controls in modal keyboard navigation.

## Verification

Targeted tests cover native assistance setting round-trip and unknown-key
rejection, mock validation/persistence, explicit profile display and unresolved
role removal, mixed-case native role-order parity and role-default template use, aligned automation controls, notification
expiry/persistence/stacking, unchanged-render deduplication, modal keyboard access without background focus escape, persistent scheduler
errors, contextual automation help, repeated action errors,
autosave retry, and new Inbox event deduplication.

Required gates: `pnpm check`, `cargo test -p orchevia-core`, core Clippy with warnings
as errors, `cargo fmt --check`, `cargo check -p orchevia`. Also run desktop command
tests, frontend build, diff review and browser visual checks before PR handoff.

## Release preparation

The user requested v0.1.9 for this PR. Move its changelog items into a dated
0.1.9 entry, synchronize package/Tauri/core versions and the two workspace Cargo
lock entries, and update README platform links plus release commands to v0.1.9.
The README labels those links as release targets until the tag workflow publishes
all four installers and SHA256SUMS; published v0.1.8 remains available meanwhile.
Do not change historical v0.1.8 implementation notes or registry dependency
versions. Validate version consistency against the exact v0.1.9 tag and update the
documentation contract test for prepared, rather than published, installer links.
