# Runner queues — slice 3 plan (for pre-implementation audit)

Written 2026-07-21, after the slices-1+2 audit
([runs-audit-handover.md](runs-audit-handover.md) §8) and the durability ADR
([adr-runs-durable-execution.md](adr-runs-durable-execution.md)). This
document IS the ADR's slice-3 re-evaluation, written down for an independent
audit BEFORE implementation. Nothing here is built. The audit's job is to
falsify §3 (the claims) and break §4 (the designs); the implementation
decision is made after that, by Jason.

> **AUDITED same day** — verdicts inline in §3, design amendments folded
> into §4, outcome + deferred items in §8. Jason's §7 decision: implement
> WITH AMENDMENTS. §1 below is the RESTATED principle (the original C1
> framing fell PARTIAL).

## 1. The architectural principle under review

> **Long-lived coordination stays in the table engine; short-lived execution
> moves to DBOS workflows.**

Concretely: the run SPINE (the `run_items` tree, counters, sweep, `run_*`
tools) remains the pg-boss + CAS engine permanently — not as v1 pragmatism
but as the intended end state. The LLM TURNS a run performs (worker turns,
resume turns) become DBOS workflows in `apps/api`, joining the assistant/
telegram/team/forum turns already running there.

The decisive argument, RESTATED by the audit (the original C1 framing was
wrong for this fleet): apps/api pins a STABLE application version
(`applicationVersion: 'mantle-runner-1'`, `apps/api/src/config.ts`)
precisely so in-flight turns resume across in-place upgrades — routine
deploys do NOT strand DBOS workflows here. What survives is a dilemma that
only bites LONG-LIVED workflows: under the stable pin, replaying a workflow
across code evolution risks step-sequence divergence, and the documented
remedy — bumping `MANTLE_RUNNER_VERSION` at such a release — strands
whatever is then in flight. A turn is bounded minutes, so its exposure to
either horn is negligible; a run is long-lived by design — slice 3's
`ask_human` makes "waiting for a human for three days" a normal state — so
a run-spine workflow would meet one horn near-certainly. Rows have neither
problem: the table-driven spine is version-agnostic by construction. That
dilemma, plus the ADR's tree-is-the-product and mid-flight-mutation
arguments, carries the hybrid.

Corollary reversal from the ADR's early framing, now assessed rather than
assumed: `ask_human` and budget-pause — the "suspension-shaped" features —
STAY on the table engine. Suspension is native to a row-driven engine (a row
simply sits non-terminal); the audit-item pattern (an item completed later
by an external actor through a tool) already exists and `ask_human` is that
pattern with a human in place of an LLM. Budget accounting became trivially
race-free when the audit's run-row-first lock rule landed. DBOS would make
neither simpler and budget harder (no cross-workflow cost aggregation).

## 2. What slice 3 contains

| WP | What | Substrate | Order |
|---|---|---|---|
| WP1 | Worker turn execution → DBOS workflow | DBOS (`apps/api`) | 1st |
| WP2 | Resume turn execution → DBOS workflow | DBOS (`apps/api`) | 2nd |
| WP3 | `ask_human` items via `pending_*` | table engine | 3rd |
| WP4 | Budget / item-cap auto-pause | table engine | 4th |
| WP5 | Worker groups / panels (plan §6c) | plan layer (engine-agnostic) | 5th |
| WP6 | Per-run worker cap as a partitioned DBOS queue | DBOS | DEFERRED |
| — | Stop→`run_cancel`, channel-routed resumes, chat run card, mid-run `run_append` UX, docs | riding along | with WP2/3 |

WP1+WP2 first, deliberately: they are independent of the coordination
features, they close two ACKNOWLEDGED §5 gaps from the handover (worker
turns have zero mid-turn durability; a crash after `claimResume` loses the
wake-up forever), and they de-risk dogfood on exactly the paths the engine
test suite cannot cover (LLM-dependent).

## 3. Load-bearing claims — VERIFY THESE FIRST

These are the falsifiable assumptions the plan stands on. C1–C3 came from
repo reading plus general DBOS knowledge, NOT from executed verification —
they were the audit's primary targets. Each states what dies if it falls.
**Audit verdicts (2026-07-21, from DBOS SDK 4.22.6 source + repo
inspection) are annotated inline.**

- **C1 — version pinning.** In-flight DBOS workflows are pinned to the
  application version that started them; after an in-place container
  upgrade, the new executor does not resume old-version workflows (they
  strand pending absent manual fork/patch). *Verify:* DBOS 4.22.x docs +
  behaviour of `DBOS.listWorkflows` across a dev-box upgrade; how have
  in-flight assistant turns behaved across past deploys?
  *If it falls* (new versions resume old workflows safely): the strongest
  argument for keeping the spine on tables weakens to "the tree is the
  product + mid-flight mutation", which is still sufficient for slice 3 but
  reopens full-DBOS as a v2 option — the principle in §1 would need
  restating, not the WPs.
  **VERDICT: PARTIAL.** True of DBOS defaults — startup recovery selects
  PENDING rows on STRICT `application_version` equality
  (`system_database.js:571-574` in the SDK), queue dequeue filters
  `(application_version IS NULL OR =)` and stamps the claimer's version.
  FALSE for this fleet as configured: apps/api pins the stable constant
  above, so in-flight assistant turns have NOT been stranding across
  deploys — by configuration, not luck. Also recorded: `DBOSClient`
  enqueues carry `application_version = NULL` (claimable by any executor
  version until dequeued), and DBOS `enablePatching` exists as a third
  path (considered, not adopted). §1 restated per the fall clause; the
  hybrid stands on the amended grounds.
- **C2 — cross-process enqueue.** `DBOSClient` (the seam in
  `apps/web/lib/dbos-client.ts`, used by the Next.js server) also works from
  the `worker_runs` container: enqueue a workflow by name onto
  `RUNNER_QUEUE` without registering or executing it locally.
  *Verify:* enqueue the existing `pingWorkflow` from a worker-side script.
  *If it falls*: WP1/WP2 route through an internal HTTP endpoint on
  `apps/api` instead — same architecture, one more moving part.
  **VERDICT: CONFIRMED** (SDK source). `DBOSClient.enqueue` is a
  name-string + queue-name INSERT into the shared system DB — no local
  registration, no `DBOS.launch()`; dequeue resolves by `(class_name,
  name)` in the registering process. The shipped web→api assistant-turn
  path is this exact pattern (shared name constants in
  `assistant-runtime/contract.ts`). Worker-side notes: `lib/dbos-client.ts`
  is `server-only`, so `worker_runs` constructs its own client via the same
  `resolveSystemDatabaseUrl()`; the `dbos` schema must exist (apps/api must
  have launched once).
- **C3 — replay safety of the resume turn.** Under `withDurableSteps`,
  `record_outbound` (and each tool dispatch) is a journaled step, so a
  crash-resume replays the turn WITHOUT double-posting to the conversation
  or re-firing side-effecting tools. This is what dissolves the §5
  at-most-once caveat rather than documenting around it.
  *Verify:* extend the `crash-test.ts` pattern — kill the process between a
  journaled `record_outbound` and workflow completion; confirm exactly one
  outbound row after recovery.
  *If it falls*: WP2 keeps `claimResume`-before-turn (at-most-once as
  today) and the migration's value drops to concurrency + code unification;
  still worth doing, but the changelog must not claim the gap closed.
  **VERDICT: PARTIAL — the load-bearing half doesn't exist today.** The
  seam is real and deep: tracing `step()` routes through `runDurableStep`
  (`packages/tracing/src/store.ts:632`), so every LLM call + tool dispatch
  inside `runToolLoop` journals — including a `run_audit` verdict. But the
  explicit `record_*` boundaries live only in
  `run-turn.ts`/`run-team-turn.ts`/`run-forum-turn.ts`; `runResumeTurn`
  bypasses all of them and calls `recordTurn` BARE (`resume.ts`), and
  `recordTurn` itself is uninstrumented. Wrapping today's body in
  `withDurableSteps` alone would leave the outbound record in re-executed
  glue — a crash-resume could DOUBLE-POST the report. WP2 §4 amended: the
  boundaries are new work, and the extended crash-test is the acceptance
  gate for claiming the §5 gap closed.
- **C4 — one engine, unchanged.** WP1/WP2 add NO new engine transitions:
  the item is claimed before enqueue, the workflow's final step calls
  `completeItem` + `enqueueRunActionsSafe` itself (apps/api imports
  `@mantle/runs` and shares the DB), and the sweep's deadline duty remains
  the loss backstop. A workflow that dies permanently looks to the engine
  exactly like today's crashed handler.
  *Verify by inspection:* every path in §4 WP1/WP2 ends in an existing CAS.
  **VERDICT: CONFIRMED** by inspection. Two build-time caveats deferred to
  WP1 (§8): honest failure type on enqueue rejection; `workflowID`
  idempotency.
- **C5 — budget counter.** `runs.spent_micro_usd` incremented inside
  `completeItem` is race-free BECAUSE every completion already holds the
  run-row lock (the audit's `lockRunRow` rule). No aggregate query at claim
  time; pause is a status CAS under the same lock.
  *Verify:* by inspection + a widened engine test (concurrent completions
  sum exactly).
  **VERDICT: CONFIRMED** — `completeItem` acquires the run row lock FIRST
  (`engine.ts` `lockRunRow`, before the item CAS), serializing with every
  completion and with `claimWorkerItem`'s cap check. Implementation
  requirement: increment `spent` only when the item CAS returns a row (a
  swept/duplicate completion must not add cost twice).
- **C6 — `ask_human` needs no new engine machinery.** Reuses the audit-item
  shape: promote → `ready` + create a `pending_tool_calls` row, never
  dispatched; `pending_approve`/`pending_reject` completes the item with the
  answer; the counter drives on. REQUIRED DETAIL: sweep duty 2 (stale-ready
  re-dispatch) must exclude `ask_human` exactly as it excludes `audit`, and
  deadline semantics must treat an unanswered question as either undated or
  long-dated — an `ask_human` timing out into `failed` after 10 minutes
  would be a bug, not a feature.
  *Verify:* trace the item through promote/sweep/complete paths in §4 WP3.
  **VERDICT: PARTIAL.** The item-lifecycle reuse works (`execute-item.ts`
  already refuses stray `ask_human` dispatches — good depth), but two real
  changes were missing: sweep duty 1's overdue query is `running OR (ready
  AND audit)`, so a DATED question could never time out without amending
  it; and the `pending_tool_calls` row lifecycle was entirely unaddressed.
  Both folded into §4 WP3.
- **C7 — partitioned per-run cap (WP6, deferred).** A DBOS queue with
  `partitionQueue: true` keyed by `runId` (forum-queue precedent) could
  replace `claimWorkerItem`'s lock dance. Deliberately deferred: the claim
  CAS must remain the correctness gate regardless, and the current
  mechanism is tested. Audit may assess but nothing in slice 3 depends on
  it.
  **VERDICT: PLAUSIBLE, unverified** — the `partitionQueue` precedent is
  real (`FORUM_QUEUE`, apps/api/src/main.ts). Deferral stands.

## 4. Work-package designs

### WP1 — worker turns as DBOS workflows

Today: `worker_runs` claims under the per-run cap (`claimWorkerItem`), then
`execute-worker.ts` runs the whole LLM turn in-process; a crash re-runs the
turn wholesale or eats the 600 s deadline.

Planned: the claim stays exactly where it is. After a successful claim, the
runs worker enqueues `runsWorkerTurnWorkflow({ itemId })` on `RUNNER_QUEUE`
via `DBOSClient` (C2) and acks the pg-boss job — fire-and-forget, no
cross-process await. The workflow (new file
`apps/api/src/workflows/runs-worker-turn.ts`, mirroring
`assistant-turn.ts`): loads item + run, resolves route (the `'inherit'`
sentinel logic moves — or is imported — here), runs the turn under
`withDurableSteps` so every LLM call and tool dispatch journals, then
spills output, builds the mechanical evidence ledger, and calls
`completeItem` + `enqueueRunActionsSafe` as its final act. Retry policy
(`maxAttempts`, never side-effecting) is enforced in the workflow's failure
path, same rules as today.

Engine contract unchanged (C4): item `running` with a claim-stamped
deadline; sweep times out a lost workflow; late completion no-ops at the
CAS. `MANTLE_RUNS` gate: the workflow refuses (completes the item
`failed(disabled)`) if the flag is off — flag discipline must not fork.

Riding along: `runsWorkerTurnWorkflow` tags `DBOS.span` with
`mantle.runner='runs_worker_turn'` + run/item ids so the existing trace
dimensions cover it.

### WP2 — resume turns as DBOS workflows

Same shape: the pg-boss resume handler becomes claim-context only — read
target, check `resumed_at`, enqueue `runsResumeTurnWorkflow({ runId,
groupId })`, ack. The workflow runs today's `runResumeTurn` body under
`withDurableSteps`.

The interesting decision is WHERE `claimResume` moves. AMENDED per the C3
verdict (the boundaries are new work, not existing instrumentation):

- **New journaled boundaries WP2 must add**: explicit `runDurableStep`
  wrappers around `recordTurn` (the outbound record) and `claimResume` in
  the workflow path — neither is instrumented today; the loop's LLM calls
  + tool dispatches already journal via tracing `step()`.
- **Claim ordering (preserves the v0.157.5 audit fix)**: the claim step
  runs AFTER the journaled precondition steps (agent resolution, key
  decrypt, adapter, assembly) and BEFORE the LLM loop. A precondition
  failure must leave `resumed_at` NULL so the sweep re-sends — a workflow
  that claimed early and then landed in ERROR (DBOS does not retry ERROR
  workflows) would permanently swallow the report, re-creating the exact
  bug v0.157.5 fixed. "One workflow owns this resume" begins at the claim
  step, not at enqueue.
- **Acceptance gate**: the extended crash-test — kill the process between
  the journaled `record_outbound` and workflow completion; exactly one
  outbound row after recovery — must pass BEFORE any changelog claims the
  handover-§5 resume-loss gap closed. If it fails: claim stays immediately
  before the turn, at-most-once as today, and the changelog claims
  concurrency + code unification only.

Queue: `RUNNER_QUEUE` (concurrency = LLM backpressure cap) replaces the
pg-boss lane's `batchSize: 1` — the 30-minute audit-verdict deadline stops
being hostage to a global serial lane.

Riding along here: resume delivery to the run's originating channel
(telegram etc.) — the workflow runs beside the channel adapters in apps/api,
which is where that wiring naturally lives; and Stop→`run_cancel`, since the
turn-cancel listener already lives in this process.

### WP3 — `ask_human` (table engine)

Plan-parser: `ask_human` becomes a legal leaf (`{kind:'ask_human',
question, options?}`) in seq groups. Promote: `queued → ready`, NO dispatch
action, NO deadline by default (payload `timeout_seconds` optional for
expiring questions), create a `pending_tool_calls` row carrying question +
run/item refs. Sweep duty 2 excludes `ask_human` (C6). Answer path:
`pending_approve`/`pending_reject` handler calls a new thin
`applyHumanAnswer(itemId, answer)` in `@mantle/runs` — `completeItem(done,
{answer})` or `(failed, {type:'rejected'})` — counter bubbles, run
advances; the answer text rides the item result into the compiled state so
downstream steps and the resume prompt see it. Owner scoping identical to
`run_audit` (via the run row). Surfaces: the pending item shows in the
existing pending-approvals UI + telegram approval flow, no new UI.

AUDIT AMENDMENTS (bindings, not suggestions):

1. **The answer channel must exist.** `pending_approve` today carries no
   answer payload, and `approvePendingCall` resolves `toolSlug` against the
   tools table and DISPATCHES it — an `ask_human` row would flip to
   `approved` with "tool not registered", `applyHumanAnswer` would never
   run, and the undated item would sit `ready` forever with the question
   consumed. The handler must branch on the run-item ref in the row BEFORE
   tool resolution, and `pending_approve` gains an optional `answer`
   argument — approve/reject alone covers only yes/no and option-pick
   questions.
2. **Row lifecycle.** Every path that kills an `ask_human` item
   (`cancelRun`, fail_fast subtree cancel, sweep timeout of a dated
   question) must expire its pending row; an approval landing on an
   already-terminal item (`completeItem` CAS returns false) marks the row
   expired and tells the operator the run moved on. The sweep is the
   janitor of last resort — zombie questions must not accumulate in the
   pending UI / telegram flow.
3. **Dated questions.** Promote stamps the deadline (like audits — the
   item is never claimed), and sweep duty 1's overdue predicate adds
   `(ready AND kind='ask_human' AND deadline_at IS NOT NULL)` — without it
   a timed question can never expire. Undated questions stay exempt from
   every sweep duty (duty 2 excludes `ask_human` exactly as it excludes
   `audit`, per C6).

### WP4 — budget / item-cap auto-pause (table engine)

Migration: `runs.spent_micro_usd bigint not null default 0`. `completeItem`
adds `spent = spent + item cost` under the held run lock (C5, and only when
the item CAS returned a row); when a budgeted run crosses
`budget_micro_usd`, CAS `status running → paused` (new status), record a
`pending_tool_calls` "raise or cancel?" row. Resume: approval raises the
budget + flips `paused → running` + re-emits dispatch actions for `ready`
items (sweep duty 2's query, invoked once inline). `item_cap` enforcement
piggybacks: `appendChildren`/`createRun` count items under the run lock and
refuse past the cap with a teaching error.

AUDIT AMENDMENTS — the pause-state matrix (bindings, not suggestions):

1. **Pause gates NEW WORK ONLY — refusal lives in `claimItem` /
   `claimWorkerItem` (and the dispatch send), NEVER in `promote`.** A
   refused promotion leaves the next seq child `queued`, which no duty
   ever re-promotes — resume's ready-item re-dispatch would wake nothing
   and the run wedges permanently. Promotion proceeds under pause
   (promoted-but-unclaimed items burn nothing — deadlines stamp at claim);
   claims refuse; resume re-dispatches `ready` items as drafted.
2. **The pause/finalize/cancel CAS matrix.** The completion that crosses
   the budget may BE the run's final one — pausing checks the root first
   (never pause a run whose root went terminal in the same transaction),
   and `finalizeRun` + `cancelRun` CAS from `('running','paused')`, not
   `'running'` alone. Without this, a run whose last completion crossed
   the budget sits `paused` forever with a sealed root and no resume
   (sweep duty 3 requires status done|failed and cannot heal it).
   Cancellation of a paused run expires its "raise or cancel?" row (WP3
   amendment 2's rule, same janitor).
3. **Deadlines KEEP RUNNING for in-flight items during pause.** Pause
   cannot abort a running worker turn (cancel doesn't either — handover
   §5), so skipping sweep duty 1 would let a hung item wedge unkillable
   while paused, and shifting its stamp on resume would grant extra budget
   to work that never stopped. Their completions still add to `spent`; the
   re-pause CAS no-ops harmlessly. Only READY-audit deadlines (verdict
   budgets — nothing is executing) shift by the paused duration on resume.
4. **Resume turns refuse on paused runs, BEFORE `claimResume`.** An audit
   resume turn is LLM spend on a budget-paused run — contradicts the
   pause. Refusing pre-claim leaves `resumed_at` NULL so duty 2b re-sends
   after the run resumes; nothing is lost.

### WP5 — worker groups / panels (plan layer)

Per plan §6c: `agent_groups` schema; a `worker_invoke` naming a group
macro-expands AT PLAN/APPEND TIME into `par(worker_a … worker_n)` followed
by a panel `audit` in the enclosing seq — so the engine only ever sees
shapes it already executes, and the par-audit redo refusal is never hit
(the panel audit sits in the seq parent). No engine changes; parser +
routing-resolution work, plus prompt work for the panel-audit resume mode.

## 5. Suggested audit focus

1. **C1–C3 first** — they are unverified factual claims; everything else is
   design. Use the crash-test harness for C3; a dev-box ping for C2.
2. **Flag discipline across two runtimes** — with `MANTLE_RUNS` off, does
   anything execute via the DBOS path? (WP1/WP2 workflows must check the
   flag server-side in apps/api, whose env differs from worker_runs.)
3. **The paused-state matrix (WP4)** — pause racing an in-flight
   completion, pause racing append, deadline behaviour across
   pause/resume, sweep duties vs paused runs. This is the one WP that adds
   engine states; it deserves the §2-invariant treatment.
4. **`ask_human` timeout semantics (C6)** — undated ready rows vs every
   sweep duty; confirm nothing re-dispatches, times out, or wedges a group
   containing one.
5. **Two-runtime observability** — a stuck run now spans worker_runs
   (spine) and apps/api (turns). Is `trace_ref` + `DBOS.listWorkflows`
   (`apps/api/src/runs.ts`) enough to diagnose without SSH archaeology?
6. **Failure containment** — DBOS system DB unhealthy while pg-boss is
   fine: WP1's enqueue fails → item stays `running` until the sweep times
   it out → structured failure. Confirm no wedge and an honest failure
   record.

## 6. Explicit non-goals

- No spine rewrite; no `run_items`-as-projection; no pg-boss removal (it
  stays the wake-up transport for dispatch and the sweep cron).
- WP6 deferred; `claimWorkerItem` remains the cap mechanism in slice 3.
- No new run item kinds beyond `ask_human` activation; `worker groups` are
  expansion sugar, not a new kind.

## 7. Decision protocol

Audit findings land against §3 claims and §4 designs. Then Jason decides:
(a) implement as planned, (b) implement with amendments, or (c) reject the
hybrid — in which case WP3–WP5 proceed on the table engine unchanged (they
are substrate-independent) and WP1/WP2 are dropped or re-scoped. The ADR is
amended to record whichever outcome, and the slice is built only after.

**DECIDED (2026-07-21): (b) — implement with amendments.** The amendments
are folded into §1/§3/§4 above; §8 records the outcome and what was
deliberately deferred.

## 8. Audit outcome (2026-07-21)

The pre-implementation audit ran the same day (independent session; DBOS
SDK 4.22.6 source + repo inspection — C1/C2 are source-verified, not
executed). Verdicts: C2/C4/C5 CONFIRMED, C1/C3/C6 PARTIAL, C7
plausible-deferred. No claim fell in a way that breaks the hybrid; every
confirmed defect was design-level, and the four adopted amendments are now
part of this plan:

1. §1 restated (the stable-pin reality; the divergence-vs-strand dilemma
   replaces "pinning strands runs at every upgrade") + the ADR corrected.
2. WP2: explicit `runDurableStep` boundaries for `record_outbound` + the
   claim; claim AFTER journaled preconditions; extended crash-test as the
   acceptance gate.
3. WP4: pause gates claims not promotion; the pause/finalize/cancel CAS
   matrix; deadlines keep running for in-flight items; resume turns refuse
   pre-claim on paused runs.
4. WP3: the `pending_approve` answer channel + pre-tool-resolution branch;
   pending-row lifecycle sync; sweep duty 1 amended for dated questions.

Deferred — recorded here so they aren't lost, to land with their WPs:

- **WP1 build items**: on DBOS enqueue rejection, complete the item
  `failed({type:'dispatch_failed'})` immediately instead of eating the
  600 s deadline with a lying `timeout` (sweep stays the backstop for the
  crash-between-claim-and-enqueue window only); `workflowID = itemId`
  (worker turns) / `groupId` (resumes) for DBOS-level idempotency AND
  item↔workflow correlation (sweep re-sends after an acked job otherwise
  spawn duplicate workflows — safe via CAS, but wasteful and
  unqueryable); deploy checklist gains `MANTLE_RUNS` in apps/api's env
  (missing it fails every turn `failed(disabled)` — honest but noisy).
- **Queue starvation (known tradeoff)**: background turns share
  `RUNNER_QUEUE`'s FIFO with interactive assistant turns; split the queue
  or deprioritize runs work when starvation is observed, not before.
- **WP5 re-scope**: panel audits need `audit.ts` work —
  `findAuditedWorkerItem` finds the nearest preceding sibling
  `worker_invoke`, and a panel's preceding sibling is a `group_par`, so
  the auditor would be told "no worker step precedes" and redo would
  refuse. Gathering the par group's workers + a defined panel-redo
  semantic is real design work; "parser + prompt only" undersells WP5.
- **Cosmetic, expected**: trace/step rows are written outside the DBOS
  journal, so a crash-replay re-creates them — duplicate traces after a
  recovery are not a bug.

**BUILD RECORD (same day):** WP1–WP5 + the riding-alongs shipped as
v0.157.8–0.157.12, every amendment implemented as specified. The WP2
**acceptance gate PASSED** (2026-07-21, workstation stack, isolated scratch
DBs): `crash-test.ts CRASH_TEST_SHAPE=resume` — journaled `claim_resume` +
`record_outbound` steps, process killed between `record_outbound` and
workflow completion; recovery replayed to completion with exactly one claim
and exactly one outbound row. The handover-§5 resume-loss gap is claimed
CLOSED on that basis. WP5's panel semantic, as decided at build: blocking
panel verdicts escalate `needs_human` (panels never rerun automatically).
Deferred WP1 items landed with WP1; queue starvation remains the recorded
watch-item; WP6 stays deferred.
