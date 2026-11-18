/**
 * Files the brain could not read (a current terminal skip of a read failure,
 * READ_FAILURE_SKIPS: the parser refused the file, a PDF too large to render,
 * a locked PDF, bytes not in storage). The push worker reads this on each
 * "needs you" event, so an admin's phone hears of a new one (task 8d40932a:
 * a 347 MB spec book failed with nothing on any screen). A count query on the
 * system pool: what an admin must see is never scoped away.
 */
import { sql } from 'drizzle-orm';
import { systemDb } from './gateway/handles';
import { extractSkippedSql, READ_FAILURE_SKIPS } from './extract-exempt';
import { nodes } from './schema/nodes';

export interface FailedFileReads {
  count: number;
  /** When the newest current verdict was stamped (ISO), or null. */
  newest: string | null;
}

export async function failedFileReads(ownerId: string): Promise<FailedFileReads> {
  const reasons = sql.join(
    READ_FAILURE_SKIPS.map((r) => sql`${r}`),
    sql`, `,
  );
  const rows = (await systemDb.execute(sql`
    SELECT count(*)::int AS n, max((${nodes.data}->'extract_skipped'->>'at')::timestamptz) AS newest
      FROM ${nodes}
     WHERE ${nodes.ownerId} = ${ownerId}
       AND ${nodes.type} = 'file'
       AND ${nodes.data}->'extract_skipped'->>'reason' IN (${reasons})
       AND ${extractSkippedSql()}`)) as unknown as {
    n: number;
    newest: Date | string | null;
  }[];
  const r = rows[0];
  const newest = r?.newest ? new Date(r.newest).toISOString() : null;
  return { count: r?.n ?? 0, newest };
}
