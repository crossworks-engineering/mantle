# Runner queues — durable, inspectable execution plans

Design: "Runner queues & worker agents — implementation plan v1" (dev brain).
Status: **slices 1 + 2, plus slice 3 WP1** — the spine (schema, engine,
dispatcher, sweep, `run_*` tools, resume turn, run view), worker agents +
audits (per-run concurrency cap, model inheritance, mechanical evidence,
resume-driven audit verdicts with a one-redo cycle, the per-worker acceptance
metric), durable turns (worker turns AND resume turns execute as DBOS
workflows in apps/api — slice-3 plan §4 WP1/WP2), `ask_human` gates (WP3 —
human questions as run items, answered via pending approvals), and budget /
item-cap auto-pause (WP4). Worker groups (WP5) close out slice 3
([runs-slice-3-plan.md](runs-slice-3-plan.md)).

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
  for `mantle.run.tool` (tool/note items), `mantle.run.worker` (claim under
  the cap + hand off to DBOS), `mantle.run.resume` (relay the wake-up to
  DBOS), plus the every-minute sweep cron: overdue items → `failed(timeout)`
  (drives the counter — nothing wedges); stale `ready` items → re-dispatch
  (heals a crash between commit and enqueue — no outbox machinery);
  terminal-but-never-resumed roots → resume re-send.
- **`apps/web/lib/runs/execute-item.ts`** — item execution through the SAME
  `dispatchTool` executor as the inline loop (one executor, two entry points —
  non-negotiable). Central arg coercion, a `run_item` trace per execution
  (`trace_ref` links item → trace), structured failures
  (`result.failure = {type, message}` — never raw error text into a prompt),
  per-item usage + cost in micro-USD. Semantic retries follow
  `retry_policy.maxAttempts`; **side-effecting items never auto-retry** (both
  retry layers off — failure surfaces for the resume turn to reason about).
- **`apps/api/src/workflows/runs-resume-turn.ts`** — the resume turn, durable
  since slice 3 WP2: an ordinary responder turn (`assembleResponderTurn` +
  `runResponderLoop`) whose prompt is the compiled run state, run as a DBOS
  workflow. `claimResume` is a JOURNALED step placed after the fallible
  preconditions (the v0.157.5 ordering — a precondition failure leaves the
  wake-up re-sendable) and the outbound `recordTurn` is journaled too, so a
  crash mid-turn resumes without double-posting. Enqueued with
  `deduplicationID = groupId` (one queued resume per group; no fixed
  workflowID — a failed-without-claiming workflow must stay rescuable by the
  sweep's re-send).
- **Tools** (`packages/tools/src/builtins-runs.ts`): `run_plan`,
  `run_append`, `run_state`, `run_cancel` — the `runs` tool group in the
  manifest. Responder-only; a delegated child agent is refused, and `run_*` /
  `invoke_agent` are banned inside items (checked at plan time AND at
  execution — no recursion).
- **Run view**: `/debug/runs` — recent runs + collapsible item tree (states,
  one-line outcomes, per-subtree cost roll-up, trace links).

## Workers + audits (slice 2)

- **Workers are templates, not processes** (`agents.role = 'worker'`,
  migration 0131): each `worker_invoke` item spawns a fresh agent turn from
  the template — model, kit, instructions. The default "Worker agent" is
  ensured lazily on first use (`ensureWorkerAgent`; deliberately not in the
  manifest while dark). `model = 'inherit'` (the default) runs the step on
  the RESPONDER's model/provider/key at execution time; pointing a duplicate
  worker at a cheaper model is the opt-in cost knob, justified by its
  acceptance rate. Routing is per step (`worker: '<slug>'` in the plan node);
  adding a worker never changes behavior by itself (§6b).
- **Execution — durable since slice 3 WP1**: the runs worker CLAIMS under
  the per-run concurrency cap (`MANTLE_RUNS_WORKER_CONCURRENCY`, default 3 —
  serialized on the run row; completions emit slot-release wake-ups;
  `apps/web/lib/runs/execute-worker.ts`), then hands the whole agent turn to
  the DBOS runner (`apps/api/src/workflows/runs-worker-turn.ts`, enqueued by
  name on the shared RUNNER_QUEUE, `workflowID = itemId:attempt`). Every LLM
  call + tool dispatch journals, so a crash mid-turn resumes from the last
  completed step; the deadline re-stamps when execution actually starts
  (queue wait is not execution budget); a failed enqueue completes the item
  `failed(dispatch_failed)` immediately. The turn runs at delegation depth 2
  with an empty allowlist so `run_*`/`invoke_agent` refuse structurally.
  Evidence is MECHANICAL: the tool-loop's own call ledger lands on the item
  result; the full reply spills to a `tr_…` handle the responder can
  `read_result`.
- **Audits run in resume turns** (plan §7): `promote(audit)` emits a resume
  (never a dispatch) and stamps a verdict deadline (default 30 min — a lost
  audit turn times out and the run completes with the failure recorded). The
  audit-mode resume prompt carries the audited proposal, the recorded ledger,
  and `mechanicalPreCheck` auto-flags (verification claims with an empty
  ledger cannot be talked past). The verdict records via `run_audit`:
  `pass` (advisory findings ride along) or `redo` (blocking findings only —
  the anti-nitpick rule). Redo supersedes the worker item (terminal→terminal,
  counter untouched), appends a fresh attempt with findings + directive
  attached and a fresh audit, and promotes it. **One redo max**: a second
  blocking verdict fails the audit `needs_human` and the run surfaces it.
- **Acceptance metric**: per-worker first-pass acceptance
  (done-not-superseded / judged) on `/debug/runs` — the number that decides
  when cheaper worker tiers are justified.

## `ask_human` gates (slice 3 WP3)

The audit-item pattern with a human in the LLM's place. An
`{kind:'ask_human', question, options?, timeout_seconds?}` leaf (seq-only —
the answer gates the steps after it) promotes `queued → ready`, is NEVER
dispatched, and creates a `pending_tool_calls` row — the existing pending
approvals UI, the `pending_*` tools, and the telegram approval flow are the
answer surface; no new UI. `pending_approve` (with an optional free-text
`answer`) completes the item `done` with the answer riding `result.answer`
into the compiled state; `pending_reject` completes it
`failed({type:'rejected'})` so join policies treat it like any failed step.
Undated questions wait indefinitely (that is the feature) and are exempt
from every sweep duty; `timeout_seconds` makes an EXPIRING question (sweep
duty 1 fails it `timeout` when the window closes). Lifecycle sync: sweep
duty 4 expires any pending row whose item went terminal (run cancelled,
branch fail_fast-cancelled, question timed out), and an answer landing on a
dead item expires the row with a teaching error instead of pretending it
took effect.

## Budget + item-cap auto-pause (slice 3 WP4)

`run_plan` takes `budget_usd`; every `completeItem` adds the item's cost to
`runs.spent_micro_usd` UNDER THE RUN ROW LOCK (race-free by the lock-ordering
rule; failed items count — cost honesty). Crossing the budget CASes the run
`running → paused` and queues a `run_budget` "raise or cancel?" pending row
(same approval surface as `ask_human`). The pause-state matrix, per the
audited amendments:

- **Pause gates NEW work only** — refusal lives in `claimItem` /
  `claimWorkerItem`; promotion proceeds (a refused promotion would strand a
  queued child nothing re-promotes). In-flight items run to completion and
  their completions still drive counters and add spend.
- **A finished run is never paused**: the pause CAS runs after completion
  bubbling (crossing on the final completion just finishes the run), and
  `finalizeRun` / `cancelRun` CAS from `('running','paused')` — in-flight
  completions can finish a paused run, and a paused run stays cancellable.
- **Deadlines**: running items keep their clocks (pause can't abort them; a
  hung item stays killable by sweep duty 1). READY audit/question deadlines
  freeze while paused and shift by the paused duration on resume. Resume
  turns refuse on paused runs BEFORE `claimResume` (no LLM spend against a
  budget pause).
- **Approve** raises the budget by one more original budget on top of what
  was spent, flips `paused → running`, shifts the frozen deadlines, and
  re-emits the run's parked work inline (dispatches + unclaimed-audit
  resumes). **Reject** cancels the run. The sweep janitor expires a
  `run_budget` row whose run left `paused` some other way.
- **`item_cap`** (default 200): `createRun`/`appendChildren` count nodes
  under the run lock and refuse past the cap with a teaching error — the
  runaway-append backstop.

## Feature gate + dogfood

Dark by default. Enable per brain with `MANTLE_RUNS=1` in the app env (the
`worker_runs` container idles healthy when off). Since slice 3 WP1 the flag
is read by THREE services — web (`run_*` tools), `worker_runs` (engine), and
`api` (the DBOS turn workflows refuse with `failed(disabled)` when off) — the
compose `app-env` anchor feeds all of them from the host `.env`; never set it
narrower. The `runs` tool group is
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
- Confirm-gated (`requires_confirm`) tools never run headless — the item
  fails structured with a pointer at the pattern that works: gate the phase
  behind an `ask_human` step and run the gated tool inline at resume.
- Cancel (`run_cancel`, or the responder Stop signal in a later wiring) marks
  the run first (so no resume), then the subtree.
