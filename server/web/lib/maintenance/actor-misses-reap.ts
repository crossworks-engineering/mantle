/**
 * Trim the actor check's miss log (maintenance sweep `actor-misses-reap`,
 * workspaces arch A2a; plain SQL, no model). A statement that ran with no
 * actor lands a row in actor_check_misses (capped at 100 an hour per
 * check), and nothing else removes them. A row older than
 * {@link ACTOR_MISSES_RETENTION_DAYS} days goes, in batches so a first run
 * on a big table holds no long lock.
 *
 * Shared by the cron sweep (sweeps.ts) and the script, so there is one
 * definition of the rule.
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';

export const ACTOR_MISSES_RETENTION_DAYS = 14;

const BATCH = 10_000;

/** Delete the miss rows past the retention. `dryRun` counts without
 *  deleting. Idempotent. */
export async function reapActorMisses(
  opts: { now?: Date; dryRun?: boolean } = {},
): Promise<{ deleted: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - ACTOR_MISSES_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  if (opts.dryRun) {
    const [row] = (await db.execute(
      sql`select count(*)::int as n from actor_check_misses where at < ${cutoff}::timestamptz`,
    )) as unknown as { n: number }[];
    return { deleted: row?.n ?? 0 };
  }
  let deleted = 0;
  for (;;) {
    const gone = (await db.execute(sql`
      delete from actor_check_misses where id in (
        select id from actor_check_misses where at < ${cutoff}::timestamptz limit ${BATCH})
      returning id`)) as unknown as unknown[];
    deleted += gone.length;
    if (gone.length < BATCH) return { deleted };
  }
}

/** One line for the maintenance run row. */
export function summariseActorMissesReap(r: { deleted: number }): string {
  return r.deleted === 0 ? 'nothing to reap' : `deleted ${r.deleted} actor miss row(s)`;
}
