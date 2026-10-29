/**
 * Whether others can read an item, for the rule that a key or a linked
 * brain never changes content others read (key-shared-content.ts).
 * @mantle/mcp-core re-exports it (its shared-item.ts), so the gate's pre-run
 * check and the v1 page route read one copy.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';

/**
 * Whether anyone but an admin can read this item now (from the grants): a
 * workspace other than Admin holds it (its read_ws), or it
 * has a live link (an open one, or a CONTACT share: a contact share serves
 * what the item embeds too, lib/shares.ts, so a change to the item's content
 * is a change to what the contact reads). A missing item, or one the
 * caller's scope does not read, is false: the tool answers its own "not
 * found".
 *
 * The holders and links are read by a definer (mantle_item_others_read,
 * 0297): in a scope the workspace role reads only the scope's own
 * workspaces, so a holder the key's login is not a user of read as no
 * holder. In a scope the definer answers
 * NULL for an item the scope does not read (no oracle of its holders); a
 * row read here with a NULL answer (the system pool with a scope set) is
 * read as others reading it: the change is refused, never let through.
 */
export async function othersCanRead(ownerId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const [row] = await db
    .select({
      others: sql<
        boolean | null
      >`"public"."mantle_item_others_read"(${nodes.ownerId}, ${nodes.id})`,
    })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId)))
    .limit(1);
  return row ? row.others !== false : false;
}
