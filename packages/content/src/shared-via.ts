/**
 * The folder an item takes its share from (folder plan phase 4, "Access
 * control inside a shared folder"): the nearest shared folder holding it,
 * by the same rule as `mantle_inherited_level` (migration 0200). An item
 * holds its own folder's share (its path IS its folder's path); a folder
 * only what is above it. Same owner only, so a member's draft never has one.
 *
 * The Access control names it ("Shared via Clients / Acme") and uses its
 * level as the floor: the item is read at least there, so raising it above
 * is not offered ("Move it out of the shared folder to hide it").
 *
 * Read-only, on the admin pool (owner routes call it).
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';
import type { AccessSharedVia } from '@mantle/client-types';

export async function sharedViaFolder(
  ownerId: string,
  nodeId: string,
): Promise<AccessSharedVia | null> {
  const [row] = (await db.execute(sql`
    select a.id::text as id, a.path::text as path, a.share_level as level
      from nodes n
      join nodes a
        on a.owner_id = n.owner_id and a.share_level is not null
       and a.path @> n.path and (n.type <> 'branch' or a.path <> n.path)
     where n.id = ${nodeId} and n.owner_id = ${ownerId}
       and n.inherited_level is not null
     order by nlevel(a.path) desc
     limit 1`)) as unknown as Array<{ id: string; path: string; level: string }>;
  if (!row || (row.level !== 'team' && row.level !== 'client')) return null;
  // The folder chain from the kind's top level down to the shared folder
  // (the kind's root row, one label deep, is not a folder).
  const trail = (await db.execute(sql`
    select f.title
      from nodes f
     where f.owner_id = ${ownerId} and f.type = 'branch'
       and f.path @> ${row.path}::ltree and nlevel(f.path) >= 2
     order by nlevel(f.path)`)) as unknown as Array<{ title: string | null }>;
  return {
    folderId: row.id,
    trail: trail.map((t) => t.title ?? 'Untitled'),
    level: row.level,
  };
}
