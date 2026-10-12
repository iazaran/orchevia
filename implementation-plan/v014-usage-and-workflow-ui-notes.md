# v0.1.14 implementation outcome

Companion to `v014-usage-and-workflow-ui.md` (the brief). Implemented on branch
`opencode/v0.1.14-usage-and-workflow-ui` from base `2c7df2ad` (main, PR #29).

## Delivered

1. **Unified floating start-run form** (`StartRunDialog`): inputs, dry-run
   fixtures and per-run limit overrides in one Start/Cancel modal. The inline
   inputs panel and the separate run-options dialog are gone; **Run options**
   is now **Usage limits** (saved workflow limits). Every run snapshots
   resolved limits; overrides never persist as saved settings.
2. **Connection highlight**: hovered/focused nodes add `edge-connected` to
   directly connected edges (stroke width + glow only). Includes keyboard focus
   via the node component; cleared on exit, deletion and workflow switch.
3. **Usage limits + policy + analytics**: enforced Agent-attempt budget with
   dispatch reservation, durable usage pauses, explicit extension, approval
   isolation and recovery accounting; single injected policy per Agent
   invocation; honest per-adapter capability labels; `usage_summary`,
   `continue_usage_run` and `adapter_capabilities` commands with mock twins;
   **Usage & costs** page with filters, chart, tables, subscription/estimate
   allocation lanes and Insufficient-history honesty.
4. **Viewport persistence**: per-workflow `{x, y, zoom}` in guarded localStorage,
   synchronous restore, measurement-aware centered fit fallback, snapshot
   isolation, corruption tolerance.

## Contract notes

- Workflow schema stays v6 (all additions optional). Document v1 Simple JSON
  carries `limits` plus `maxToolCalls`/`maxSubagents` node keys. Assistance
  preserves base limits/allowances. New `usage.*` settings keys (8000-byte cap,
  others stay 200).
- Enforced: Agent attempts per run, spend-estimate pause (overshoot possible).
  Advisory: turns/tools/subagents. Unsupported: Codex spend, custom/text
  internals. Guard-paused nodes never succeed, approve, publish or contribute
  findings.

## Verification

- `pnpm check`, `cargo test -p orchevia-core`, `cargo clippy`, `cargo fmt
  --check`, `cargo check -p orchevia`, `pnpm build`, `git diff --check`.
- Native enforcement proven with deterministic fixture CLIs (no paid runs);
  analytics over 60 native rows and 55 mock runs (never a capped list).
- Browser/mock inspection at desktop and narrow widths; real-CLI execution not
  performed here (fixture CLIs stand in).
