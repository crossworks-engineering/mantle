---
title: Runs
toolGroups: [runs]
---

## Runs

Work the assistant is doing in the background, as a tree you can read.

When a task is too big for one reply, the assistant plans a **run**: a structure
of steps, some sequential, some parallel, each one a concrete piece of work. It
then suspends. It is not sitting there holding the conversation in memory —
it stops, the steps execute, and it resumes when they're done.

That's why the tree is worth reading rather than glancing at. It's not a
progress bar; it's the actual plan, and you can see which branch is slow, which
step failed, and what the assistant intends to do next.

Runs can be cancelled from here, and a run waiting on a question shows what it
asked.

## Assistant

- "Go through last quarter's invoices and pull out anything unpaid."
- "What's that run doing now?"
- "Cancel the research run."

Two things follow from how runs work. A long run **keeps going if you close the
page** — it's durable, not tied to your session. And a run that needs your input
will stop and ask rather than guess; those questions arrive on the pending
screen.

## Technical

Run items are **immutable once created**. Re-planning supersedes and appends
rather than editing, so the tree is a complete history of what was intended as
well as what happened. The queue is both the audit log and the memory.

Resumption reads **compiled run state**, never held context. That's the design
decision that makes durability real: the assistant doesn't need to have been
alive while the steps ran, so a restart, a crash or a week's gap changes
nothing about how a run finishes.

Exactly one resume fires when a run completes, guaranteed by a counter each
child increments under its parent's row lock — so of many steps finishing at
once, precisely one transaction observes the group as done and seals it.
Several further guards stack behind that, because a duplicated resume would
mean the assistant acting twice on the same result.

Budget and item caps pause a run rather than killing it, so an over-running job
becomes a question you answer instead of work silently thrown away.
