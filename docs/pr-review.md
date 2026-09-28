# Review findings

## Finding model

| Field                            | Meaning                                                  |
| -------------------------------- | -------------------------------------------------------- |
| `severity`                       | `P0`/`P1`/`P2`/`P3`/`info` — from the agent's own report |
| `category`                       | free-form bucket (correctness, security, …)              |
| `title` / `explanation`          | human-readable                                           |
| `file`, `line_start`, `line_end` | only when the agent provided them — never fabricated     |
| `confidence`                     | only when the agent stated it                            |
| `source`                         | `nodeId (profile)` provenance                            |
| `suggested_fix`                  | when provided                                            |
| `fingerprint`                    | stable FNV-1a hash for cross-agent dedup                 |

`P0`/`P1` are **actionable** (fix-loop trigger, notification trigger).

## Agent convention

Ask review agents to emit fenced blocks:

````text
```finding
severity: P1
category: correctness
file: src/cart.ts
line: 42
title: Unchecked empty cart
explanation: Checkout proceeds with zero items.
fix: Guard on cart.length.
```
````

The parser is tolerant (multi-line values join, unknown keys ignored, blocks
without titles dropped). Ordinary Agent output stays in the Runs transcript
and formatted report; only valid fenced blocks appear as findings. Locations
are never invented.

## Deduplication

Same fingerprint from Claude and Codex groups into one finding with both
sources listed, sorted P0 → info. The Runs view shows findings per run;
completion with actionable findings raises a notification (opt-out capable).

## Severity honesty

Orchevia does not grade prose. If agents disagree on severity, both findings
stand (different fingerprints) unless textually identical. Tune the review
prompts, not the parser.
