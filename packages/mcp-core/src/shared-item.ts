import { and, eq } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';

/**
 * Whether anyone but an admin can read this item now: its own level below
 * admin, a shared folder above it, or a shared item that embeds it
 * (nodes.audience, inherited_level, embedded_level, kept by the database).
 * A missing item is false: the tool answers its own "not found".
 */
export async function othersCanRead(ownerId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const [row] = await db
    .select({
      audience: nodes.audience,
      shareLevel: nodes.shareLevel,
      inherited: nodes.inheritedLevel,
      embedded: nodes.embeddedLevel,
    })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId)))
    .limit(1);
  if (!row) return false;
  return row.audience !== 'admin' || !!row.shareLevel || !!row.inherited || !!row.embedded;
}
