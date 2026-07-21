# Runner queues — implementation handover for audit (slices 1 + 2)

Written 2026-07-21 for an independent implementation audit. Self-contained: an
auditor should be able to work from this document plus the repo. The feature is
DARK by default (`MANTLE_RUNS` unset) and has not yet been dogfooded on a live
brain — this audit happens before first deploy.

- Landed in: `5f21f489` (spine, v0.157.2) → `c207b610` (slice 1 complete,
  v0.157.3) → `d4bfee1c` (slice 2, v0.157.4), all on `main`.
- Product doc: [docs/runs.md](runs.md). Changelogs:
  `docs/_changelog/0.157.{2,3,4}.md`.
- The design ("Runner queues & worker agents — implementation plan v1") lives
  on the operator's private brain; this document restates every binding
  decision the audit needs, so the plan is not required reading.

## 1. What this system is

When the responder (the user-facing chat agent) is asked for a multi-step
delegatable job, it can create a **run**: a durable tree of **run items**
stored in Postgres and executed in the background by a pg-boss-driven worker.
Interior nodes are `group_seq` / `group_par` (structured concurrency — a tree,
deliberately NOT a general DAG); leaves are `tool_call`, `note`,
`worker_invoke` (a whole delegated agent turn), and `audit` (a judgment the
responder itself performs when woken). Items are immutable once created
(append-and-supersede, never edit): the tree is simultaneously the execution
engine and the audit log. When the run's root completes, the responder is
woken exactly once with the compiled run state and reports to the user.

## 2. Core invariants (the things worth trying to break)

1. **Exactly-one-resume.** Every child terminal transition increments its
   parent group's `children_done` via `UPDATE … SET children_done =
   children_done + 1 WHERE id = :parent RETURNING …` — the parent row lock
   serializes concurrent completions, so exactly ONE transaction observes
   `done == total`, seals the group, transitions it terminal, and bubbles the
   same increment upward. Root completion emits ONE resume action.
   Backstops, in order: pg-boss `singletonKey` (= group/item id) dedupes
   queued resume jobs; `run_items.resumed_at` CAS (`claimResume`) makes the
   resume TURN at-most-once even if a job is delivered twice.
2. **CAS discipline everywhere.** Every state transition is
   `UPDATE … WHERE state IN (…) RETURNING`; a no-row result means a duplicate
   or stale wake-up and the caller acks without acting. pg-boss jobs carry
   only ids, never payload — "the table is the truth; jobs are disposable
   wake-ups."
3. **Post-commit actions.** Engine functions return `PostCommitAction[]`
   (dispatch/resume enqueues) instead of enqueuing inside their transactions;
   callers enqueue after commit (`enqueueRunActionsSafe`). A crash between
   commit and enqueue is healed by the sweep. pg-boss must never observe
   uncommitted rows.
4. **Sealing vs append.** `run_append` takes the group row lock
   (`SELECT … FOR UPDATE`) before touching `children_total`, so an append
   either lands while a child is still pending (total grows, group stays
   open) or the group already sealed and it errors (`SealedGroupError`). It
   can never race the final counter increment into a lost update.
5. **Counter integrity across redo.** A redo relabels the audited worker item
   `done → superseded` (both terminal — the counter is NOT touched again) and
   appends replacement + fresh audit (total += 2, each completing once).
   After any sequence of redos, `children_done == children_total` at group
   completion.
6. **Deadline semantics.** Deadlines are EXECUTION budgets: stamped at CLAIM
   for dispatched leaves (default 600 s, `payload.timeout_seconds` override),
   at PROMOTE for audits (default 1800 s — audits are never claimed; the
   deadline is the verdict budget). Ready items waiting on the queue or the
   worker cap have NULL deadlines and cannot time out; the sweep's lost-job
   duty covers them instead. The sweep failing an overdue item drives the
   counter like any completion — nothing wedges.
7. **Workers propose, never mutate, never recurse.** Worker turns run at
   delegation depth 2 with an empty delegate allowlist: `invoke_agent` fails
   closed and every `run_*` tool refuses at depth > 1. Their tool kit is
   read/search only. `run_*` and `invoke_agent` are additionally banned as
   `tool_call` items at plan time AND at execution (defense in depth).
8. **One tool executor.** Queue items execute through the SAME `dispatchTool`
   path the inline chat loop uses. There is no second executor to drift.
9. **Anti-nitpick audit contract.** Only `blocking` findings can justify a
   `redo`; a `pass` with blocking findings is rejected as contradictory. One
   redo max per step; the second blocking verdict fails the audit
   `needs_human`. Advisory findings ride along on a pass.
10. **Cost honesty.** Every item records usage + cost in integer micro-USD at
    whichever model actually ran (a worker inheriting the responder's route
    is priced at the responder's model), including failed items.

## 3. File map

Engine (`packages/runs/src/` — pure DB logic, no pg-boss handlers):

| File | Owns |
|---|---|
| `engine.ts` | tree create/append, promote, claim (incl. `claimWorkerItem` cap), completion counter + bubbling, join policies, sealing, supersede, retry requeue, cancel |
| `sweep.ts` | the minutely immune system: deadline timeouts, lost-dispatch re-emit, lost-resume re-send (roots + audits), `claimResume` |
| `audit.ts` | `applyAuditVerdict` (pass/redo/needs_human), `findAuditedWorkerItem`, `mechanicalPreCheck` |
| `worker.ts` | worker-agent template: `ensureWorkerAgent` (lazy default), `WORKER_MODEL_INHERIT` sentinel, kit + prompt constants |
| `state.ts` | `compileRunState` / `renderRunStateText` — the projection every consumer reads |
| `boss.ts` | send-side pg-boss singleton, queue ensure, `enqueueRunActions(Safe)` |
| `queues.ts` / `flag.ts` | queue names; `isRunsEnabled`, `workerConcurrencyCap` |

Execution + surfaces (`apps/web/`):

| File | Owns |
|---|---|
| `workers/runs.ts` | the worker process: three queue handlers + sweep cron; idles when flag off |
| `lib/runs/execute-item.ts` | tool_call/note execution (claim → validate args → trace → dispatchTool → complete/retry) |
| `lib/runs/execute-worker.ts` | worker_invoke execution (cap claim → route resolution incl. inherit → agent turn → mechanical evidence + spill → complete/retry) |
| `lib/runs/resume.ts` | resume turns, two modes: ROOT (report to user, records outbound chat turn) and AUDIT (judge + `run_audit`, posts nothing) |
| `app/api/debug/runs/*` + `app/(app)/debug/runs/*` | read-only run view + acceptance metric |

Tools: `packages/tools/src/builtins-runs.ts` — `run_plan`, `run_append`,
`run_state`, `run_cancel`, `run_audit`; plan parsing/validation with teaching
errors; plan-time tool existence + worker-routing resolution. Granted via the
manifest `runs` tool group (NOT attached to the persona by default).

Schema: `packages/db/src/schema/runs.ts` (+ `agents.ts`, `traces.ts` touches);
migrations `0129_runs.sql`, `0130_runs_resume_marker.sql`,
`0131_agent_role_worker.sql`.

## 4. Deliberate decisions & deviations (don't report these as bugs — judge them)

- **`conversation_id` replaced by `owner_id` + `agent_id`** on `runs`: the
  repo has no conversations table (a conversation is per (owner, agent)).
  `origin_turn_id` soft-refs `traces.id`.
- **Soft refs by design** for agent/turn/trace pointers (no FK): run history
  is an audit record and must survive agent deletion with ids intact.
- **Model inheritance via the `'inherit'` sentinel** on `agents.model`
  instead of making the column nullable (a `string|null` ripple through every
  chat path for one consumer). Contained in `execute-worker.ts`.
- **Mechanical evidence** (the tool-loop's own call ledger) instead of the
  planned model-authored evidence array — unfakeable, and the "reject
  verified-claims-with-no-trace" check becomes a regex + empty-ledger test.
- **Worker output → `tool_results` handle** (`read_result`, 7-day TTL)
  instead of a brain node. Revisit if permanence is wanted.
- **`run_audit` is a new tool not in the plan's binding list** — the plan
  says audits run inside responder resume turns but names no verdict-recording
  surface; this is it.
- **Redo is seq-only**; par-group audits refuse redo (`needs_human`) and the
  plan parser teaches this at plan time. A redo appended to a running par
  group would promote its own fresh audit before the replacement ran.
- **Default Worker agent is NOT in the system manifest** while the feature is
  dark (the boot reconcile would provision it on every brain at upgrade); it
  is lazily ensured on first use. Must move into `MANIFEST_AGENTS` at ship.
- **Env-var feature flag** (`MANTLE_RUNS`, default off) per the repo's
  existing flag idiom; `run_state`/`run_cancel`/`run_audit` stay live when
  off so existing runs remain inspectable/stoppable.

## 5. Known gaps (acknowledged, non-blocking — verify they're contained)

- Responder Stop signal is not yet wired to `run_cancel`.
- Resume replies record to the web conversation only (no channel routing to
  Telegram etc. yet).
- If the auditing responder lacks the `runs` tool group, an audit turn cannot
  record a verdict; the audit times out (30 min) into `failed(timeout)` and
  the run completes with the failure visible — degraded but safe.
- A resume turn that crashes AFTER `claimResume` but before finishing loses
  that wake-up (at-most-once by design); the run record remains complete in
  the run view.
- `ask_human` items, `budget_micro_usd` / `item_cap` enforcement, and worker
  groups are slice 3 — columns exist, enforcement doesn't.
- Cancel does not abort an in-flight tool/worker execution mid-call; the late
  completion no-ops at the CAS.
- `cancelRun` cancels subtrees without driving inner group counters (the
  whole subtree dies together) — deliberate; check the reasoning holds.

## 6. Test coverage & how to run

`packages/runs/src/engine.test.ts` — 20 DB-backed tests, gated on
`RUNS_TEST_DATABASE_URL` (a Postgres URL whose role can CREATE DATABASE; the
suite provisions and drops a scratch db `mantle_runs_engine_test`, applying
migrations 0129+0130). Without the env var the suite skips (CI-safe).

```sh
RUNS_TEST_DATABASE_URL=postgres://… npx vitest run packages/runs
```

Covered: the parallel-completion race (2-wide ×12 rounds, 8-wide), duplicate
no-ops, seq promotion, nested bubbling, wait_all/fail_fast, sealing + append
races, empty groups, cancel + late completion, sweep timeout→counter,
lost-dispatch heal, lost-resume heal + exactly-once `claimResume`, retry
requeue, audit promotion→resume, verdict coherence, the full redo cycle
(supersede/append/promote/cap→needs_human with counter integrity), worker-cap
claim gating + slot release, `mechanicalPreCheck`.

NOT covered by automated tests (LLM-dependent; needs live dogfood): the
worker turn itself (`execute-worker.ts`), the resume turns (`resume.ts`), the
run_* tool handlers end-to-end, pg-boss delivery. `pnpm verify` (typecheck,
lint, format, 2442 unit tests) is green as of `d4bfee1c`.

## 7. Suggested audit focus

1. **Concurrency**: lock ordering (child row → parent row upward on
   completion; run row for the worker cap; group row for append). Look for a
   deadlock or lost-update interleaving the tests don't force — especially
   append vs fail_fast cancellation vs completion, and `cancelRun` racing a
   completing subtree.
2. **The nested-completion path**: `onTerminal` recursion when a promoted
   child group completes instantly (empty group) inside a parent's completion
   transaction — stale local `done`/`total` variables are handled by
   re-checking; verify there is no interleaving that double-completes a group
   or drops a resume.
3. **Sweep vs live handlers**: every pairwise race (sweep timeout vs real
   completion, re-dispatch vs in-flight claim, resume re-send vs claimed
   resume). Each should resolve via CAS with no double effects.
4. **Injection surface**: worker output (LLM-generated, potentially steered
   by ingested content it read) is embedded in the audit resume prompt, and
   item results flow into the root resume prompt. Assess whether a hostile
   proposal could break the audit framing, and whether `run_audit`'s
   validation (verdict coherence, findings shape) is enough.
5. **Authorization**: every tool handler owner-scopes via the run row; the
   debug API scopes by session owner. Check for any path where an item/run id
   from another owner could be acted on (`run_audit`, `run_append`,
   `claimResume` via forged job payloads — note pg-boss payloads are written
   only by this codebase, but the sweep/dispatch trust `itemId`s).
6. **Flag discipline**: with `MANTLE_RUNS` unset, confirm nothing executes
   (worker idles, creation tools refuse) yet existing data stays readable.
7. **Accounting**: micro-USD roll-ups (item → subtree → run), the acceptance
   metric's accepted/redone classification, and trace linkage (`trace_ref`).

Report findings against the invariant list in §2; anything in §4 is a
decision to critique, not a defect to file.
