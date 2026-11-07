/**
 * A login's favorite workspace items (the rail's Favorites tab). The list
 * is the login's own `navFavorites` (profile preferences): an entry is a
 * screen's href, or `/n/<id>` for an item. This reads what the rail shows
 * for the item entries.
 *
 * One read, in the caller's own scope: an item the login can no longer
 * read, or one deleted, simply does not come back, and the rail hides it.
 * No rights check of its own.
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';
import { TREE_KIND_SPECS, type TreeKind } from '@mantle/client-types/tree';
import type { NavFavoriteItem } from '@mantle/client-types';
import { TREE_LIVE_KINDS, kindItemFilter } from './kinds';
import { treeItemFromRow, type ItemSqlRow } from './read';

const ITEM_HREF = /^\/n\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The item id of a `/n/<uuid>` entry, else null (a screen's href). */
export function navFavoriteItemId(href: string): string | null {
  return ITEM_HREF.exec(href)?.[1]?.toLowerCase() ?? null;
}

/** The item entries of `hrefs` the caller can open now, in list order. */
export async function navFavoriteItemsFor(
  ownerId: string,
  hrefs: readonly string[],
): Promise<NavFavoriteItem[]> {
  // id -> the entry as stored, first one wins.
  const entries = new Map<string, string>();
  for (const href of hrefs) {
    const id = navFavoriteItemId(href);
    if (id && !entries.has(id)) entries.set(id, href);
  }
  const ids = [...entries.keys()];
  if (ids.length === 0) return [];
  // Each live kind's own rule (its type, under its root, its item filter),
  // as the tree lists it: a task archived or an item in the trash is gone.
  const kinds = sql.join(
    TREE_LIVE_KINDS.map((kind) => {
      const spec = TREE_KIND_SPECS[kind];
      return sql`(n.type = ${spec.nodeType} and n.path <@ ${spec.root}::ltree ${kindItemFilter(kind, 'n')})`;
    }),
    sql` or `,
  );
  const rows = (await db.execute(sql`
    select n.id::text as id, n.type::text as type, n.path::text as path, n.title, n.data,
           n.updated_at, '' as sort_key
      from nodes n
     where n.owner_id = ${ownerId}
       and n.id in (${sql.join(
         ids.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
       and (${kinds})`)) as unknown as Array<ItemSqlRow & { type: string }>;
  const kindOf = new Map<string, TreeKind>(
    TREE_LIVE_KINDS.map((k) => [TREE_KIND_SPECS[k].nodeType, k]),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: NavFavoriteItem[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    const kind = row ? kindOf.get(row.type) : undefined;
    if (!row || !kind) continue;
    const item = treeItemFromRow(kind, row);
    out.push({
      href: entries.get(id)!,
      id,
      kind,
      title: item.title,
      icon: item.icon,
      color: item.color,
    });
  }
  return out;
}
