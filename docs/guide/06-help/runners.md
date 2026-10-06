---
title: Runners
---

## Runners

This is the console for the durable workflow engine: every workflow that is
queued, running or finished, with its status, name and timing. Use it when
background work has stopped: a run stuck on one step, or a job that never
finished.

- The strip at the top shows queue health: how many workflows wait and how
  many run. A growing queue with nothing running means no worker is taking
  work.
- Filter by status, name and time window (1h to 7d, or All).
- Select a workflow to see its steps and the controls that fit its status:
  **Cancel** a running one, **Resume** a failed or cancelled one from its last
  finished step, **Restart** it from the start, or **Fork from step** to start
  a new copy from a chosen step.

Filter by status first. Many `SUCCESS` and one `ERROR` points at one broken
workflow. A wall of `ENQUEUED` means nothing is taking work.

## Assistant

The assistant has no tools for this screen. For the work it plans in the
background, ask about the run instead (see [Runs](runs.md)):

- "What is the invoice run doing now?"
- "Cancel the research run."

## Technical

Workflows run on DBOS, which saves each finished step. A process that dies
mid-workflow resumes from its last finished step instead of starting over. A
waiting workflow holds no worker; it is a row until something wakes it.
`MAX_RECOVERY_ATTEMPTS_EXCEEDED` means the engine gave up recovering it after
repeated crashes. Restart and Fork from step create a new workflow with a new
id. This screen never deletes a workflow.
