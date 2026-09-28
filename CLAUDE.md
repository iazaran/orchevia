# CLAUDE.md

Orchevia contributor notes for Claude (and any coding agent). The full,
binding version lives in [AGENTS.md](./AGENTS.md) — read it first; the points
below are the ones agents most often get wrong here.

1. **Validate everything, weaken nothing**: `pnpm check`, `cargo test -p
orchevia-core`, `cargo clippy -p orchevia-core --all-targets -- -D warnings`,
   `cargo fmt --check`, `cargo check -p orchevia`.
2. **UI never touches processes or SQLite** — go through `Backend`
   (`src/lib/backend.ts`) and add a mock twin with identical semantics.
3. **Mirror the contract**: serde `camelCase` both sides, matching
   `CURRENT_SCHEMA_VERSION`, matching validation codes/fallbacks. Tests pin the
   parity — update both sides together.
4. **No native dialogs ever** — `confirmDialog()` only. Modals/dismiss language:
   `.modal-dismiss`, `.card-dismiss`, `.notice-dismiss` + `.has-dismiss`.
5. **Prettier + strictest TS** (`exactOptionalPropertyTypes`,
   `noUncheckedIndexedAccess`, eslint `--max-warnings 0`). No
   `expect()`/`unwrap()` outside tests.
6. **Tests for every behavior change**, docs (`CHANGELOG.md`,
   `implementation-plan/`, `ROADMAP.md` when direction changes) with it.
