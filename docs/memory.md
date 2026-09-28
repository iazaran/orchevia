# Workflow generation, templates & memory

Orchevia feels personal without owning an AI connection: a configured local
agent drafts workflows, versioned templates capture good shapes, and memory is
an inspectable preference table — all local.

## Describe what you want to do

Workflows → goal bar → pick the **Workflow Generator** profile (any profile
with the `workflowGenerator` role, or any profile you trust for planning) →
Generate. Orchevia:

1. Sends a constraining prompt (schema, known kinds, bounded numbers, role
   refs — never raw profile ids).
2. Extracts JSON (fenced block preferred, brace fallback; prose never runs).
3. Compiles: known kinds only, bounded numerics, valid edges, role
   resolution, full validation, risk analysis.
4. Shows a preview: steps, resolved tools/profiles, unavailable deps, risky
   writes, warnings, the model's own explanation.
5. **Never auto-runs.** Accept opens the graph for editing; Retry re-asks;
   Discard records the outcome in generation history.

The generator cannot invent executable kinds (`shell` rejected), credentials,
unlimited loops, hidden triggers/schedules, or path-like commands (bare tool
names only — edit explicitly if you mean otherwise). Generated Command nodes
surface as risky writes in the preview. Ticket/MCP nodes are never generated
with servers bound — add them explicitly after preview.

## Role resolution

Proposals and templates reference logical roles (`planning`,
`implementation`, `fastReview`, `deepReview`, `workflowGenerator`), resolved
from your profiles (first profile per role) plus accepted role preferences
(explicit profile roles win). Unmapped roles block acceptance with a message
naming the role — never silently.

## Templates

Eight built-ins: Implement Ticket, Review Pull Request, Investigate Bug,
Refactor, Dependency Upgrade, Run Multi-Agent Review, Create Draft PR, Watch
Review Feedback. Versioned (`v1` schema) and cloneable:

- **Use** instantiates with your role map (fresh ids), reporting setup steps
  (repo dirs, server picks) instead of failing.
- **Save as template** converts a workflow back to roles where profiles have
  roles (portable across machines).
- **Import/export** is validated JSON; credential-like content is refused on
  both paths. Templates carry no secrets by construction.

## Memory (structured preferences)

Examples: default profile per role, `pr.startAsDraft`, commit-only-after-tests,
fix-loop on P0/P1, max review cycles, prefer worktrees, learning toggle.

- **Observe:** role-default changes (and other mapped edits) count toward a
  suggestion after **3 consistent** occurrences.
- **Suggest:** pending items appear in Memory with their evidence note.
- **You decide:** accept, reject (never re-asked until reset), edit, disable
  per item, or reset everything.
- **Scope:** global (`*`) or per workflow type; explicit maps beat preferences.
- **Export/import:** portable JSON with a credential scan on import.
- **Retention:** generation history keeps the last 100 (setting
  `history.generations`, 10–1000).

No vectors, no hidden profile, no telemetry: open Memory and read exactly what
Orchevia believes. Data lives in SQLite (`preferences`, `observation_counts`,
`generations`, `user_templates`); export from Memory; profile references stay
local (re-map by name after moving machines).
