---
title: Runners
---

## Runners

The queue console — the workflows currently executing, waiting, or recently
finished, with their status, name and timing.

This is a level below Runs. A run is the work you asked for; a runner workflow
is the durable execution machinery carrying it out, along with everything else
that executes in the background. When a run is stuck, this is where you find out
whether it's stuck *waiting* or stuck *failing*.

Queue health is the summary at the top. A queue with a growing backlog and
nothing completing is the clearest possible sign that a worker is down.

## When to use this

When background work has stopped happening. Ingest that never finishes, a run
that sits at the same step, a scheduled job that didn't fire — all look
identical from the surface screens and are distinguishable here.

Filter by status first. A wall of `success` with one `error` is a different
problem from a wall of `pending`: the first is a bug in one workflow, the second
is nothing consuming the queue at all.

Timing is worth a glance even when nothing is broken. A workflow whose duration
has crept up is usually a model change or a corpus that's outgrown a query.

## Technical

Workflows are durable: their state is checkpointed, so a process that dies
mid-workflow resumes from its last completed step rather than restarting or
vanishing. That's the property the whole background system rests on, and it's
why a crash during a long run costs you one step rather than the run.

Because execution is checkpointed rather than held in memory, a workflow can
wait indefinitely without consuming anything. A run paused on a question isn't
occupying a worker — it's a row waiting to be woken.

Retries are bounded and recorded, so a workflow that failed three times shows
three attempts rather than one mysterious failure. That distinction matters when
diagnosing: a transient provider error and a genuine bug look identical in a
single-attempt view.

The queue is shared by everything background — ingest, extraction, scheduled
jobs and runs — so a flood in one is visible here as pressure on the others.
