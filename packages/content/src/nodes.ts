/**
 * Generic node access — the universal `nodes` row, type-blind. Backs the
 * `/n/<id>` permalink (and `GET /api/nodes/[id]`): given an id, resolve the
 * owner-scoped node so callers can route to the right surface by `type`.
 */
import { and, eq } from 'drizzle-orm';
import { db, nodes, type Node } from '@mantle/db';

/** One owner-scoped node's id + type, or null. Owner-scoped so a leaked id for
 *  another owner resolves to null (404) rather than leaking existence. */
export async function getOwnedNode(
  userId: string,
  id: string,
): Promise<Pick<Node, 'id' | 'type'> | null> {
  const [row] = await db
    .select({ id: nodes.id, type: nodes.type })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, userId)))
    .limit(1);
  return row ?? null;
}
