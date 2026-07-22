# Runner queues — durable, inspectable execution plans

Design: "Runner queues & worker agents — implementation plan v1" (dev brain).
Status: **slices 1 + 2, plus slice 3 WP1** — the spine (schema, engine,
dispatcher, sweep, `run_*` tools, resume turn, run view), worker agents +
audits (per-run concurrency cap, model inheritance, mechanical evidence,
resume-driven audit verdicts with a one-redo cycle, the per-worker acceptance
metric), and **slice 3 complete** ([runs-slice-3-plan.md](runs-slice-3-plan.md)):
durable turns (worker turns AND resume turns execute as DBOS workflows in
apps/api — WP1/WP2, crash-test gate PASSED), `ask_human` gates (WP3), budget /
item-cap auto-pause (WP4), worker groups / panels (WP5), channel-routed
resume delivery, and the run-view Cancel actuator. WP6 (partitioned per-run
cap) stays deferred.

**Slice 4 — operational readiness** (still dark): a dedicated
`RUNS_TURN_QUEUE` so background turns never starve interactive ones (WP-F);
the default worker agent moved into the system manifest (WP-E); slug-aware
`ask_human` / `run_budget` answering on `/pending` (WP-C); the run view
promoted from `/debug/runs` to a first-class master-detail `/runs` surface
(WP-B); a `/settings/worker-groups` management screen (WP-D); and an
active-runs strip on `/assistant` (WP-A).

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
  since slice 3 WP2 (replay-hardened in v0.157.14): an ordinary responder
  turn (`assembleResponderTurn` + `runResponderLoop`) whose prompt is the
  compiled run state, run as a DBOS workflow. Every pre-claim decision that
  reads mutable state lives in ONE journaled `resume_preflight` step — DBOS
  recovery re-runs the function from the top, and an unjournaled guard would
  re-decide against state the workflow's own claim mutated (the final
  audit's reproduced loss bug). `claimResume` is a JOURNALED step placed
  after the preflight (the v0.157.5 ordering — a preflight failure leaves
  the wake-up re-sendable) and the outbound `recordTurn` is journaled too.
  The crash-test gate passes at BOTH kill points: post-claim (the loss
  window — the report still arrives exactly once) and post-outbound (no
  double-post). Enqueued with `deduplicationID = groupId` (one queued resume
  per group; no fixed workflowID — a failed-without-claiming workflow must
  stay rescuable by the sweep's re-send).
- **Tools** (`packages/tools/src/builtins-runs.ts`): `run_plan`,
  `run_append`, `run_state`, `run_cancel` — the `runs` tool group in the
  manifest. Responder-only; a delegated child agent is refused, and `run_*` /
  `invoke_agent` are banned inside items (checked at plan time AND at
  execution — no recursion).
- **Run view**: `/runs` — a first-class master-detail surface (slice 4
  WP-B, promoted from `/debug/runs`): the run list (title, status incl.
  `paused`, created, cost) beside the selected run's collapsible item tree
  (states, one-line outcomes, per-subtree cost roll-up, trace links), the
  operator Cancel actuator, and "needs you" banners linking to /pending on a
  budget pause or an open question.

## Workers + audits (slice 2)

- **Workers are templates, not processes** (`agents.role = 'worker'`,
  migration 0131): each `worker_invoke` item spawns a fresh agent turn from
  the template — model, kit, instructions. The default "Worker agent" now
  ships in the system manifest (slice 4 WP-E — seeded on every brain;
  `ensureWorkerAgent` stays the lazy fallback that finds the seeded row).
  `model = 'inherit'` (the default) runs the step on
  the RESPONDER's model/provider/key at execution time; pointing a duplicate
  worker at a cheaper model is the opt-in cost knob, justified by its
  acceptance rate. Routing is per step (`worker: '<slug>'` in the plan node);
  adding a worker never changes behavior by itself (§6b).
- **Execution — durable since slice 3 WP1**: the runs worker CLAIMS under
  the per-run concurrency cap (`MANTLE_RUNS_WORKER_CONCURRENCY`, default 3 —
  serialized on the run row; completions emit slot-release wake-ups;
  `apps/web/lib/runs/execute-worker.ts`), then hands the whole agent turn to
  the DBOS runner (`apps/api/src/workflows/runs-worker-turn.ts`, enqueued by
  name on the dedicated `RUNS_TURN_QUEUE` (`'mantle.runs'`),
  `workflowID = itemId:attempt`). Every LLM
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
  (done-not-superseded / judged) on `/runs` — the number that decides
  when cheaper worker tiers are justified.

## `ask_human` gates (slice 3 WP3)

The audit-item pattern with a human in the LLM's place. An
`{kind:'ask_human', question, options?, form?, timeout_seconds?}` leaf
(seq-only — the answer gates the steps after it) promotes `queued → ready`,
is NEVER dispatched, and creates a `pending_tool_calls` row — the existing
pending approvals UI, the `pending_*` tools, and the telegram approval flow
are the answer surface. Slice 4 WP-C made `/pending` slug-aware: an
`ask_human` row shows the question as its headline with one-click `options`
chips and a free-text "Answer & approve" field (PATCH `/api/pending/:id`
`{decision:'approve', answer}`), and a `run_budget` pause labels its actions
"Raise budget" / "Cancel run". `pending_approve` (with an optional free-text
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

### Reaching the operator + the questionnaire

A parked run used to be **silent**: the engine inserted the pending row
inside its own transaction and nothing fired the approval fan-out, so a
blocked run was discoverable only by visiting `/pending`. Two additions
close that:

- **The fan-out (`pending_created`).** Both silent creation sites — the
  `ask_human` promote and the `run_budget` pause — now emit a
  `pending_created` post-commit action carrying the row id + args.
  `enqueueRunActions` hands it to whatever `@mantle/runs`'s
  `registerPendingCreatedNotifier` seam holds (`notify.ts`); `@mantle/tools`
  registers `notifyPendingCreated` at module load, so the question enters the
  same fan-out as any other approval: the live sidebar badge **always**, plus
  **either** the companion device push (`reminderChannel: 'mobile'`) **or**
  the Telegram card (otherwise, and only if a paired chat exists) — the two
  remote arms are mutually exclusive by routing, never both. The seam exists
  because `@mantle/tools` already imports `@mantle/runs` — the reverse edge
  would be a cycle. The action is **advisory**: losing it loses a ping, never
  correctness, so it gets no sweep re-send and a throwing notifier is
  swallowed. **Telegram announces a question, it never answers one**: a
  question arrives as a plain notice with NO buttons (the card can only say
  yes/no, and a tap would be recorded as the operator's answer to a question
  that asked something else). Ordinary confirm-gated tool approvals keep their
  two-button card. The fan-out is also fired **detached** (`void`), never awaited: the same
  call is awaited by `settleAskHuman` before it writes `executed_at`, and a
  Telegram request that hangs (client default: 500 s) would otherwise hold an
  answered question in the decided-but-unsettled window until sweep duty 4c
  reverted a decision that had already applied. Inside a DBOS workflow the
  split is the other way round (`emitDurable` in `runs-worker-turn.ts`): the
  fan-out is a JOURNALED step and the queue jobs stay bare glue. Queue
  duplicates no-op at the engine's CAS, but a notice has no CAS — an
  un-journaled replay after a crash would buzz the operator a second time
  about a question they have already seen.
- **A structured questionnaire (`form`).** Beyond flat `options`, a question
  can carry `form.questions[]` — up to 4 sub-questions, each with labelled
  options (`{label, description?}`), `multi_select`, and an `allow_other`
  free-text escape (default ON: a question with no escape hatch forces a
  wrong answer). Caps are a contract the answer UIs render against — 4
  questions, 8 options, 24-char headers, 80-char labels, 8 KB total — and
  every rejection teaches the fix. A question with **no options AND
  `allow_other:false` is refused at plan time**: it would render zero
  controls and disable the whole form's submit, stranding its answerable
  siblings. The form rides verbatim into the pending row's args, so
  `/pending`, the assistant panel and `pending_get` all render it from the
  row alone. Answers come back as
  `answers: [{question: '<id>', selected: [...], other?}]` (PATCH
  `/api/pending/:id` or `pending_approve`), and land on the item as BOTH
  `result.answers` (structured) and `result.answer` (rendered prose, capped
  at 4 000 chars — every pre-existing consumer keeps reading `result.answer`
  unchanged). Answers are **validated against the item's own form** (the copy
  the plan authored, not the pending row's): an unknown question id, a
  duplicate entry, a pick that isn't one of that question's options, or free
  text on an `allow_other:false` question is refused with a teaching error and
  the decision is handed BACK — nothing is applied and the question stays
  open. The rendered prose is headed by each question's **header or text**,
  never its id, because `q1: production` tells a resumed responder nothing.
- **A questionnaire cannot be answered by a bare "yes".** Approve/reject-only
  surfaces — the Telegram card, `pending_approve` with no payload — would
  otherwise complete a 4-question form with the string `'approved'` and let
  the run proceed having learned nothing. When the row carries a `form` and
  no `answer`/`answers` arrives, the decision is **handed back**
  (`revertToPending`) with a teaching error pointing at `/pending`. Rejecting
  still works: declining to answer is a real answer, and fails the step by
  design.

Surfacing, all driven by the ONE shared `['pending']` query
(`components/pending/`): `<QuestionnaireCard/>` is a single renderer used by
`/pending` AND the assistant thread's `<PendingQuestionsStrip/>`, so a
blocked run is answerable where the operator already is; the footer
`AssistantButton` pulses with a count while questions wait (it clears when
the panel is opened — glancing at it is the acknowledgement); and a headless
`<PendingQuestionWatcher/>` in the shell raises a sticky toast with an
"Answer" action for questions that arrive **while you are looking** (never on
first load — the first SUCCESSFUL fetch seeds the seen-set; seeding must key
off `isSuccess`, never `!isPending`, because a fetch that ERRORS reports
`isPending === false` with no data and would make every pre-existing question
look new on the next retry). `useRealtime` opens one SSE stream per call, so
the watcher holds the single app-wide `pending_tool_call` subscription and
every other consumer repaints off its invalidation — `/pending` dropped its
own redundant one, though every OTHER route now carries this stream (and one
shared `/api/pending?status=pending&limit=50` fetch) that it did not before.
That query is keyed `['pending-questions']`, deliberately NOT `['pending']`:
`/pending` wants every row including history, this wants a narrow slice, and
one key serving two different `queryFn`s would make the payload depend on
whichever observer fetched first. Both are invalidated together
(`invalidatePending`).

## Worker groups / panels (slice 3 WP5)

A worker group is a NAMED SET of worker agents (`agent_groups`, migration
0133; manage with `worker_group_ensure` / `worker_group_list`). A
`worker_invoke` with `group:'<slug>'` (seq-only, mutually exclusive with
`worker`) macro-expands AT PLAN/APPEND TIME into `par(one attempt per
member)` followed by a PANEL audit in the enclosing seq — the engine only
ever sees shapes it already executes. The panel-audit resume prompt carries
every attempt's fenced proposal + mechanical ledger; verdict `pass` means at
least one attempt (or a synthesis) is usable and the `directive` IS the
authoritative synthesis; a blocking verdict escalates `needs_human` — panels
never rerun automatically (consistent with the seq-only redo rule).

## Channel-routed resumes + Stop

`run_plan` records the creating surface on `runs.origin_channel` (0134). A
telegram-origin run's ROOT report is delivered back to the originating chat
(journaled send — no double-post on crash-replay; falls back to web-only
with a loud log if the chat is unpaired). The run view (`/runs`) has a
Cancel button — the operator Stop actuator, same `cancelRun` as the
`run_cancel` tool, live even with the flag off.

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

## Queue isolation (slice 4 WP-F)

Background runs turns get their OWN DBOS queue, `RUNS_TURN_QUEUE`
(`'mantle.runs'`, `packages/runs/src/queues.ts`) — both the worker-turn and the
resume-turn workflows enqueue onto it (`apps/web/lib/runs/dbos-enqueue.ts`).
apps/api registers it with its own concurrency cap
(`runsTurnConcurrency()`, env `MANTLE_RUNS_TURN_CONCURRENCY`, default 2). This
closes the slice-3 starvation watch-item: worker + resume turns previously
shared `RUNNER_QUEUE`'s FIFO with the owner's INTERACTIVE assistant/telegram
turns, so a run fanning out N worker turns could queue ahead of a live chat
message. Off the shared queue, background runs can never starve the foreground
(the same isolation `FORUM_QUEUE` gives topic turns). Deploy-skew posture: a
worker that enqueues to `'mantle.runs'` before apps/api restarts with the queue
registered leaves jobs WAITING until the api rolls — an unregistered queue is
never drained, not an error. Compose restarts web + api together, so the window
is transient and the jobs run as soon as the api runner comes up.

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
