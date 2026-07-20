# Maintenance runner — registry, CLI, scheduled sweeps

Status: **all three phases shipped.** Phase 1 (registry + `pnpm maintain`
CLI, v0.150.0), Phase 3 (Maintenance tab on `/debug/integrity`, v0.151.0 —
brought forward so admins don't need a terminal), Phase 2 (nightly cron
worker + `maintenance_runs` unified history, v0.153.0).

## Why

The repo accumulated ~22 operational scripts under `apps/web/scripts/` (plus one
in `packages/email`), each with its own pnpm alias, its own flag conventions
(`--apply` vs `--go` vs `--dry-run` vs `--dry`), and no shared answer to the
questions that actually matter before running one:

- Is this a **one-off backfill** that's already done, or **recurring hygiene**
  that drifts back as data arrives?
- Does it **spend money** (chat model / embedding calls) or is it pure SQL?
- Is it dry-run by default, or live by default?

A July 2026 audit answered those questions for every script. The headline:
almost nothing needs "constant running". Only one job is genuinely recurring
data hygiene (`entities-dedupe` — new ingest keeps minting near-duplicate
entities), and two are backups already invoked on the backup cadence by
`scripts/db-dump.sh`. Notably **`dedupe:edges` is NOT recurring** — the
extractor is delete-then-insert idempotent, so duplicate `mentioned_in` edges
cannot accrue; the dashboard Memory-index card monitors the live duplicate
count and the script is a one-shot remedy if a regression ever appears
(see `docs/architecture.md` §9k). Thirteen scripts are completed one-off
backfills kept only for reference.

## Design

One source of truth, multiple consumers — the same shape as the system
manifest (`apps/web/lib/system-manifest/`):

```
apps/web/lib/maintenance/registry.ts     ← the registry (data)
        │
        ├─ Phase 1: apps/web/scripts/maintain.ts   (CLI: pnpm maintain)
        ├─ Phase 2: apps/web/workers/maintenance.ts (pg-boss cron sweeps)
        └─ Phase 3: /debug/integrity Maintenance tab (UI + run history)
```

### Why not heartbeats

Heartbeats (`packages/heartbeats`) are the wrong substrate: every fire resolves
an agent + skill and runs a **model tool-loop** — there is no plain-code
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
| `status`                   | `live` or `retired` (completed backfills — still runnable with `--all`, hidden by default)                                                                                                     |
| `cost`                     | `sql` \| `io` \| `imap` \| `crypto` \| `embedding` \| `llm` — what a live run spends                                                                                                           |
| `schedulable`              | eligible for the Phase-2 cron worker                                                                                                                                                           |
| `script` / `cwd`           | what the runner spawns (`tsx <script>` in `<cwd>`)                                                                                                                                             |
| `applyFlag` / `dryRunFlag` | which convention the script uses; absence of both = live-on-invoke                                                                                                                             |
| `requiresEnv`              | env vars beyond `DATABASE_URL` the script needs                                                                                                                                                |

**Hard guardrail** (enforced by a runtime assertion at module load and by
`registry.test.ts`): `schedulable` tasks must be `cost: 'sql'`, `status:
'live'`, `kind: 'recurring'`, and dry-run-by-default. Per the standing
cost-safety rule, **model-spending tasks can never be scheduled** — `re-embed`,
`extract-backfill`, `relations-backfill` etc. stay manual forever.

## Phase 1 — CLI (`pnpm maintain`) ✅

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

- Spawns `pnpm exec tsx <script>` in the task's `cwd` (env inherited from the
  runner, which loads `.env.local`), passing flags through verbatim (except the
  generic `--apply` translation).
- **Spend brake:** a live run of a `cost: llm | embedding` task requires an
  explicit `--yes` in addition to the script's own flags.
- Retired tasks run only with `--force-retired` (they're kept for reference,
  not for casual re-runs — several are destructive or superseded).
- Never schedules anything; Phase 1 is on-demand only.

This CLI is also the seam for a future in-app "CLI screen": the registry is
data, so a web terminal page only needs an API route that lists tasks and
streams a run.

## Phase 2 — scheduled sweeps ✅

- `apps/web/workers/maintenance.ts` — the worker idiom exactly (`tsx`
  entrypoint + `waitForOwner` + pg-boss): queue `mantle.maintenance.sweep`,
  `boss.schedule('30 3 * * *', …, { tz: 'UTC' })` (nightly, off-peak). Wired into
  root `pnpm dev` (`maint`) and as `worker_maintenance` in
  `docker-compose.yml` (autoheal + worker healthcheck, depends on `migrate`).
  A dedicated worker was chosen over piggybacking the events worker's tick
  (the backups pattern) for consistency with the other cron workers and
  pg-boss observability (`checkPgBoss`).
- The handler runs `runScheduledSweeps` (`lib/maintenance/sweeps.ts`):
  iterates `schedulable` registry tasks and runs them **in-process** via a
  slug→sweep map — never by spawning scripts. `entities-dedupe`'s tier merge
  is lifted into a shared `runEntitiesDedupe()` used by BOTH the CLI script
  and the cron, so the hygiene job has one definition. Belt-and-braces: the
  sweep re-checks `cost === 'sql'` on top of the registry assertion.
- **`maintenance_runs`** (migration 0128): slug, source (`cli`/`ui`/`cron`),
  live, state, started/finished, exit code, summary. All three surfaces
  write it — the CLI best-effort (skipped without `DATABASE_URL`), the UI
  run-store on start/finish/cancel/timeout, the cron per sweep. The
  Maintenance tab renders the last 20 as a History table. Rows orphaned in
  `running` by a dead process (CLI Ctrl-C, container restart) are reaped to
  `failed` after 35 min (`reapStaleRuns`, called before history reads and at
  worker boot).
- The table doubles as the cron's **double-fire guard**: a sweep is skipped
  when a `cron`-sourced row (any state — failures arm the guard too, like the
  backups scheduler) exists within ~20h. Protects restarts/duplicate slots on
  top of pg-boss's once-per-slot semantics. Each sweep also races a 30-min
  deadline (parity with the UI timeout).
- Cross-surface overlap is excluded at the database: applying
  `runEntitiesDedupe` takes `pg_try_advisory_xact_lock` on a slug-derived
  key, so CLI, UI, and cron (three different processes) can never merge
  concurrently — a contender fails fast with a clear message. Dry-runs skip
  the lock.
- The schedule contains exactly one task: `entities-dedupe` (auto tier).
  Backups stay on the `db-dump.sh` path — they are already scheduled there.

**Audited (2026-07-20):** two adversarial review passes (correctness/data +
concurrency/lifecycle/ops) over the Phase-2 commit; no high-severity
findings. The fixes from the audit: stop-request lifecycle in the run-store
(single-flight lock held until the child actually exits, SIGKILL escalation
after 10 s), the advisory lock above, stale-`running` reaping, cron-side
sweep timeout, worker signal handlers + `unhandledRejection` backstop
(email-sync parity), `{ tz: 'UTC' }` on the schedule, and a memoized toast
context (a pre-existing app-wide fetch/toast loop on persistent 5xx).

## Phase 3 — UI ✅ (shipped ahead of Phase 2)

The **Maintenance** tab on `/debug/integrity` — so admins can run tasks
without a terminal:

- `app/(app)/debug/integrity/maintenance-tab.tsx` lists registry tasks
  grouped by kind (retired backfills collapsed), each with **Preview**
  (dry-run) and **Apply/Run** actions; live runs of spend/retired/no-dry-run
  tasks confirm via `AlertDialog` first.
- Server: `lib/maintenance/run-store.ts` spawns the task's script exactly like
  the CLI (single-flight, line-buffered output capped at 2000 lines, 30-min
  kill timer, cancel via SIGTERM) and `lib/maintenance/run-args.ts` — a pure
  `planRun()` shared with the routes — enforces the SAME rails as
  `pnpm maintain` server-side, so the UI cannot bypass them (spend/retired
  confirms, env checks, positional-arg tasks like the backups stay CLI-only).
- Routes: `GET /api/debug/maintenance` (registry + env status + current run),
  `POST/GET /api/debug/maintenance/run` (start / poll), `…/run/cancel`.
  Owner-gated via `getOwnerOr401` like every debug route.
- The console pane polls ~1.2 s while a run is in flight and shows the exit
  state — including failures (e.g. DB unreachable) verbatim.

Still open from the original Phase-3 list: `maintenance_runs` history (lands
with Phase 2's table) and a Memory-index → `dedupe-edges` deep-link.

## Audit inventory (2026-07)

Recurring: `entities-dedupe` (sql, free), `backup-app-dbs` + `backup-table-dbs`
(io, via `db-dump.sh`).
Remedy: `dedupe-edges` (sql; dashboard-monitored).
Ops: `re-embed` (embedding, whole corpus — heavy), `rotate-master-key`
(crypto), `extract-backfill` (indirect LLM), `sync-now` (imap),
`imap-folders` (read-only probe), `pgboss-init` (deploy bootstrap).
Retired backfills: `relations-backfill` (LLM, expensive), `regenerate-digests`
(LLM), `backfill-digest-embeddings` (embedding), `widen-content-hits`,
`backfill-email-salience`, `classify-backfill`, `purge-noncontact-emails`
(destructive), `backfill-block-ids`, `backfill-conversation`,
`merge-part-tables`, `retire-table-blobs`, `backfill-rfc-msg-id`.

Full per-script detail (flags, idempotency, weight) lives in the registry
itself — `pnpm maintain info <slug>`.
