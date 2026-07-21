# ADR: Durable-execution substrate for runner queues

- **Status:** accepted (2026-07-21); slice-3 re-evaluation WRITTEN — see
  [runs-slice-3-plan.md](runs-slice-3-plan.md) (hybrid proposed as the
  intended end state: spine stays on tables, turns move to DBOS; `ask_human`
  and budget-pause assessed and kept on the table engine). Awaiting Jason's
  plan audit + final implementation decision (plan §7).
- **Context:** runner queues slices 1+2 ([docs/runs.md](runs.md)), pre-deploy
  audit ([docs/runs-audit-handover.md](runs-audit-handover.md) §8)
- **Decision owners:** Jason (release gate), recorded by the audit session

## Context

Mantle has **two durable-execution substrates**, and the runner-queue system
(slices 1+2, `packages/runs`) was built on one without a recorded decision
against the other:

1. **DBOS** (`@dbos-inc/dbos-sdk`, `apps/api`) — the durable engine for agent
   turns. Assistant/telegram/team/forum turns run as DBOS workflows; every
   LLM call and tool dispatch is a journaled step via the `withDurableSteps`
   seam in `@mantle/tracing`; a crash mid-turn resumes from the last completed
   step; recovery is automatic; queues support concurrency caps and
   partitioning.
2. **pg-boss** (`apps/web/workers/*`) — the job-queue idiom of the worker
   fleet (email-sync, telegram-poll, maintenance, …): plain queues + cron,
   jobs as disposable wake-ups.

The runs engine chose the pg-boss idiom and hand-rolled durability on top of
it: the `children_done` completion counter under the parent row lock
(exactly-one-resume), CAS discipline on every transition, post-commit action
choreography (`enqueueRunActionsSafe`), the minutely sweep (deadline
timeouts, lost-dispatch heal, lost-resume heal), the `resumed_at` claim
(migration 0130), and semantic retry requeue. That machinery is roughly half
of `engine.ts` plus all of `sweep.ts` and `boss.ts`, and it re-implements —
beside an already-deployed engine — what that engine is for.

The pre-deploy audit (handover §8) found its defects concentrated exactly
there: a lock-order deadlock between completion and bulk cancellation, a
resume token burned before turn preconditions, CAS results ignored by
verdict recording. None were in the product-shaped parts (tree model, plan
parser, audit contract, mechanical evidence, compiled state, accounting).

## Decision

**Runs v1 (slices 1+2) stays on pg-boss + the hand-rolled CAS/counter
engine.** The audit fixes land in place; no rewrite before first dogfood.

**Slice 3 is the re-evaluation gate**, with a standing bias: features that
are suspension-shaped go to DBOS rather than growing the hand-rolled engine.

**Worker turns move to the DBOS turn runner when convenient** (independently
of the engine question): `execute-worker.ts` runs a whole LLM turn with no
mid-turn durability today, while `apps/api` already durably executes exactly
this shape (`assistant-turn.ts`). Running the worker turn as a DBOS workflow
gives per-tool crash-resume for free and touches no engine invariant — the
item still claims/completes through `packages/runs` either side of the turn.

## Rationale

Why not rewrite now:

- Slices 1+2 are code-complete; the hardest invariant (exactly-one-resume)
  is proven by 20 DB-backed tests including forced races. The audit findings
  are <100-line fixes; a rewrite trades tested machinery for fresh
  integration risk on the eve of dogfood.
- The tree is the **product**, not just the mechanism: `run_items` is
  simultaneously executor, audit log, run view, `run_state` projection, and
  acceptance metric. Driving execution from the same rows guarantees the
  view never lies. Under DBOS, truth moves into its journal and `run_items`
  becomes a write-behind projection that *can* drift.
- Mid-flight mutation from other processes (`run_append`, `run_audit`,
  `run_cancel` are called by the responder in the web process against a
  running run) maps to `DBOS.send`/`recv` message-passing — supported, but
  the "structured concurrency is just `Promise.all`" simplification gets
  qualified once appends and verdicts arrive as messages.
- Fleet deploys: DBOS pins workflows to code versions; the table-driven
  state machine is version-agnostic — a mid-run deploy on a self-hosted box
  picks up where the rows say. With four boxes rolling on cadence, that
  matters.

Why the slice-3 gate, and the bias toward DBOS there:

- Slice 3's features — `ask_human` (suspend awaiting a human),
  `budget_micro_usd` auto-pause (suspend mid-run), worker groups/panels —
  are **headline DBOS capabilities** (durable sleep, messaging,
  human-in-the-loop). Built on the current engine, each becomes another
  sweep duty and another CAS dance; the hand-rolled surface grows
  superlinearly.
- The repo's own "one executor, two entry points" principle, applied one
  level up, argues against maintaining two durability substrates
  indefinitely. If slice 3 lands on the hand-rolled engine anyway, that is a
  deliberate "we own a durable-execution engine, on purpose" commitment and
  should be recorded here as such.

## Consequences

- The counter/sweep/CAS machinery is **owned code**: reviewers should treat
  `engine.ts`/`sweep.ts` lock ordering as a hazard zone (see the run-row
  lock ordering rule added by the audit fixes — every multi-lock transaction
  acquires the run row first).
- A v2 engine, if it ever happens, targets DBOS workflows in `apps/api`
  with `run_items` demoted to the audit-log projection; the `run_*` tool
  surface and compiled-state contract are stable and survive either
  substrate.
- The worker-turn migration to the DBOS runner is pre-approved in principle
  and can ship in any slice without revisiting this ADR.
