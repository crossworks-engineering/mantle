# Runner queues — slice 3 plan (for pre-implementation audit)

Written 2026-07-21, after the slices-1+2 audit
([runs-audit-handover.md](runs-audit-handover.md) §8) and the durability ADR
([adr-runs-durable-execution.md](adr-runs-durable-execution.md)). This
document IS the ADR's slice-3 re-evaluation, written down for an independent
audit BEFORE implementation. Nothing here is built. The audit's job is to
falsify §3 (the claims) and break §4 (the designs); the implementation
decision is made after that, by Jason.

## 1. The architectural principle under review

> **Long-lived coordination stays in the table engine; short-lived execution
> moves to DBOS workflows.**

Concretely: the run SPINE (the `run_items` tree, counters, sweep, `run_*`
tools) remains the pg-boss + CAS engine permanently — not as v1 pragmatism
but as the intended end state. The LLM TURNS a run performs (worker turns,
resume turns) become DBOS workflows in `apps/api`, joining the assistant/
telegram/team/forum turns already running there.

The decisive argument (claim C1 below): DBOS pins workflows to an
application version, and this fleet replaces containers in place on upgrade.
A run is long-lived by design — slice 3's `ask_human` makes "waiting for a
human for three days" a normal state — so runs ROUTINELY straddle deploys; a
version-pinned run spine would strand mid-flight runs at every upgrade. Rows
have no code version. A turn, by contrast, is bounded minutes: it
practically never straddles a deploy, and if it dies mid-flight, journaled
replay on the new version is exactly the behaviour assistant turns already
rely on.

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

These are the falsifiable assumptions the plan stands on. C1–C3 come from
repo reading plus general DBOS knowledge, NOT from executed verification —
they are the audit's primary targets. Each states what dies if it falls.

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
- **C2 — cross-process enqueue.** `DBOSClient` (the seam in
  `apps/web/lib/dbos-client.ts`, used by the Next.js server) also works from
  the `worker_runs` container: enqueue a workflow by name onto
  `RUNNER_QUEUE` without registering or executing it locally.
  *Verify:* enqueue the existing `pingWorkflow` from a worker-side script.
  *If it falls*: WP1/WP2 route through an internal HTTP endpoint on
  `apps/api` instead — same architecture, one more moving part.
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
- **C4 — one engine, unchanged.** WP1/WP2 add NO new engine transitions:
  the item is claimed before enqueue, the workflow's final step calls
  `completeItem` + `enqueueRunActionsSafe` itself (apps/api imports
  `@mantle/runs` and shares the DB), and the sweep's deadline duty remains
  the loss backstop. A workflow that dies permanently looks to the engine
  exactly like today's crashed handler.
  *Verify by inspection:* every path in §4 WP1/WP2 ends in an existing CAS.
- **C5 — budget counter.** `runs.spent_micro_usd` incremented inside
  `completeItem` is race-free BECAUSE every completion already holds the
  run-row lock (the audit's `lockRunRow` rule). No aggregate query at claim
  time; pause is a status CAS under the same lock.
  *Verify:* by inspection + a widened engine test (concurrent completions
  sum exactly).
- **C6 — `ask_human` needs no new engine machinery.** Reuses the audit-item
  shape: promote → `ready` + create a `pending_tool_calls` row, never
  dispatched; `pending_approve`/`pending_reject` completes the item with the
  answer; the counter drives on. REQUIRED DETAIL: sweep duty 2 (stale-ready
  re-dispatch) must exclude `ask_human` exactly as it excludes `audit`, and
  deadline semantics must treat an unanswered question as either undated or
  long-dated — an `ask_human` timing out into `failed` after 10 minutes
  would be a bug, not a feature.
  *Verify:* trace the item through promote/sweep/complete paths in §4 WP3.
- **C7 — partitioned per-run cap (WP6, deferred).** A DBOS queue with
  `partitionQueue: true` keyed by `runId` (forum-queue precedent) could
  replace `claimWorkerItem`'s lock dance. Deliberately deferred: the claim
  CAS must remain the correctness gate regardless, and the current
  mechanism is tested. Audit may assess but nothing in slice 3 depends on
  it.

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

The interesting decision is WHERE `claimResume` moves (C3):
- If C3 holds: the workflow claims `resumed_at` as a journaled step early,
  and a crash-resume REPLAYS the remainder — the claim stops meaning "we
  get one attempt" and starts meaning "one workflow owns this resume". The
  §5 at-most-once loss dissolves; `record_outbound` replay safety carries
  the no-double-post guarantee.
- If C3 falls: claim stays immediately before the turn, at-most-once as
  today.

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

### WP4 — budget / item-cap auto-pause (table engine)

Migration: `runs.spent_micro_usd bigint not null default 0`. `completeItem`
adds `spent = spent + item cost` under the held run lock (C5); when a
budgeted run crosses `budget_micro_usd`, CAS `status running → paused`
(new status), record a `pending_tool_calls` "raise or cancel?" row.
`claimItem` / `claimWorkerItem` / `promote` refuse on paused runs (state
check joins the run row — claim already reads it for the cap). Resume:
approval raises the budget + flips `paused → running` + re-emits dispatch
actions for `ready` items (sweep duty 2's query, invoked once inline).
`item_cap` enforcement piggybacks: `appendChildren`/`createRun` count items
under the run lock and refuse past the cap with a teaching error. Sweep
duty 1 skips paused runs' items (a paused run must not bleed timeouts);
deadline stamps shift accordingly on resume — the audit should scrutinize
this interaction (§5).

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
