# pg-boss 10 → 12: schema rebuild runbook

**Read this before deploying any release containing pg-boss 12.** The code change
alone is not enough — the `pgboss` schema has to be rebuilt by hand, once per
box, and a box that gets the new image without this procedure will not start its
workers.

## Why a rebuild, and not a migration

pg-boss's own migration chain is broken between v10 and v11. Measured against a
throwaway Postgres 17:

| release | schema it creates | migrates from 24? |
| --- | ---: | --- |
| 10.1.6 / 10.4.2 | **24** | — 24 is the end of the v10 line |
| 11.0.0 – 11.0.8 | 25 | ❌ `AssertionError: Version 24 not found.` |
| 11.1.2 | 26 | ❌ `relation "pgboss.job_common" does not exist` |
| 12.26.x | 37 | ❌ `oldest supported starting version is 25` |

v11 *creates* schema 25 but ships no 24→25 migration, so every pg-boss 10
install is stranded. Every 11.0.x was tested individually; none of them bridge
it. There is no supported upgrade path, so the schema is dropped and rebuilt.

**Watch out for the CLI's `version` command** — it reports
`Current 24 / Latest 37 / Migrations pending: 13`, which reads like a clean
upgrade. That is arithmetic, not a migratability check; `migrate` then refuses.

## Why this is safe here

`pgboss` holds *transient job state only*. All brain content lives in `public.*`
and is untouched.

- **Queues are recreated on boot** — 12 `createQueue()` calls across the workers
  cover all live queues.
- **Cron schedules are re-registered on boot** — 5 `boss.schedule()` calls cover
  every live schedule.
- **Completed + archived rows are history.** On the dev brain at the time of
  writing: 292 completed, 21,537 archived. No value.

The one thing genuinely lost is **jobs still queued at the moment of the drop**,
which is why the drain step below is not optional.

> On the dev brain all 5,306 "pending" jobs were stale `*/2 * * * *` scheduler
> ticks accumulated 12–17 July by a queue nobody was draining — worthless, the
> next tick does the same work. **Do not assume that holds on every box.** Check.

## Procedure — per box, workers stopped

**1. Back up first.** Non-negotiable; the drop is irreversible.

```bash
pnpm db:dump
```

**2. Stop the workers** and let in-flight jobs finish. Nothing should be writing
to `pgboss` when you drop it.

**3. Check what you are about to discard.**

```sql
select name, state, count(*) from pgboss.job group by 1,2 order by 3 desc;
```

Anything in `created`/`active` that is *not* a `*.scheduler` tick is real queued
work. Decide deliberately: let it drain, or accept the loss and re-enqueue after.

**4. Drop the schema.**

```sql
drop schema pgboss cascade;
```

**5. Deploy the new image and start the workers.** pg-boss 12 creates the schema
fresh at version 37 on first `start()`; the workers then recreate their queues
and re-register their schedules.

**6. Verify.**

```bash
npx pg-boss@12 doctor --connection-string "$DATABASE_URL"
```

Expect `Schema "pgboss" version 37 (latest: 37)` and `✓ No drift detected`. Then
confirm the schedules came back:

```sql
select name, cron from pgboss.schedule order by 1;
```

## This is a one-time manual step. Future upgrades are automatic.

Only the 10→12 hop needs hands, and only because upstream has no 24→25
migration. Once a box is on schema 37, pg-boss self-migrates on `start()` like
it always did. Verified by walking a database up the v12 line:

| installed | result |
| --- | --- |
| 12.0.0 | creates schema **26** |
| 12.10.0 | `start()` auto-migrates 26 → **28** |
| 12.20.0 | `start()` auto-migrates 28 → **31** |
| 12.26.1 | `start()` auto-migrates 31 → **37** |
| 12.26.2 | no schema change, stays 37 |

Nothing manual at any step. And we already have the right hook for it:
[`apps/web/scripts/pgboss-init.ts`](../apps/web/scripts/pgboss-init.ts) runs
exactly one `boss.start()` before any worker comes up (it exists to stop the
workers racing to create the schema), and it's wired into `scripts/up.sh` and the
production migrate gate. That single call is what will carry future schema
versions across, per box, with no intervention.

The refusal that forced this rebuild only applies below schema 25. At 37 we are
far clear of it.

> **`doctor` right after a migration may report indexes as "Building".** v12
> builds some indexes asynchronously, so immediately post-migration you can see
> `Building (async index build in progress — not yet drift)` on
> `job_common.job_common_i7/i8`. That is expected and not drift — re-run
> `doctor` once the build finishes before treating it as a problem.

## Rollout order

Dev brain → run several days under real load (email sync, telegram, runs,
heartbeats, maintenance) → one production box → the rest of the fleet.

**Rolling the image back does not roll the schema back.** A box on schema 37
cannot run pg-boss 10 again without another rebuild in the other direction.

## Code changes already made

- **pg-boss 12 is ESM-only with a named export.** All 10 sites moved from
  `import PgBoss from 'pg-boss'` to `import { PgBoss } from 'pg-boss'`, and the
  test double in `packages/runs/src/boss.test.ts` had to match.
- **`createQueue`/`updateQueue` options are now `Omit<Queue,'name'>`** — the
  queue name is the first argument and repeating it in the options object is
  rejected. Fixed in `apps/api/src/agent/extract-queue.ts`.
- **`pg` is pinned to 8.22.0** in `pnpm-workspace.yaml`. pg-boss 12 requires
  `^8.22.0` while the tree had settled on 8.20.0, and `drizzle-orm` peers on
  `pg` — two `pg` versions made pnpm build two peer-resolved drizzle instances
  whose `SQL<>` types are nominally incompatible, producing **273 typecheck
  errors that look nothing like their cause**. One `pg` → one drizzle → 3 errors,
  all genuine pg-boss API changes.
