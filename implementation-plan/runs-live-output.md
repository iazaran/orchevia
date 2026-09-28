# Live Runs output and answer formatting

Command and Agent nodes now create a durable `running` result before executing.
The existing pipe capture updates stdout and stderr on that row about every
250 ms when new bytes arrive. Final status replaces the same row, including
retry attempts and partial output from cancellation or timeout. Startup
recovery closes interrupted running rows while keeping captured text. The
browser mock mirrors running rows for Command and Agent steps before and after
an approval.

Runs already polls results every 1.5 seconds. Long formatted output now stays
inside scrollable regions. Only explicit fenced review findings enter the
findings list; ordinary answers remain available in the report and step output.

Verification on 2026-09-24: `pnpm check` passed (86 frontend tests),
`cargo test -p orchevia-core` passed (223 core tests), Clippy, Rust format,
Tauri check, and `pnpm build` passed. The build retained its existing Vite
mixed-import and bundle-size warnings. Native GUI inspection was unavailable
through the connected computer-use surface; the Rust integration test proved
that output is queryable while a process still runs.
