---
title: Runs
toolGroups: [runs]
---

## Runs

A run is work the assistant does in the background when a task is too big for
one reply. The assistant plans it as a tree of steps, some in order and some in
parallel, then stops. The steps execute, and the assistant picks up again when
they are done.

The left side lists your runs. Select one to see its tree: which branch is
slow, which step failed and what comes next. **Cancel** stops a run.

Two banners link to [Pending approvals](pending.md):

- **Budget exhausted**: the run is paused. Raise the budget or cancel it.
- **Waiting on your answer**: a step asked you a question.

A run keeps going if you close the page.

## Assistant

- "Go through last quarter's invoices and pull out anything unpaid."
- "What is that run doing now?"
- "Cancel the research run."

The assistant uses `run_plan`, `run_append`, `run_state`, `run_cancel` and
`run_audit`. The Runner queues group is not given to any agent by default;
grant it in Settings > Agents.

## Technical

Runs are off unless the brain sets `MANTLE_RUNS=1`; until then this screen
says runner queues are disabled. Steps are never edited once created: a new
plan adds steps instead, so the tree is the full record. The assistant resumes
from the run's saved state, not from memory, so a restart or crash does not
change how a run finishes. Exactly one resume fires when a group of steps
completes. Budget and step limits pause a run as a question instead of
stopping it. Execution details are on the [Runners](runners.md) screen.
