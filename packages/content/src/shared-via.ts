/**
 * The folder an item takes its sharing from: the nearest folder granted by hand to a workspace other than Admin
 * whose grant the item takes (its grant rows "via folder", not removed
 * there). The Access
 * control names it ("Shared via Clients / Acme"): moving the item out of the
 * folder, or removing that row in the Grant Access panel, hides it there.
 * Same owner only, so a member's draft never has one.
 *
 * Read-only, on the admin pool (owner routes call it).
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';
import type { AccessReadThrough, AccessSharedVia } from '@mantle/client-types';

export async function sharedViaFolder(
  ownerId: string,
  nodeId: string,
): Promise<AccessSharedVia | null> {
  // A row "via folder" names the folder right above; that folder's own row
  // may come from further up. Follow each workspace's chain to the folder
  // granted by hand, and take the nearest of those.
  const [row] = (await db.execute(sql`
    with recursive chain (ws, folder) as (
      select g.workspace_id, g.via_folder_id
        from item_grants g
        join nodes n on n.id = g.node_id and n.owner_id = ${ownerId}
        join workspaces w on w.id = g.workspace_id and not w.is_admin
       where g.node_id = ${nodeId} and not g.excluded and g.via_folder_id is not null
      union
      select c.ws, fg.via_folder_id
        from chain c
        join item_grants fg on fg.node_id = c.folder and fg.workspace_id = c.ws
       where not fg.excluded and fg.via_folder_id is not null
    )
    select f.id::text as id, f.path::text as path
      from chain c
      join item_grants og on og.node_id = c.folder and og.workspace_id = c.ws
                         and og.via_folder_id is null and not og.excluded
      join nodes f on f.id = c.folder and f.owner_id = ${ownerId}
     order by nlevel(f.path) desc, f.id
     limit 1`)) as unknown as Array<{ id: string; path: string }>;
  if (!row) return null;
  // The folder chain from the kind's top level down to that folder (the
  // kind's root row, one label deep, is not a folder).
  const trail = (await db.execute(sql`
    select f.title
      from nodes f
     where f.owner_id = ${ownerId} and f.type = 'branch'
       and f.path @> ${row.path}::ltree and nlevel(f.path) >= 2
     order by nlevel(f.path)`)) as unknown as Array<{ title: string | null }>;
  return {
    folderId: row.id,
    trail: trail.map((t) => t.title ?? 'Untitled'),
    // Every workspace grant reads as the team's here: clients are not
    // migrated (owner rule 21.9), so no grant is a client one.
    level: 'team',
  };
}

/**
 * What an item is read through by embeds. Nothing: an embed gives no reads (no magic); the Grant Access panel lists the
 * embeds an item's workspaces cannot read ("Grant these too"). Kept for the
 * callers of the old Access control until they go.
 */
export async function readThroughEmbeds(
  _ownerId: string,
  _nodeId: string,
): Promise<AccessReadThrough | null> {
  return null;
}
