/**
 * The numbered rows of an item's history (node_snapshots, migration 0219):
 * versions written by publish and snapshots written by app-snapshots.ts.
 * Kept apart from both so publish (apps.ts) can append its version without
 * importing the server-only snapshot code.
 */
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
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
  const [inserted] = await tx
    .insert(nodeSnapshots)
    .values({ ...row, seq: Number(top?.next ?? 1) })
    .returning();
  if (!inserted) throw new Error('could not record the snapshot row');
  return inserted;
}
