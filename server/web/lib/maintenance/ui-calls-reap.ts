/**
 * Trim the agent UI calls (maintenance sweep `ui-calls-reap`,
 * docs/agent-ui.md; plain SQL, no model). Every ui_* tool call lands a row in
 * ui_calls (migration 0363). A turn clears its rows' results when it ends
 * (@mantle/db clearTurnUiCalls); this deletes every row older than
 * {@link UI_CALLS_RETENTION_HOURS} hours, so a turn that never ended (a
 * runner gone for good) leaves nothing behind either. In batches, so a first
 * run on a big table holds no long lock.
 *
 * Shared by the cron sweep (sweeps.ts) and the script, so there is one
 * definition of the rule.
 */
import { sql } from 'drizzle-orm';
import { db, uiCalls, UI_CALLS_RETENTION_HOURS } from '@mantle/db';

export { UI_CALLS_RETENTION_HOURS };

const BATCH = 10_000;

/** Delete the rows past the retention. `dryRun` counts without deleting.
 *  Idempotent. */
export async function reapUiCalls(
  opts: { now?: Date; dryRun?: boolean } = {},
): Promise<{ deleted: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - UI_CALLS_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
  if (opts.dryRun) {
    const [row] = (await db.execute(
      sql`select count(*)::int as n from ui_calls where created_at < ${cutoff}::timestamptz`,
    )) as unknown as { n: number }[];
    return { deleted: row?.n ?? 0 };
  }
  let deleted = 0;
  for (;;) {
    const gone = await db
      .delete(uiCalls)
      .where(
        sql`${uiCalls.id} in (
        select id from ui_calls where created_at < ${cutoff}::timestamptz limit ${BATCH})`,
      )
      .returning({ id: uiCalls.id });
    deleted += gone.length;
    if (gone.length < BATCH) return { deleted };
  }
}

/** One line for the maintenance run row. */
export function summariseUiCallsReap(r: { deleted: number }): string {
  return r.deleted === 0 ? 'nothing to reap' : `deleted ${r.deleted} agent UI call row(s)`;
}
