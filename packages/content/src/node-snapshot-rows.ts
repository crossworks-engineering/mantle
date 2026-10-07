/**
 * The numbered rows of an item's history (node_snapshots, migration 0219):
 * versions written by publish and snapshots written by app-snapshots.ts.
 * Kept apart from both so publish (apps.ts) can append its version without
 * importing the server-only snapshot code.
 */
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { env, envInt } from '@mantle/config';
import { db, nodeSnapshots, type NewNodeSnapshot, type NodeSnapshot } from '@mantle/db';

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** sha256 of a code payload as JSON: a cheap "did the code change" check. */
export function codeHash(code: unknown): string {
  return createHash('sha256').update(JSON.stringify(code)).digest('hex');
}

/**
 * Append one row with the node's next `seq`, inside the caller's transaction.
 * A per-node advisory lock (held to the end of that transaction) makes the
 * max-plus-one safe when a publish and a snapshot land together.
 */
export async function insertNodeSnapshot(
  tx: DbTx,
  row: Omit<NewNodeSnapshot, 'seq' | 'createdAt'>,
): Promise<NodeSnapshot> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`node-seq:${row.nodeId}`}, 0))`,
  );
  const [top] = await tx
    .select({ next: sql<number>`coalesce(max(${nodeSnapshots.seq}), 0) + 1` })
    .from(nodeSnapshots)
    .where(eq(nodeSnapshots.nodeId, row.nodeId));
  const files = row.code?.source.files;
  const sizes = files
    ? {
        fileCount: Object.keys(files).length,
        sourceBytes: Object.values(files).reduce((n, f) => n + Buffer.byteLength(f, 'utf8'), 0),
        hasDraft: row.code?.draft != null,
      }
    : {};
  const [inserted] = await tx
    .insert(nodeSnapshots)
    .values({ ...row, ...sizes, seq: Number(top?.next ?? 1) })
    .returning();
  if (!inserted) throw new Error('could not record the snapshot row');
  return inserted;
}

/** A size setting in MB, as bytes. Compose passes an unset variable as '',
 *  which must read as the default, not as 0. */
export function envMbBytes(name: Parameters<typeof envInt>[0], defaultMb: number): number {
  const mb = env(name)?.trim() ? envInt(name, defaultMb, 1) : defaultMb;
  return mb * 1024 * 1024;
}

/**
 * Prune one node's pruneable history rows in ONE statement (apps audit
 * 2026-10-02, items 3, 5 and 11): of the rows with one of `triggers`, keep
 * the newest `keep`, and of those only as many as fit in `maxBytes` (the
 * newest always stays, whatever its size). Returns the removed rows' file
 * paths: the caller removes the files after the rows.
 *
 * One statement, ranked by `seq`, so a row another process inserts
 * meanwhile is never removed: it is not in this statement's view, and its
 * seq is above every row that is (a read-then-delete removed it with its
 * file, a pre_delete snapshot included).
 */
export async function pruneHistoryRows(
  nodeId: string,
  triggers: readonly string[],
  keep: number,
  maxBytes: number,
): Promise<(string | null)[]> {
  if (!triggers.length) return [];
  const list = sql.join(
    triggers.map((t) => sql`${t}`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    delete from node_snapshots
     where id in (
       select id from (
         select id,
                row_number() over w as rn,
                sum(coalesce(db_bytes, 0)) over w as cum
           from node_snapshots
          where node_id = ${nodeId} and trigger in (${list})
         window w as (order by seq desc rows between unbounded preceding and current row)
       ) ranked
      where rn > ${keep} or (rn > 1 and cum > ${maxBytes})
     )
    returning db_path`)) as unknown as { db_path: string | null }[];
  return rows.map((r) => r.db_path);
}
