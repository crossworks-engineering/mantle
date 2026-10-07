# Maintenance runner: registry, CLI, scheduled sweeps

Status: **all three phases shipped.** Phase 1 (registry + `pnpm maintain`
CLI, v0.150.0), Phase 3 (Maintenance tab on `/debug/integrity`, v0.151.0,
brought forward so admins don't need a terminal), Phase 2 (nightly cron
worker + `maintenance_runs` unified history, v0.153.0).

## Why

The repo accumulated ~22 operational scripts under `server/web/scripts/` (plus one
in `packages/email`), each with its own pnpm alias, its own flag conventions
(`--apply` vs `--go` vs `--dry-run` vs `--dry`), and no shared answer to the
questions that actually matter before running one:

- Is this a **one-off backfill** that's already done, or **recurring hygiene**
  that drifts back as data arrives?
- Does it **spend money** (chat model / embedding calls) or is it pure SQL?
- Is it dry-run by default, or live by default?

A July 2026 audit answered those questions for every script. The headline:
almost nothing needs "constant running". Only one job is genuinely recurring
data hygiene (`entities-dedupe`; new ingest keeps minting near-duplicate
entities), and two are backups already invoked on the backup cadence by
`scripts/db-dump.sh`. Notably **`dedupe:edges` is NOT recurring**: the
extractor is delete-then-insert idempotent, so duplicate `mentioned_in` edges
cannot accrue; the dashboard Memory-index card monitors the live duplicate
count and the script is a one-shot remedy if a regression ever appears
(see `docs/architecture.md` §9k). Thirteen scripts are completed one-off
backfills kept only for reference.

## Design

One source of truth, multiple consumers, the same shape as the system
manifest (`server/web/lib/system-manifest/`):

```
server/web/lib/maintenance/registry.ts     ← the registry (data)
        │
        ├─ Phase 1: server/web/scripts/maintain.ts   (CLI: pnpm maintain)
        ├─ Phase 2: server/web/workers/maintenance.ts (pg-boss cron sweeps)
        └─ Phase 3: /debug/integrity Maintenance tab (UI + run history)
```

### Why not heartbeats

Heartbeats (`packages/runtime/src/heartbeats`) are the wrong substrate: every fire resolves
an agent + skill and runs a **model tool-loop**: there is no plain-code
execution path, and `kind:'cron'` is unimplemented (interval/once only).
Scheduling SQL hygiene through an LLM invocation adds cost and nondeterminism
for nothing.

### Why pg-boss

pg-boss is already the background-job substrate and already does cron:
the email/calendar/microsoft workers each run
`boss.schedule(QUEUE, '*/2 * * * *')`. Phase 2 reuses exactly that idiom.

## The registry

Every task declares:

| Field                      | Meaning                                                                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slug`                     | stable id, used by CLI / worker / UI                                                                                                                                                           |
| `kind`                     | `recurring` (drifts back), `remedy` (monitored one-shot, re-run when a dashboard flags drift), `ops` (deliberate event: model change, key rotation, deploy), `backfill` (historical migration) |
| `status`                   | `live` or `retired` (completed backfills, still runnable with `--all`, hidden by default)                                                                                                      |
| `cost`                     | `sql` \| `io` \| `imap` \| `crypto` \| `embedding` \| `llm`, what a live run spends                                                                                                            |
| `schedulable`              | eligible for the Phase-2 cron worker                                                                                                                                                           |
| `script` / `cwd`           | what the runner spawns (`tsx <script>` in `<cwd>`)                                                                                                                                             |
| `applyFlag` / `dryRunFlag` | which convention the script uses; absence of both = live-on-invoke                                                                                                                             |
| `requiresEnv`              | env vars beyond `DATABASE_URL` the script needs                                                                                                                                                |
| `dryRunCost`               | what a DRY run spends when it is not free (a preview that calls a model); CLI and UI both ask to confirm it                                                                                    |
| `uiArgs`                   | values the UI collects and passes as `--<name>=<value>`: `agent` (a slug, for the dry run) or `page` (a review page id, for the apply)                                                         |
| `cliOnly`                  | a reason the UI must refuse the task (flags it cannot collect); unused while `uiArgs` covers the agent/page tasks                                                                              |

**Hard guardrail** (enforced by a runtime assertion at module load and by
`registry.test.ts`): `schedulable` tasks must be free (`isFreeCost`, `sql` or
`io`), `status: 'live'`, `kind: 'recurring'`, and either dry-run-by-default
(`applyFlag`) or `readOnly`. Per the standing cost-safety rule, **model-spending
tasks can never be scheduled**, `re-embed`, `extract-backfill`,
`relations-backfill` etc. stay manual forever. `imap` stays barred too: it burns
mailbox round-trips. `readOnly` is what lets a pure report be scheduled; a
report the operator has to remember to run is exactly the failure it exists to
catch.

`registry.test.ts` also enforces that `schedulable: true` **is true**: that the
task has an in-process sweep the cron will actually reach, and vice versa. See
Phase 2 for the three tasks that silently didn't.

## Phase 1: CLI (`pnpm maintain`) ✅

A single terminal entrypoint that wraps the existing battle-tested scripts
without rewriting them:

```sh
pnpm maintain                     # list live tasks, grouped by kind
pnpm maintain list --all          # include retired backfills
pnpm maintain info <slug>         # full detail: flags, env, cost, notes
pnpm maintain <slug> [flags…]     # run it (flags pass through to the script)
pnpm maintain <slug> --apply      # generic --apply is translated to the
                                  # script's own flag (e.g. --go)
```

Runner behaviour:

- Spawns `tsx <script>` in the task's `cwd` (env inherited from the
  runner, which loads `.env.local`), passing flags through verbatim (except the
  generic `--apply` translation).
- **Spend brake:** a live run of a `cost: llm | embedding` task requires an
  explicit `--yes` in addition to the script's own flags.
- Retired tasks run only with `--force-retired` (they're kept for reference,
  not for casual re-runs; several are destructive or superseded).
- Never schedules anything; Phase 1 is on-demand only.

This CLI is also the seam for a future in-app "CLI screen": the registry is
data, so a web terminal page only needs an API route that lists tasks and
streams a run.

The runner always ends with one line of its own: `maintain: <slug> (LIVE)
finished OK in 12.4 min`, or `FAILED after ...: exit 1`, or `FAILED after
...: killed by SIGKILL (often out of memory ...)`. It spawns `tsx` itself, not
`pnpm exec tsx`, because pnpm exec turns a killed task into a plain exit 1.
A log with no such line was cut off from outside (the runner itself died, or
the terminal that owned its output went away).

## Long runs on a box (`scripts/box-maintain.sh`)

A task that runs for more than a few minutes on a box (`chunk-windows
--apply`, `re-embed`, `extract-backfill`, a big `entities-dedupe`) runs in
its own throwaway container, from your machine:

```sh
scripts/box-maintain.sh <box> chunk-windows                         # dry run
scripts/box-maintain.sh <box> chunk-windows --apply --yes --parallel=16
scripts/box-maintain.sh <box> --follow                              # watch it
scripts/box-maintain.sh <box> --status                              # memory, last lines
```

`<box>` is a label from `.mantle-fleet.json` (as for `scripts/roll.sh`), or
`--ssh <alias>`, or `--here` when you are on the box. Options go before the
task (`--memory=3g`, `--heap=<MB>`, `--owner=<uuid>`); everything after the
task goes to `pnpm maintain` unchanged, spend brake included.

What it starts: `maint-<task>`, from the image mantle_web runs, in mantle_web's
working dir and network namespace (`--network container:mantle_web`: it
reaches Postgres and the providers exactly as the web tier does). It gets
mantle_web's env through a pipe (`--env-file /dev/fd/N`: never in argv, never
on disk), `ALLOWED_USER_ID` from that env or from Postgres
(`mantle_brain_id()`), its own memory limit (default 2g, no swap) and a Node
heap cap at 75% of it. Its output goes to `docker logs` while it runs and to
`~/maint-logs/maint-<task>-<time>.log` on the box (mode 600), and the
container removes itself when the task ends (`--rm`), so the log file is
where the final line lives. `--stop` stops it (the tasks are resumable).

**One maintenance run per box.** It refuses to start while another `maint-*`
container runs, or while a `pnpm maintain` runs inside mantle_web. Two runs
at once in mantle_web OOM-restarted a web tier on 2026-09-24.

The traps it replaces (a 314k-window `chunk-windows` backfill, 2026-10-04,
took four tries):

- **ssh logout kills the run.** `nohup docker exec ... > log &` over ssh died
  the moment the session closed, with no error: the docker client and its
  output pipe belonged to the session. A `docker run -d` container belongs to
  the docker daemon.
- **`docker exec` shares mantle_web's memory limit.** The task and the live
  web tier sit in one cgroup (`WEB_MEM_LIMIT`, 3g by default). The task was
  OOM-killed twice (exit 137, `oom_kill` in mantle_web's `memory.events`);
  the next one could take the web tier with it. A sibling container has its
  own limit: a runaway task dies alone and the runner's last line says why.
- **A run that just stops.** The third try (`docker exec -d`, `--parallel=4`,
  a 1200 MB heap cap) stopped after about 20k windows with no error in its
  log and no new `oom_kill`. A Node heap abort or a thrown error goes to
  stderr, and a detached exec keeps only what you redirect. The sibling
  container sends both streams to its log, and the runner's last line names
  the exit code or the signal. (Not reproduced: the old code at
  `--parallel=4` peaked at 555 MB on a workstation copy, well under that
  heap cap. If it happens again, check whether mantle_web restarted at that
  time: `docker inspect mantle_web --format '{{.State.StartedAt}}'`.)
- **The Maintenance tab is not for long runs**: it runs the task inside the
  web process tree and kills it after 30 minutes.

## Phase 2: scheduled sweeps ✅

- `server/web/workers/maintenance.ts`, the worker idiom exactly (`tsx`
  entrypoint + `waitForOwner` + pg-boss): queue `mantle.maintenance.sweep`,
  `boss.schedule('30 3 * * *', …, { tz: 'UTC' })` (nightly, off-peak). Wired into
  root `pnpm dev` (`maint`) and as `worker_maintenance` in
  `docker-compose.yml` (autoheal + worker healthcheck, depends on `migrate`).
  A dedicated worker was chosen over piggybacking the events worker's tick
  (the backups pattern) for consistency with the other cron workers and
  pg-boss observability (`checkPgBoss`).
- The handler runs `runScheduledSweeps` (`lib/maintenance/sweeps.ts`):
  iterates `schedulable` registry tasks and runs them **in-process** via a
  slug→sweep map, never by spawning scripts. Each task's logic is lifted into
  a shared function used by BOTH the CLI script and the cron, so a job has one
  definition: `runEntitiesDedupe()`, `runDepsDrift()`, `runModelsDrift()`,
  `reapAbandonedTracesAllOwners()`. Belt-and-braces: the sweep re-checks the
  cost on top of the registry assertion, via the registry's own `isFreeCost`.

  **That re-check used to be its own copy of the rule, and it silently ate
  three tasks.** It hardcoded `cost === 'sql'`; when the registry widened to
  `sql | io` for read-only reports the two disagreed, and `deps-drift` was
  dropped on every run despite declaring `schedulable: true`. `traces-reap`
  passed the cost gate but had no slug→sweep entry, so it was dropped too,
  for months, while its own docstring said it ran nightly. Both failure modes
  are silent by construction: the cron logs one `console.warn` at 03:30 UTC
  and carries on. `registry.test.ts` now enforces the claim in both directions
  (every schedulable task has a sweep; every sweep belongs to a schedulable
  task the runner will reach), so `schedulable: true` cannot be decoration
  again.

- **`maintenance_runs`** (migration 0128): slug, source (`cli`/`ui`/`cron`),
  live, state, started/finished, exit code, summary. All three surfaces
  write it, the CLI best-effort (skipped without `DATABASE_URL`), the UI
  run-store on start/finish/cancel/timeout, the cron per sweep. The
  Maintenance tab renders the last 20 as a History table. Rows orphaned in
  `running` by a dead process (CLI Ctrl-C, container restart) are reaped to
  `failed` after 35 min (`reapStaleRuns`, called before history reads and at
  worker boot).
- The table doubles as the cron's **double-fire guard**: a sweep is skipped
  when a `cron`-sourced row (any state, failures arm the guard too, like the
  backups scheduler) exists within ~20h. Protects restarts/duplicate slots on
  top of pg-boss's once-per-slot semantics. Each sweep also races a 30-min
  deadline (parity with the UI timeout).
- Cross-surface overlap is excluded at the database: applying
  `runEntitiesDedupe` takes `pg_try_advisory_xact_lock` on a slug-derived
  key, so CLI, UI, and cron (three different processes) can never merge
  concurrently, a contender fails fast with a clear message. Dry-runs skip
  the lock.
- The schedule contains eleven tasks: `entities-dedupe` (auto tier),
  `traces-reap` and `turns-reap` (all owners), `space-purge` (a deactivated
  login's private personal items after 30 days, see
  [member-logins.md](./member-logins.md) section 6; the worker mounts
  /data/spaces and /data/table-dbs for it), `client-codes-reap` (old client
  sign-in code rows: finished rows and cap skips after 30 days, request
  addresses blanked after 7; plain SQL, see
  [client-logins.md](./client-logins.md) section 3; by hand
  `pnpm -C server/web client-codes:reap`, dry run unless `--apply`),
  `device-tokens-reap` (device token rows 30 days after they were revoked or
  expired; plain SQL; by hand `pnpm -C server/web device-tokens:reap`, dry
  run unless `--apply`),
  `app-access-log-reap` (app access log rows older than 90 days, and the
  contact share trail `share_access_log` by the same 90 days since
  migration 0214, [sharing.md](./sharing.md) section 4b; plain SQL
  in batches, see [client-logins.md](./client-logins.md) section 10; by hand
  `pnpm -C server/web app-access-log:reap`, dry run unless `--apply`),
  `app-trash-purge` (deleted apps past their 30 days in Recently deleted:
  their history rows and snapshot files; by hand
  `pnpm -C server/web app-trash:purge`, dry run unless `--apply`),
  `app-export-catch-up` (app table exports still dirty 20 minutes after a
  write, a sync a restart lost; by hand only, as a changed table is
  re-indexed: `pnpm -C server/web app-export:catch-up`, dry run unless
  `--apply`; the web process already resumes them at boot), and
  the four read-only reports `deps-drift`, `models-drift`, `pinned-model-drift`
  and `pool-fit`. Backups stay on the
  `db-dump.sh` path; they are already scheduled there.

  The three model reports answer different questions and none subsumes the
  others. `models-drift` is CATALOGUE-level: does our onboarding dropdown still
  offer what providers serve? It skips OpenRouter, whose list is built from the
  provider and so cannot drift. `pinned-model-drift` is BRAIN-level: do the ids
  `agents.model` / `ai_workers.model` actually send still exist, and has the
  family moved on? A pin on OpenRouter absolutely can drift, a delisted slug
  404s at turn time, so it covers precisely what the other one skips.
  `pool-fit` is the third axis: not _does the model exist_ but _does it do the
  job_. It came out of 2026-09-02, when an image GENERATOR was sitting in the
  vision ("Read images") pool on all five brains. Generators accept image input
  exactly like readers do, so nothing on the input side caught it, and it would
  have billed image-generation tokens and returned a picture where the vision
  worker parses text. It reuses `poolModelIssue` — the same rule the four write
  guards enforce (docs/model-pools.md), so the report and the guards can never
  disagree.

  `pinned-model-drift` and `pool-fit` report anything they cannot judge as
  **not checked, with a reason**, never as a problem. A provider with no list API, an absent key, and
  a catalogue that does not cover the pin's modality all say nothing about
  whether the pin is valid. That distinction is the whole report: the naive
  version marked a healthy five-box fleet as three models retired, because
  OpenRouter's `/models` enumerates chat only (so every TTS/STT worker read as
  dead) and its auto-alias ids carry a leading `~`. A report that cries wolf
  gets muted, and then the real delisting goes unread too.

  The reports **summarise rather than fail**. A dependency publishing a patch,
  or a provider shipping a model, is not a failed run; a sweep that goes red on
  routine news gets muted within a week and then the signal is gone. Findings
  land in the `maintenance_runs` summary (e.g. `137 packages checked, 72
behind in range, 5 major(s) outside range`) and the Maintenance tab's History
  table is where you read them.

**Audited (2026-07-20):** two adversarial review passes (correctness/data +
concurrency/lifecycle/ops) over the Phase-2 commit; no high-severity
findings. The fixes from the audit: stop-request lifecycle in the run-store
(single-flight lock held until the child actually exits, SIGKILL escalation
after 10 s), the advisory lock above, stale-`running` reaping, cron-side
sweep timeout, worker signal handlers + `unhandledRejection` backstop
(email-sync parity), `{ tz: 'UTC' }` on the schedule, and a memoized toast
context (a pre-existing app-wide fetch/toast loop on persistent 5xx).

## Phase 3: UI ✅ (shipped ahead of Phase 2)

The **Maintenance** tab on `/debug/integrity`, so admins can run tasks
without a terminal:

- `app/(app)/debug/integrity/maintenance-tab.tsx` lists registry tasks
  grouped by kind (retired backfills collapsed), each with **Preview**
  (dry-run) and **Apply/Run** actions; live runs of spend/retired/no-dry-run
  tasks confirm via `AlertDialog` first.
- Server: `lib/maintenance/run-store.ts` spawns the task's script exactly like
  the CLI (single-flight, line-buffered output capped at 2000 lines, 30-min
  kill timer, cancel via SIGTERM) and `lib/maintenance/run-args.ts`, a pure
  `planRun()` shared with the routes, enforces the SAME rails as
  `pnpm maintain` server-side, so the UI cannot bypass them (spend/retired
  confirms, env checks, positional-arg tasks like the backups stay CLI-only).
- **Agent and page tasks** (`persona-notes-to-journal`,
  `journal-rules-reconcile`) run from the tab too: their `uiArgs` make the
  tab ask for the agent before a Preview and the review page before an
  Apply; `planRun()` checks each value's shape (a slug, a uuid) before it
  becomes argv. Their dry run spends (`dryRunCost: 'llm'`), so it confirms.
- **`ALLOWED_USER_ID`** is filled from the signed-in owner when the box
  leaves it empty (`runEnv()`, `SESSION_ENV`), so tasks that scope to the
  owner no longer show "needs env" in the tab. A value set on the box wins.
- Routes: `GET /api/debug/maintenance` (registry + env status + current run),
  `POST/GET /api/debug/maintenance/run` (start / poll), `…/run/cancel`.
  Owner-gated via `getOwnerOr401` like every debug route.
- The console pane polls ~1.2 s while a run is in flight and shows the exit
  state, including failures (e.g. DB unreachable) verbatim.

Still open from the original Phase-3 list: `maintenance_runs` history (lands
with Phase 2's table) and a Memory-index → `dedupe-edges` deep-link.

## Audit inventory (2026-07)

Recurring: `entities-dedupe` (sql, free), `backup-app-dbs` + `backup-table-dbs`
(io, via `db-dump.sh`).
Remedy: `dedupe-edges` (sql; dashboard-monitored).
Ops: `re-embed` (embedding, whole corpus, heavy), `rotate-master-key`
(crypto), `extract-backfill` (indirect LLM), `sync-now` (imap),
`imap-folders` (read-only probe), `pgboss-init` (deploy bootstrap).
Retired backfills: `relations-backfill` (LLM, expensive), `regenerate-digests`
(LLM), `backfill-digest-embeddings` (embedding), `widen-content-hits`,
`backfill-email-salience`, `classify-backfill`, `purge-noncontact-emails`
(destructive), `backfill-block-ids`, `backfill-conversation`,
`merge-part-tables`, `retire-table-blobs`, `backfill-rfc-msg-id`.

Full per-script detail (flags, idempotency, weight) lives in the registry
itself, `pnpm maintain info <slug>`.
