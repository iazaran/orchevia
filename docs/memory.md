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
`implementation`, `fastReview`, `deepReview`, `workflowGenerator`,
`workflowAssistance`), resolved
from accepted global role preferences referencing existing profiles, then the
first configured profile per role. An explicit node profile or exact unique
`profileName` takes precedence over this fallback. Unmapped roles block acceptance with a message
naming the role — never silently.

## Templates

Nine built-ins: Implement a Task, Review Pull Request, Investigate Bug,
Refactor, Dependency Upgrade, Run Multi-Agent Review, Create Draft PR, Address
Review Feedback, and Ticket to Draft PR. Versioned (`v1` schema) and cloneable:

- **Use** asks for the repository folder (and the Jira/MCP server for ticket
  steps), lists the inputs each run asks for and any tool permissions the mapped
  profiles lack, then instantiates with your role map (fresh ids). Every step works
  in that repository.
- Each built-in asks for what it needs as run inputs (task, bug, PR number, test
  command, branch, base branch), declares the tools its implementation steps need,
  and is replayed end to end in the core tests with stub CLIs.
- **Save as template** keeps exact choices locally. Portable export uses roles
  and exact unique profile names; configure the corresponding profiles on import.
- **Import/export** accepts a supported plain Simple/Advanced workflow document
  directly as a new template, or an existing template envelope. No selected
  workflow is needed. Structural/semantic errors leave the source available for
  correction. Machine-only profile IDs need a configured profile or portable role.
  JSON is validated; credential-like content is refused on
  both paths. Templates carry no secrets by construction.

## Memory (structured preferences)

Examples: default profile per role, `pr.startAsDraft`, commit-only-after-tests,
fix-loop on P0/P1, max review cycles, prefer worktrees, learning toggle.

- **Observe:** role-default changes (and other mapped edits) count toward a
  suggestion after **3 consistent** occurrences.
- **Suggest:** pending items appear in Memory with their evidence note.
- **You decide:** accept, reject (never re-asked until reset), edit, disable
  per item, or reset everything.
- **Scope:** global (`*`) and repository playbooks (`repo:<canonical directory>`).
- **Export/import:** portable JSON with a credential scan on import.
- **Retention:** generation history keeps the last 100 (setting
  `history.generations`, 10–1000).

No vectors, no hidden profile, no telemetry: open Memory and read exactly what
Orchevia believes. Data lives in SQLite (`preferences`, `observation_counts`,
`generations`, `user_templates`); export from Memory; profile references stay
local (re-map by name after moving machines).

The Templates library includes nine language-neutral starters in desktop and
browser preview. Test steps require your project's `testCommand`; blank values
cannot run. Clone a starter and edit it with Simple JSON, or save a configured
workflow as a user template. Portable export retains explicit reviewer names.

## Project playbooks

Open Memory, choose the repository, and Load playbook to edit saved knowledge.
Save test/lint/build commands, repository conventions, exact reviewer names,
or a user-template reference with an evidence note. Existing preference controls
let you edit, disable, delete, export, import, or reset records. Select the global
default deep reviewer explicitly when several profiles share the role.

Repository keys use FNV-1a64 namespacing with the canonical directory retained
as scope. Collisions are refused; imports validate every record and commit as one
transaction. Values are scalar, project fields are strings; key/scope/value/note
limits are 120/600/4000/4000 characters. Credential-like values or evidence are
refused consistently by manual saves, imports and observations.

New or changed Command nodes labeled test, lint, or build count as concrete
edit observations for that repository. Three matching targets suggest a record;
no automatic acceptance occurs. Rejected keys stay quiet until reset. Changing
repository defaults does not carry edit observations into a new project. Profile
role changes follow the existing global observation flow.

Runs exposes Save command to playbook only for a successful Command in a
successful run, inside that step's card under **Save this command to the project
playbook…**. It fetches that run's snapshot and latest result again, retains
argument quoting and working directory, and records the run ID as evidence.
Process output is never copied. Commands with unresolved node-output variables
cannot be promoted. Save a useful graph as a user template, then link it from the
playbook's Reusable workflow template field.

Generator → Included project memory previews enabled manual/accepted global
and selected-repository records (bounded to 16000 characters). Suggestions,
rejections, disabled values and other repositories are excluded. Explicit goal
instructions win; commands require repository verification and ordinary preview
and Run approval. Browser preview persists templates, preferences and observation
counts using guarded storage. Browser paths normalize syntactically; desktop
paths resolve filesystem aliases through canonicalization.

JSON and inspector saves share the command-observation path. A node-specific
working directory is preserved as an explicit `cd` prefix in suggested command
text, so accepting a command learned in a repository subdirectory keeps its
execution context.

## Improve an existing workflow

Workflows → Assist drafts **Optimize workflow** or **Arrange layout only** using
a selected local CLI profile. Supply developer instructions, then review the
actual configuration, graph, inputs and position changes before Apply. The same
workflow identity is retained; application never runs it. Editing, deleting or
switching the source while the proposal is pending requires a fresh proposal.

The draft includes the complete saved definition, internal generation rules,
accepted/enabled global and same-project memory, and bounded errors/stderr from
the latest run of that workflow in the same canonical repository. Successful
retry attempts replace earlier failures; stdout and run inputs are excluded.
The CLI runs in the selected repository without changing its profile defaults.
Ambiguous repository scope uses global memory only and excludes unrelated run
context. Explicit developer instructions take priority.

Arrange retains all execution configuration and changes positions only. Optimize
retains existing node IDs/types, inputs, profile/server bindings and advanced
configuration; removing steps or changing kinds requires manual editing. Proposals
that exceed the context limit fail with guidance instead of silently losing steps.
Project observations remain pending until reviewed; assistance does not create
automatically accepted error notes.
