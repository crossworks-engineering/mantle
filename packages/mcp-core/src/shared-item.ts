import { and, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db, nodes, shares } from '@mantle/db';

/**
 * Whether anyone but an admin can read this item now: its own level below
 * admin, a shared folder above it, or a shared item that embeds it
 * (nodes.audience, inherited_level, embedded_level, kept by the database),
 * or a live CONTACT share of it. A contact share lowers no level and serves
 * what the item embeds at any level (lib/shares.ts shareLevels), so a change
 * to the item's content is a change to what the contact reads (access matrix
 * T3). A missing item is false: the tool answers its own "not found".
 */
export async function othersCanRead(ownerId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const [row] = await db
    .select({
      audience: nodes.audience,
      shareLevel: nodes.shareLevel,
      inherited: nodes.inheritedLevel,
      embedded: nodes.embeddedLevel,
      contactShared: sql<boolean>`exists (${db
        .select({ one: sql`1` })
        .from(shares)
        .where(
          and(
            eq(shares.nodeId, nodes.id),
            eq(shares.ownerId, nodes.ownerId),
            isNotNull(shares.contactId),
            isNull(shares.revokedAt),
            or(isNull(shares.expiresAt), gt(shares.expiresAt, sql`now()`)),
          ),
        )})`,
    })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId)))
    .limit(1);
  if (!row) return false;
  return (
    row.audience !== 'admin' ||
    !!row.shareLevel ||
    !!row.inherited ||
    !!row.embedded ||
    row.contactShared === true
  );
}
