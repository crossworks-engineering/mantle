# Runner queues — slice 3 build handover for final audit

Written 2026-07-21 for an independent implementation audit of the slice-3
BUILD. Self-contained: the auditor works from this document plus the repo.
The feature is DARK (`MANTLE_RUNS` unset) and has not been dogfooded; this
audit happens before first dogfood and before any push/deploy.

- Landed in: `e51702aa` (WP1, v0.157.8) → `0295bb8c` (WP2, v0.157.9) →
  `dd55df64` (WP3, v0.157.10) → `c99e30ba` (WP4, v0.157.11) → `af61d42c`
  (WP5 + riding-alongs + gate, v0.157.12), all on `main`, unpushed.
  `git diff 381f330b..af61d42c` is the full audited surface (381f330b =
  the amended plan, v0.157.7).
- Binding specs, in authority order:
  1. [runs-slice-3-plan.md](runs-slice-3-plan.md) — the AUDITED plan:
     §1 restated principle, §3 verdicts, **§4 amendments (bindings)**, §8
     outcome + deferred items + build record. The build claims to
     implement every §4 binding as written.
  2. [adr-runs-durable-execution.md](adr-runs-durable-execution.md) —
     incl. the WP2 acceptance-gate consequence.
  3. [runs-audit-handover.md](runs-audit-handover.md) §2 — the slices-1+2
     invariant list STILL GOVERNS (nothing in slice 3 may weaken it); §8
     records the fixes whose ordering rules slice 3 must preserve
     (run-row-first locks, claim-after-preconditions).
- Product doc: [runs.md](runs.md) (updated through slice 3). Changelogs:
  `docs/_changelog/0.157.{8,9,10,11,12}.md`.

## 1. What slice 3 added, per package

**WP1 — worker turns as DBOS workflows (0.157.8).** The runs worker's
`mantle.run.worker` lane is claim-context only: `claimWorkerItem` (engine
unchanged) then enqueue `runsWorkerTurnWorkflow` by name on the shared
RUNNER_QUEUE via a worker-safe `DBOSClient` seam and ack. The whole slice-2
turn body (inherit route resolution, depth-2 tool loop, mechanical
evidence, spill, `completeItem`) moved to
`apps/api/src/workflows/runs-worker-turn.ts` under `withDurableSteps`;
`completeItem`/`requeueForRetry` are journaled so post-completion crashes
replay recorded actions. `workflowID = itemId:attempt` (retry-unique,
row-derivable). Enqueue rejection → immediate `failed(dispatch_failed)`.
The workflow re-stamps `deadline_at` at execution start (queue wait is not
execution budget); an enqueued-but-never-started workflow times out on the
claim's stamp. Flag off in apps/api → `failed(disabled)`, counter-driving.

**WP2 — resume turns as DBOS workflows (0.157.9).**
`apps/web/lib/runs/resume.ts` DELETED; body moved to
`apps/api/src/workflows/runs-resume-turn.ts`. The two boundaries the plan
audit found missing are explicit journaled steps: `claim_resume` placed
AFTER the fallible preconditions (agent/key/adapter/assembly — the
v0.157.5 ordering) and BEFORE the loop; `record_outbound` journaled (no
double-post on replay). Enqueue uses `deduplicationID = groupId` and
deliberately NO fixed workflowID — a workflow that errors WITHOUT claiming
must stay rescuable by the sweep's re-send (a fixed id would dedupe the
rescue into a no-op against the terminal row). The pg-boss resume lane is
a relay (peek `resumed_at`, enqueue, ack; enqueue failure just acks — the
sweep re-sends).

**WP3 — ask_human (0.157.10).** Seq-only `{kind:'ask_human', question,
options?, timeout_seconds?}` leaves. Promote: `queued → ready`, NEVER
dispatched; deadline stamped at promote ONLY when dated; a
`pending_tool_calls` row (toolSlug `ask_human`, args carry
question/options/run_id/item_id, agent_id NULL — real FK vs soft ref) is
the surface. `pending_approve` gained optional free-text `answer` (MCP +
PATCH /api/pending/[id]); approve/reject branch BEFORE tool resolution
into `applyHumanAnswer` (`done` with `result.answer`, default
`'approved'`; or `failed({type:'rejected'})`). Sweep: duty 1's predicate
gained `ready AND kind IN ('audit','ask_human')` (dated questions expire);
duty 2 excludes ask_human; NEW duty 4 janitors pending rows whose item
went terminal; an answer landing on a terminal item flips the row
`expired` with a teaching error.

**WP4 — budget/item-cap auto-pause (0.157.11, migration 0132).**
`runs.spent_micro_usd` + `paused_at` + status `'paused'`. `completeItem`
adds cost under the already-held run lock, ONLY when the item CAS landed;
the pause CAS runs AFTER `onTerminal` (a run finished in the same txn is
never paused) and queues a `run_budget` "raise or cancel?" row. Pause
gates NEW WORK only: `claimItem` (EXISTS running-run predicate) and
`claimWorkerItem` (status check under the run lock) refuse; promotion and
append proceed. `finalizeRun`/`cancelRun` CAS from `('running','paused')`.
Deadlines: running items keep clocks (duty 1 unchanged for them); READY
audit/ask_human deadlines freeze while paused (duty 1 skips via runs
join) and shift by the paused duration on raise. Resume turns refuse on
paused runs BEFORE `claimResume`. `applyBudgetDecision`: raise = budget →
spent + one original budget, `paused → running`, deadline shift, inline
re-emit (dispatches + unclaimed-audit resumes); cancel = `cancelRun`.
Sweep duties 2/2b skip paused runs; janitor 4b expires moot `run_budget`
rows. `item_cap`: `createRun`/`appendChildren` count nodes under the run
lock, `ItemCapError` teaching error. `run_plan` gained `budget_usd`.

**WP5 — worker groups / panels (0.157.12, migration 0133).**
`agent_groups` (owner-scoped slugs, `member_slugs text[]` SOFT refs) +
`worker_group_ensure`/`worker_group_list` MCP tools. Parser accepts
`group:'<slug>'` on worker_invoke (seq-only, exclusive with `worker`),
stores a `panel_group` marker; `expandWorkerGroups` (before routing
resolution) replaces the leaf with `par(one worker_invoke per member)` +
an `audit {panel:true}` — the engine only sees known shapes.
`isPanelAudit`/`findPanelWorkerItems` (nearest preceding sibling
`group_par` → its terminal worker children); `applyAuditVerdict` panel
branch: pass = directive-as-synthesis with `audited_items`; blocking
verdict → `failed(needs_human)` — panels NEVER rerun automatically.
Panel resume prompt fences every attempt separately.

**Riding-alongs (0.157.12, migration 0134).** `runs.origin_channel`
captured from `ctx.surface` at `run_plan` (telegram only); the ROOT
resume delivers to the originating chat as a JOURNALED `deliver_telegram`
step (resolve telegramChats by owner+chat+allowlisted → account →
`sendMessage`; failure = loud log + web-only fallback), records the turn
under the delivered channel, and hands the loop the telegram surface.
Stop: `/debug/runs` Cancel button (AlertDialog) → `POST
/api/debug/runs/:id {action:'cancel'}` → the same `cancelRun` (live with
flag off). Flag plumbing: the compose `app-env` anchor now passes
`MANTLE_RUNS` (+ `MANTLE_RUNS_WORKER_CONCURRENCY`) to web, worker_runs
AND api — previously it reached no container at all.

## 2. The acceptance gate — what was actually proven

The plan-§8 gate ("kill between the journaled record_outbound and workflow
completion; exactly one outbound row after recovery") was run 2026-07-21
via `apps/api/src/crash-test.ts` `CRASH_TEST_SHAPE=resume`: a registered
workflow with the resume turn's step ordering (journaled `claim_resume`
INSERT → journaled `record_outbound` INSERT → `process.exit(137)` before
completion), against the workstation Postgres with ISOLATED scratch
databases (`mantle_crash_app`/`mantle_crash_sys`, dropped after) so no
live runner saw the crashed workflow. Run 2 recovered ("Recovering 1
workflows from application version mantle-runner-1") and completed with
exactly one claim row and one outbound row. On that basis the
handover-§5 resume-loss gap is claimed CLOSED.

**Judge the fidelity**: the gate exercised the exact mechanism and step
SHAPE, not the real `runsResumeTurnWorkflow` (which needs a live LLM). The
claim's validity rests on the workflow's boundaries matching the harness
shape — verify by reading `runs-resume-turn.ts` against `crashResumeImpl`.

Reproduce (any Postgres you can create databases on):

```sh
# run 1 (crash), then run 2 (recover + assert)
DATABASE_URL=<scratch-app-db> DBOS_SYSTEM_DATABASE_URL=<scratch-sys-db> \
  MANTLE_CRASH_TEST=1 CRASH_TEST_SHAPE=resume CRASH_MARKER=<m> \
  npx tsx apps/api/src/crash-test.ts
DATABASE_URL=<same> DBOS_SYSTEM_DATABASE_URL=<same> \
  CRASH_TEST_SHAPE=resume CRASH_MARKER=<m> npx tsx apps/api/src/crash-test.ts
```

## 3. File map (new / materially changed since 381f330b)

| File | Owns |
|---|---|
| `apps/api/src/workflows/runs-worker-turn.ts` | WP1 workflow (whole worker turn; journaled completeItem/requeue; deadline re-stamp; flag refusal) |
| `apps/api/src/workflows/runs-resume-turn.ts` | WP2 workflow (both resume modes + panel prompt + telegram delivery + paused refusal) |
| `apps/web/lib/runs/dbos-enqueue.ts` | worker-safe DBOSClient seam; workflowID/dedup conventions |
| `apps/web/lib/runs/execute-worker.ts` | claim + enqueue + dispatch_failed (shrunk from the slice-2 body) |
| `apps/web/workers/runs.ts` | worker/resume lanes now claim-context relays |
| `packages/runs/src/human.ts` | `applyHumanAnswer` |
| `packages/runs/src/budget.ts` | `applyBudgetDecision` (raise/cancel, deadline shift, inline re-emit) |
| `packages/runs/src/engine.ts` | ask_human promote branch; pause gating in claims; spent/pause in completeItem; finalize/cancel from paused; ItemCapError; originChannel |
| `packages/runs/src/sweep.ts` | duty-1/2/2b pause+ask_human predicates; janitor duties 4/4b |
| `packages/runs/src/audit.ts` | `isPanelAudit`, `findPanelWorkerItems`, panel verdict branch |
| `packages/runs/src/queues.ts` | workflow-name contract + workflowID/dedup rationale |
| `packages/tools/src/pending.ts` | ask_human + run_budget branches (settleAskHuman/settleBudget), `answer` param |
| `packages/tools/src/builtins-runs.ts` | ask_human parser case; group parsing + `expandWorkerGroups`; budget_usd; ItemCapError handling; originChannel capture |
| `packages/mcp-core/src/build-server.ts` | `pending_approve` answer param; `worker_group_ensure`/`list` |
| `packages/db` | migrations 0132/0133/0134 + schema (`runs` cols, `agent_groups`) |
| `apps/web/app/api/debug/runs/[id]/route.ts` + `(app)/debug/runs/runs-client.tsx` | cancel actuator |
| `apps/api/src/crash-test.ts` | the resume-shaped gate variant |
| `docker-compose.yml` | app-env anchor passes MANTLE_RUNS to all three services |

## 4. Deliberate decisions (judge the reasoning; don't file as bugs)

- **workflowID asymmetry**: workers `itemId:attempt` (idempotent per
  semantic attempt + row-derivable); resumes NO fixed id +
  `deduplicationID = groupId` (a failed-without-claiming workflow must
  stay rescuable — a fixed id would dedupe the rescue into a no-op).
- **Decrypted api key never journaled** (no plaintext secrets in the DBOS
  system DB): replay re-resolves it as glue → a post-claim crash plus a
  simultaneous decrypt outage can still lose one wake-up. Accepted.
- **Trace rows + token/cost accumulation live outside the journal**:
  crash-replay re-creates trace rows and under-reports replayed steps'
  cost on the item row. Mirrors the assistant turn. Accepted, documented.
- **Budget raise is deterministic** (+one original budget on top of
  spent); no free-text amount parsing. Reject = cancel.
- **Pause gates claims only** — promote and append proceed (the
  anti-wedge amendment); slot-release wake-ups still fire while paused
  (claims refuse; harmless).
- **Panels never rerun** — blocking panel verdict → `needs_human`.
- **`agent_id` NULL on runs-created pending rows** (`runs.agent_id` is a
  soft ref; `pending_tool_calls.agent_id` is a real FK).
- **ask_human undated by default** and exempt from every sweep duty —
  waiting indefinitely is the feature.
- **Enqueue rejection fails the item immediately** (`dispatch_failed`);
  the sweep covers only the crash-between-claim-and-enqueue window.
- **`requires_confirm` items still refuse** — the consent pattern is an
  ask_human gate + the responder running the gated tool inline at resume.
- **Gate fidelity** (§2): harness-shape proof, not a live-LLM kill.
  Judged sufficient at build time; the audit may disagree.
- **Queue starvation accepted as a watch-item**: background turns share
  RUNNER_QUEUE FIFO with interactive turns; split/deprioritize when
  observed (plan §8).

## 5. Known gaps (acknowledged, non-blocking — verify containment)

- Chat run card + mid-run `run_append` UX not built (UI package); the
  cancel actuator exists only on `/debug/runs`. The web `/pending` UI has
  no free-text answer input (answer rides the MCP tool / PATCH API;
  button-approve = plain approval).
- Worker groups have no settings UI (MCP tools only).
- Default Worker agent still NOT in the system manifest (ship checklist,
  unchanged from slices 1+2).
- LLM-dependent paths remain automation-untested end-to-end: the two
  workflows against live DBOS delivery, telegram delivery, panel judging.
  Dogfood on dev is the next gate.
- Env-skew postures (worker on / api off → every turn `failed(disabled)`;
  worker off / api on → recovered workflows complete but their pg-boss
  actions rot) are documented, not prevented.

## 6. Test coverage & how to run

`packages/runs/src/engine.test.ts` — 34 DB-backed tests (22 from slices
1+2, +5 ask_human, +6 budget/pause/cap, +1 panel), gated on
`RUNS_TEST_DATABASE_URL` (role must CREATE DATABASE; the suite provisions
scratch `mantle_runs_engine_test`, applies 0129/0130/0132/0134 + a minimal
`pending_tool_calls` stand-in, drops after):

```sh
RUNS_TEST_DATABASE_URL=postgres://… npx vitest run packages/runs
```

New coverage: ask_human promote/pending-row shape, answer + seq advance,
reject + duplicate refusal, sweep exemptions + janitor after cancel,
dated-question expiry; budget pause + claim gating + raise/re-dispatch,
final-completion crossing never pauses, in-flight finalize-from-paused,
reject-cancels + not-paused refusal, ready-audit deadline shift, item-cap
refusals; panel pass-synthesis + blocking-escalates with counter
integrity. `pnpm verify` (typecheck, lint, format, 2445 unit tests) green
at `af61d42c`. NOT covered: everything in §5's LLM-dependent list, the
pending.ts branches (no DB-backed test — they compose applyHumanAnswer/
applyBudgetDecision which are), the MCP tools, the cancel route/button.

## 7. Suggested audit focus

1. **Amendment compliance**: diff every §4 binding in the amended plan
   against the code. The build CLAIMS 1:1 implementation.
2. **Cross-runtime races (WP1/WP2)**: sweep timeout vs a live workflow's
   late completion; duplicate resume workflows (dedup clears at dequeue —
   two live workflows serialize only on the claim CAS); the deadline
   re-stamp racing the sweep; enqueue-failure paths on both lanes.
3. **The pause matrix beyond the tests**: pause racing `appendChildren`;
   two budget crossings in interleaved completions; raise racing cancel;
   raise racing a completing root; slot-release storms while paused.
4. **ask_human/run_budget cross-store consistency**: every item-killing
   path vs its pending row; answer/raise racing cancel/sweep; the
   `settle*` update-after-CAS windows in pending.ts (row claimed
   `approved` but the item settle fails mid-way — what does the operator
   see, can anything be double-applied?).
5. **Panel shape edge cases**: expansion inside nested groups; a group
   leaf appended via `run_append` (wrapper-kind vs target-group kind);
   1-member groups; superseded/cancelled panelists in
   `findPanelWorkerItems`; a hand-authored `audit {panel:true}` without a
   preceding par.
6. **Authorization + injection**: the answer path's owner scoping vs
   run_audit's precedent; `worker_group_ensure` inputs; the cancel route;
   `origin_channel` provenance (ctx.surface is runtime-populated — can
   any caller forge it? What does the MCP transport set?); the operator's
   free-text `answer` riding into the compiled state and later prompts.
7. **Flag discipline**: with `MANTLE_RUNS` unset everywhere, prove no
   slice-3 path executes; with skew, prove the documented postures hold.
8. **The gate-fidelity claim** (§2): read `runs-resume-turn.ts` against
   `crashResumeImpl` and judge whether "the §5 gap is closed" is honest.

Report findings against the slices-1+2 invariant list (runs-audit-handover
§2) plus the §4 bindings above; §4-of-this-doc decisions are to critique,
not file. The decision after the audit is Jason's: fix-then-dogfood, or
dogfood as built.
