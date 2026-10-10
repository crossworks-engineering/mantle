/**
 * Extractions the workspaces heads check parked (plan V5; the stamp is
 * `data.extract_parked`, extract-exempt.ts). The push worker reads this on
 * each "needs you" event so an admin's phone hears of a new one. A count
 * query on the system pool: what an admin must see is never scoped away.
 */
import { sql } from 'drizzle-orm';
import { systemDb } from './client';
import { extractParkedSql } from './extract-exempt';
import { nodes } from './schema/nodes';

export interface ParkedExtractions {
  count: number;
  /** When the newest current stamp was set (ISO), or null. */
  newest: string | null;
}

export async function parkedExtractions(ownerId: string): Promise<ParkedExtractions> {
  // `data ? 'extract_parked'` matches the partial index nodes_extract_parked_idx
  // (0246), so this reads the few parked rows, not every node.
  const rows = (await systemDb.execute(sql`
    SELECT count(*)::int AS n, max((${nodes.data}->'extract_parked'->>'at')::timestamptz) AS newest
      FROM ${nodes}
     WHERE ${nodes.ownerId} = ${ownerId}
       AND ${nodes.data} ? 'extract_parked'
       AND ${extractParkedSql()}`)) as unknown as {
    n: number;
    newest: Date | string | null;
  }[];
  const r = rows[0];
  const newest = r?.newest ? new Date(r.newest).toISOString() : null;
  return { count: r?.n ?? 0, newest };
}
