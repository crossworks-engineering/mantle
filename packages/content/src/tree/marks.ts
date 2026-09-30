/**
 * One login's marks on items (item_marks): pins, and the opens that feed
 * Recent and Most used. Per login, so two admins of one brain keep their own.
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';
import {
  TREE_KIND_SPECS,
  TREE_PINS_MAX,
  type TreeKind,
  type TreeMarkList,
  type TreeMarkView,
} from '@mantle/client-types/tree';
import { treeCrumbsFor, treeItemFromRow, type ItemSqlRow } from './read';

/** How many items the Recent and Most used views list. */
export const TREE_MARKS_LIST_MAX = 20;

/** The kind of an item the owner has, or null (not theirs, or not a tree kind). */
async function itemKind(ownerId: string, nodeId: string): Promise<TreeKind | null> {
  const rows = (await db.execute(sql`
    select type from nodes where id = ${nodeId} and owner_id = ${ownerId} limit 1`)) as unknown as Array<{
    type: string;
  }>;
  const type = rows[0]?.type;
  const spec = Object.values(TREE_KIND_SPECS).find((s) => s.nodeType === type);
  return spec?.kind ?? null;
}

/** Count one open of an item by this login. False when the item is not one of
 *  the owner's tree items. */
export async function recordItemOpened(
  ownerId: string,
  actorId: string,
  nodeId: string,
): Promise<boolean> {
  if (!(await itemKind(ownerId, nodeId))) return false;
  await db.execute(sql`
    insert into item_marks (actor_id, node_id, open_count, opened_at)
    values (${actorId}, ${nodeId}, 1, now())
    on conflict (actor_id, node_id)
    do update set open_count = item_marks.open_count + 1, opened_at = now()`);
  return true;
}

export type PinResult = { ok: true } | { ok: false; reason: 'not-found' | 'too-many' };

/** Pin or unpin an item for this login; at most TREE_PINS_MAX per kind. */
export async function setItemPinned(
  ownerId: string,
  actorId: string,
  nodeId: string,
  pinned: boolean,
): Promise<PinResult> {
  const kind = await itemKind(ownerId, nodeId);
  if (!kind) return { ok: false, reason: 'not-found' };
  if (!pinned) {
    await db.execute(sql`
      update item_marks set pinned_at = null
       where actor_id = ${actorId} and node_id = ${nodeId}`);
    return { ok: true };
  }
  const [count] = (await db.execute(sql`
    select count(*)::int as n from item_marks m join nodes n on n.id = m.node_id
     where m.actor_id = ${actorId} and m.pinned_at is not null
       and m.node_id <> ${nodeId}
       and n.owner_id = ${ownerId} and n.type = ${TREE_KIND_SPECS[kind].nodeType}`)) as unknown as Array<{
    n: number;
  }>;
  if ((count?.n ?? 0) >= TREE_PINS_MAX) return { ok: false, reason: 'too-many' };
  await db.execute(sql`
    insert into item_marks (actor_id, node_id, pinned_at)
    values (${actorId}, ${nodeId}, now())
    on conflict (actor_id, node_id) do update set pinned_at = coalesce(item_marks.pinned_at, now())`);
  return { ok: true };
}

/** This login's pinned, recent or most used items of a kind, with crumbs. */
export async function listTreeMarks(
  ownerId: string,
  actorId: string,
  kind: TreeKind,
  view: TreeMarkView,
): Promise<TreeMarkList> {
  const spec = TREE_KIND_SPECS[kind];
  const filter =
    view === 'pinned'
      ? sql`m.pinned_at is not null`
      : sql`m.opened_at is not null and m.open_count > 0`;
  const order =
    view === 'pinned'
      ? sql`m.pinned_at asc`
      : view === 'recent'
        ? sql`m.opened_at desc`
        : sql`m.open_count desc, m.opened_at desc`;
  const rows = (await db.execute(sql`
    select n.id, n.path::text as path, n.title, n.data, n.audience, n.updated_at,
           '' as sort_key
      from item_marks m join nodes n on n.id = m.node_id
     where m.actor_id = ${actorId} and ${filter}
       and n.owner_id = ${ownerId} and n.type = ${spec.nodeType}
       and n.path <@ ${spec.root}::ltree
     order by ${order}
     limit ${TREE_MARKS_LIST_MAX}`)) as unknown as ItemSqlRow[];
  const crumbs = await treeCrumbsFor(
    ownerId,
    rows.map((r) => r.path),
  );
  return {
    kind,
    view,
    items: rows.map((r) => ({ ...treeItemFromRow(kind, r), crumbs: crumbs.get(r.path) ?? [] })),
  };
}
