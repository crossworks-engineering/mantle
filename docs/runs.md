# Runner queues — durable, inspectable execution plans

Design: "Runner queues & worker agents — implementation plan v1" (dev brain).
Status: **slice 1 (the spine)** — schema, engine, dispatcher, sweep, `run_*`
tools, resume turn, read-only run view. Worker agents + audits are slice 2;
`ask_human` gates, budgets, and worker groups are slice 3.

## Concept

When the responder delegates real work it creates a **run**: a tree of **run
items** — structured concurrency with `group_seq` / `group_par` interior nodes
and executable leaves (`tool_call`, `note`; later `worker_invoke`, `audit`,
`ask_human`). Items are **immutable once created** (`payload` never changes);
re-planning supersedes + appends. The queue is the audit log, and the queue is
the memory: the responder suspends while items run and resumes from **compiled
run state** (`run_state`), never from held context.

## The resume-storm invariant

Every child terminal transition increments its parent group's `children_done`
under the parent's row lock (`UPDATE … SET children_done = children_done + 1 …
RETURNING`). Concurrent completions serialize on the lock, so **exactly one**
transaction observes `done == total`, seals the group, transitions it
terminal, and bubbles the same increment into the grandparent. The run's root
completing emits **one** resume job. Guarantees stack: counter → exactly once;
deadline sweep → eventually; pg-boss `singletonKey` → backstop;
`run_items.resumed_at` CAS → at-most-once resume turn.

Proven by `packages/runs/src/engine.test.ts` (gated on
`RUNS_TEST_DATABASE_URL`; self-provisions a scratch database): parallel
completions 2-wide ×12 rounds and 8-wide → exactly one resume, plus seq
promotion, nested bubbling, join policies, sealing, sweep healing, retry, and
cancellation.

## Moving parts

- **`packages/runs`** — the engine. `createRun` / `appendChildren` /
  `claimItem` / `completeItem` / `cancelRun` / `requeueForRetry`; compiled
  state (`compileRunState`, `renderRunStateText`); the sweep (`sweepRuns`,
  `claimResume`); queue names + enqueue helpers. Every transition is a CAS —
  duplicate wake-ups no-op. Engine calls return `PostCommitAction[]`; callers
  enqueue AFTER commit (`enqueueRunActionsSafe`) so pg-boss never observes
  uncommitted state. The table is the truth; jobs carry only ids.
- **`apps/web/workers/runs.ts`** (`worker_runs` container) — pg-boss handlers
  for `mantle.run.tool` (tool/note items), `mantle.run.worker` (slice 2),
  `mantle.run.resume` (responder resume turns), plus the every-minute sweep
  cron: overdue items → `failed(timeout)` (drives the counter — nothing
  wedges); stale `ready` items → re-dispatch (heals a crash between commit and
  enqueue — no outbox machinery); terminal-but-never-resumed roots → resume
  re-send.
- **`apps/web/lib/runs/execute-item.ts`** — item execution through the SAME
  `dispatchTool` executor as the inline loop (one executor, two entry points —
  non-negotiable). Central arg coercion, a `run_item` trace per execution
  (`trace_ref` links item → trace), structured failures
  (`result.failure = {type, message}` — never raw error text into a prompt),
  per-item usage + cost in micro-USD. Semantic retries follow
  `retry_policy.maxAttempts`; **side-effecting items never auto-retry** (both
  retry layers off — failure surfaces for the resume turn to reason about).
- **`apps/web/lib/runs/resume.ts`** — the resume turn: claims
  `resumed_at`, assembles an ordinary responder turn
  (`assembleResponderTurn` + `runResponderLoop`) whose prompt is the compiled
  run state, and records the reply as an outbound conversation turn (no
  synthetic user bubble — the reminders pattern).
- **Tools** (`packages/tools/src/builtins-runs.ts`): `run_plan`,
  `run_append`, `run_state`, `run_cancel` — the `runs` tool group in the
  manifest. Responder-only; a delegated child agent is refused, and `run_*` /
  `invoke_agent` are banned inside items (checked at plan time AND at
  execution — no recursion).
- **Run view**: `/debug/runs` — recent runs + collapsible item tree (states,
  one-line outcomes, per-subtree cost roll-up, trace links).

## Feature gate + dogfood

Dark by default. Enable per brain with `MANTLE_RUNS=1` in the app env (the
`worker_runs` container idles healthy when off). The `runs` tool group is
deliberately **not** attached to the persona in the manifest while dogfooding —
grant it manually on the dev brain (`/settings/tool-groups` or
`agent_grant_tool_group`). Attach it in the manifest when the feature ships.

## Failure semantics (slice 1)

- Leaf deadlines stamp at **promotion** (`payload.timeout_seconds`, default
  600s) so queued seq steps don't burn clock waiting.
- `wait_all` (default): failures are terminal states; the group completes with
  a `{done, failed, cancelled}` summary and state `failed` if anything failed.
- `fail_fast`: first failure cancels pending siblings (counter credited);
  running siblings' late completions no-op at the CAS.
- Confirm-gated (`requires_confirm`) tools can't run headless yet — the item
  fails structured; `ask_human` items (slice 3) become the queue's approval
  path.
- Cancel (`run_cancel`, or the responder Stop signal in a later wiring) marks
  the run first (so no resume), then the subtree.
