/**
 * Trim the MCP call log (maintenance sweep `mcp-calls-reap`, Journal v3 J8;
 * plain SQL, no model). Every MCP tool call lands a row in mcp_calls
 * (migration 0343), and nothing else removes them. A row older than
 * {@link MCP_CALLS_RETENTION_DAYS} days goes, in batches so a first run on
 * a big table holds no long lock.
 *
 * Shared by the cron sweep (sweeps.ts) and the script, so there is one
 * definition of the rule.
 */
import { sql } from 'drizzle-orm';
import { db, mcpCalls, MCP_CALLS_RETENTION_DAYS } from '@mantle/db';

export { MCP_CALLS_RETENTION_DAYS };

const BATCH = 10_000;

/** Delete the rows past the retention. `dryRun` counts without deleting.
 *  Idempotent. */
export async function reapMcpCalls(
  opts: { now?: Date; dryRun?: boolean } = {},
): Promise<{ deleted: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - MCP_CALLS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  if (opts.dryRun) {
    const [row] = (await db.execute(
      sql`select count(*)::int as n from mcp_calls where created_at < ${cutoff}::timestamptz`,
    )) as unknown as { n: number }[];
    return { deleted: row?.n ?? 0 };
  }
  let deleted = 0;
  for (;;) {
    const gone = await db
      .delete(mcpCalls)
      .where(
        sql`${mcpCalls.id} in (
        select id from mcp_calls where created_at < ${cutoff}::timestamptz limit ${BATCH})`,
      )
      .returning({ id: mcpCalls.id });
    deleted += gone.length;
    if (gone.length < BATCH) return { deleted };
  }
}

/** One line for the maintenance run row. */
export function summariseMcpCallsReap(r: { deleted: number }): string {
  return r.deleted === 0 ? 'nothing to reap' : `deleted ${r.deleted} MCP call row(s)`;
}
