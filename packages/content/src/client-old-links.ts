/**
 * Old live links ABOVE a client-level item (client logins audit A11). Before
 * C1, "client" meant "anyone with the link", so a client folder or a client
 * page could carry an open link. Those links stay live until the old client
 * links are retired (C3), and they serve more than their own item: a client
 * folder's link lists and serves what sits under it at client or public
 * level, a client page's link serves what it embeds at those levels
 * (server/web/lib/shares.ts, linkLevels). So an item set to client AFTER C1
 * under such a folder or inside such a page is open to anyone holding that
 * link, although its own row says "no link".
 *
 * This names those links, for the "What clients see" report and the Access
 * popover. Read-only, on the admin pool (owner routes call it). It reports
 * a little wide rather than narrow: a folder link is named for everything
 * under the folder, even where a team subfolder in between would hide it.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, nodes, pages, shares } from '@mantle/db';
import type { ClientOldLinkAbove } from '@mantle/client-types';
import { pageRefs } from './embed-refs';

const LIVE = sql`(${shares.expiresAt} is null or ${shares.expiresAt} > now())`;

/**
 * Per item id: the live links on a client folder that holds it (its path is
 * inside the folder's) and on a client page that embeds it. Only ids given
 * appear; an item with none is absent from the map.
 */
export async function oldLinksAbove(
  ownerId: string,
  itemIds: readonly string[],
): Promise<Map<string, ClientOldLinkAbove[]>> {
  const out = new Map<string, ClientOldLinkAbove[]>();
  if (itemIds.length === 0) return out;
  const add = (id: string, link: ClientOldLinkAbove) => {
    const list = out.get(id) ?? [];
    if (!list.some((l) => l.shareId === link.shareId)) list.push(link);
    out.set(id, list);
  };

  // (a) A client folder with a live link, above the item.
  const idList = sql.join(
    itemIds.map((i) => sql`${i}::uuid`),
    sql`, `,
  );
  const folderRows = (await db.execute(sql`
    select i.id as "itemId", s.id as "shareId", f.id as "nodeId", f.title, f.type
      from nodes i
      join nodes f on f.owner_id = i.owner_id and f.type = 'branch' and f.id <> i.id
                  and f.audience = 'client' and i.path <@ f.path
      join shares s on s.node_id = f.id and s.owner_id = ${ownerId}
                   and s.revoked_at is null and s.contact_id is null
                   and (s.expires_at is null or s.expires_at > now())
     where i.owner_id = ${ownerId} and i.id in (${idList})
     order by s.created_at`)) as unknown as {
    itemId: string;
    shareId: string;
    nodeId: string;
    title: string;
    type: string;
  }[];
  for (const r of folderRows) {
    add(r.itemId, {
      shareId: r.shareId,
      nodeId: r.nodeId,
      title: r.title,
      type: r.type,
      via: 'folder',
    });
  }

  // (b) A client page with a live link that embeds the item. There are few
  // such pages (only old client links), so their docs are read and scanned.
  const pageRows = await db
    .select({
      shareId: shares.id,
      nodeId: nodes.id,
      title: nodes.title,
      type: nodes.type,
      doc: pages.doc,
    })
    .from(shares)
    .innerJoin(nodes, eq(nodes.id, shares.nodeId))
    .innerJoin(pages, eq(pages.nodeId, nodes.id))
    .where(
      and(
        eq(shares.ownerId, ownerId),
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'page'),
        eq(nodes.audience, 'client'),
        isNull(shares.revokedAt),
        // Open links only: a contact share (0214) is not an old client link.
        isNull(shares.contactId),
        LIVE,
      ),
    )
    .orderBy(shares.createdAt);
  if (pageRows.length) {
    const wanted = new Set(itemIds);
    for (const p of pageRows) {
      for (const id of pageRefs(p.doc).embeds) {
        if (id === p.nodeId || !wanted.has(id)) continue;
        add(id, {
          shareId: p.shareId,
          nodeId: p.nodeId,
          title: p.title,
          type: p.type,
          via: 'page',
        });
      }
    }
  }
  return out;
}

/** The same for one item (the Access popover). */
export async function oldLinksAboveItem(
  ownerId: string,
  itemId: string,
): Promise<ClientOldLinkAbove[]> {
  return (await oldLinksAbove(ownerId, [itemId])).get(itemId) ?? [];
}
