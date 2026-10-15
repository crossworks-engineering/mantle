/**
 * Whether others can read an item (workspaces W5b2), for the rule that a
 * key or a linked brain never changes content others read
 * (key-shared-content.ts). Moved from @mantle/mcp-core in A5 step 3a, which
 * re-exports it (its shared-item.ts), so the gate's pre-run check and the
 * v1 page route read one copy.
 */
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db, nodes, shares, heldBySql } from '@mantle/db';

/**
 * Whether anyone but an admin can read this item now (workspaces W5b2, from
 * the grants): a workspace other than Admin holds it (its read_ws), or it
 * has a live link (an open one, or a CONTACT share: a contact share serves
 * what the item embeds too, lib/shares.ts, so a change to the item's content
 * is a change to what the contact reads, access matrix T3). The caller's own
 * private workspace will not count (private workspaces come with W6b; a
 * personal item has no grants until then). A missing item is false: the
 * tool answers its own "not found".
 */
export async function othersCanRead(ownerId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const [row] = await db
    .select({
      heldBeyondAdmin: sql<boolean>`exists (
        select 1 from workspaces w where ${heldBySql(undefined, sql`w.id`)} and not w.is_admin)`,
      linked: sql<boolean>`exists (${db
        .select({ one: sql`1` })
        .from(shares)
        .where(
          and(
            eq(shares.nodeId, nodes.id),
            eq(shares.ownerId, nodes.ownerId),
            isNull(shares.revokedAt),
            or(isNull(shares.expiresAt), gt(shares.expiresAt, sql`now()`)),
          ),
        )})`,
    })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId)))
    .limit(1);
  if (!row) return false;
  return row.heldBeyondAdmin === true || row.linked === true;
}
