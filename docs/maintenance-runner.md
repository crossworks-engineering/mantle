# Maintenance runner — registry, CLI, scheduled sweeps

Status: **Phase 1 shipped** (registry + `pnpm maintain` CLI). Phases 2–3 planned.

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

## Phase 2 — scheduled sweeps (planned)

- `apps/web/workers/maintenance.ts` following the worker idiom
  (`tsx` entrypoint + `waitForOwner` + pg-boss), added to root `pnpm dev`
  concurrently list and as `worker_maintenance` in `docker-compose.yml`
  (depends on `migrate`).
- `boss.schedule(MAINTENANCE_QUEUE, '30 3 * * *')` — nightly, off-peak. The
  handler iterates `schedulable` registry tasks and runs them **in-process**
  (Phase 2 lifts `entities-dedupe`'s auto-tier merge into a shared
  `run()` function rather than spawning tsx).
- A `maintenance_runs` table (migration) records: task slug, started/finished,
  dry-run or live, rows affected, error. The CLI writes to it too, so history
  is unified.
- Initial schedule contains exactly one task: `entities-dedupe` (auto tier).
  Backups stay on the `db-dump.sh` path — they are already scheduled there.

## Phase 3 — UI (planned)

- A **Maintenance** tab on `/debug/integrity`, next to Corpus Audit (whose
  read-only invariant checks are the natural verification companion).
- Lists registry tasks with dry-run preview counts, an Apply button for
  remedies (`dedupe-edges` becomes a button the Memory-index card can deep-link
  to), and the `maintenance_runs` history.
- Retired backfills get archived out of the script list (or shown collapsed
  under "historical").

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
