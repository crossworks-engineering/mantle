/**
 * The bundle of a personal item (plan 6.2; audit F04, F18): the item plus
 * everything that renders inside it, repeated until nothing new joins. Only
 * items of the SAME space join (the author's own); a child page joins with
 * its parent. Links and mentions never join: they stay where they are.
 *
 * Where a bundle is used:
 *  - Submit records it (`space_item_bundles`, migration 0180). While the
 *    root is submitted every item in it is frozen, so what the admin reviews
 *    is what Accept moves. Recall, Return and Accept clear the record.
 *  - Accept moves exactly the recorded bundle (member-review.ts). A root
 *    submitted before 0180 has no record: its bundle is worked out at accept.
 *  - A LEFT-BEHIND item (a deactivated author's team-shared item, never
 *    submitted) takes only items that are themselves shared or submitted:
 *    admins never read a member's private items.
 *  - The 30-day purge keeps every item in the bundle of a shared or
 *    submitted item, so nothing it shows or sends is deleted under it.
 *
 * Shared by the member side (Submit, on the space role) and the admin side
 * (review, accept, purge, on the admin pool), which is why it is its own
 * module. Pure reads and row writes: nothing here starts LLM work.
 */
import { existsSync } from 'node:fs';
import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { db, draws, nodes, pages, spaceItemBundles, spaceItems, spaces, tables } from '@mantle/db';
import { refLikeCells, resolveStoragePath } from '@mantle/tabledb';
import {
  MEMBER_ITEM_KINDS as SPACE_ITEM_KINDS,
  type MemberItemKind as SpaceItemKind,
} from '@mantle/client-types/member-kinds';
import { cellRefs, noteRefs, pageRefs, sceneRefs, type EmbedRefs } from './embed-refs';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Via = Pick<Tx, 'select'>;

export type BundleItem = { id: string; type: SpaceItemKind; title: string };

export type Bundle = {
  /** The item first, then what it brings along. */
  items: BundleItem[];
  /** References to items that stay in a personal space, so they will not
   *  open for anyone who reads the accepted item: links and mentions, and a
   *  left-behind item's private embeds. */
  linksStayingBehind: number;
};

/** A bundle bigger than this is refused: nobody reviews that much at once. */
export const BUNDLE_MAX_ITEMS = 200;

export const BUNDLE_TOO_LARGE = `This item brings more than ${BUNDLE_MAX_ITEMS} items with it.`;

/** The references one item carries, read from its SAVED version. Also the
 *  give-back embed check (member-takeover.ts). */
export async function refsOf(via: Via, item: BundleItem): Promise<EmbedRefs[]> {
  switch (item.type) {
    case 'page': {
      const [p] = await via
        .select({ doc: pages.doc })
        .from(pages)
        .where(eq(pages.nodeId, item.id))
        .limit(1);
      return p ? [pageRefs(p.doc)] : [];
    }
    case 'note': {
      const [n] = await via
        .select({ data: nodes.data })
        .from(nodes)
        .where(eq(nodes.id, item.id))
        .limit(1);
      const content = (n?.data as Record<string, unknown> | null)?.content;
      return typeof content === 'string' ? [noteRefs(content)] : [];
    }
    case 'draw': {
      const [d] = await via
        .select({ scene: draws.scene, fileRefs: draws.fileRefs })
        .from(draws)
        .where(eq(draws.nodeId, item.id))
        .limit(1);
      if (!d) return [];
      // A drawing's own images are its file refs: they render inside it.
      const files = Object.values((d.fileRefs ?? {}) as Record<string, string>).filter(
        (v) => typeof v === 'string',
      );
      return [sceneRefs(d.scene), { ids: files, refused: [], embeds: files }];
    }
    case 'table': {
      const [t] = await via
        .select({ storagePath: tables.storagePath })
        .from(tables)
        .where(eq(tables.nodeId, item.id))
        .limit(1);
      if (!t?.storagePath) return [];
      const file = resolveStoragePath(t.storagePath);
      return existsSync(file) ? [cellRefs(refLikeCells(file))] : [];
    }
    case 'file':
      return [];
  }
}

/** Items that may join a left-behind bundle: shared with the team, or
 *  submitted, and not accepted. Needs `nodes` in the query. */
const sharedOrSubmitted = sql`exists (select 1 from ${spaceItems} si
  where si.node_id = ${nodes.id} and si.review_state <> 'accepted'
    and (si.sharing = 'team' or si.review_state = 'submitted'))`;

export type WalkOptions = {
  /** Join only items that are themselves shared or submitted (a left-behind
   *  bundle). The private ones it would have joined are counted instead. */
  sharedOnly?: boolean;
  /** Stop at this many items (BUNDLE_MAX_ITEMS by default). */
  maxItems?: number;
  /** The error for a bundle past `maxItems`. */
  tooLarge?: () => Error;
};

export type BundleWalk = {
  items: BundleItem[];
  /** Ids referenced as links or mentions, not in the bundle. */
  links: string[];
  /** Own items left out by `sharedOnly`. */
  leftOut: number;
};

/**
 * The bundle as the saved versions say it is now, read on `via` (the accept
 * or submit transaction, so it sees what it locks). Throws `tooLarge()` past
 * `maxItems`.
 */
export async function walkBundle(
  via: Via,
  spaceId: string,
  root: BundleItem,
  opts: WalkOptions = {},
): Promise<BundleWalk> {
  const max = opts.maxItems ?? BUNDLE_MAX_ITEMS;
  const items: BundleItem[] = [root];
  const inBundle = new Set([root.id]);
  const links = new Set<string>();
  const leftOut = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const embeds = new Set<string>();
    for (const r of await refsOf(via, item)) {
      for (const id of r.embeds) embeds.add(id);
      for (const id of r.ids) if (!r.embeds.includes(id)) links.add(id);
    }
    if (item.type === 'page') {
      const kids = await via
        .select({ id: nodes.id })
        .from(nodes)
        .where(
          and(eq(nodes.parentId, item.id), eq(nodes.ownerId, spaceId), eq(nodes.type, 'page')),
        );
      for (const k of kids) embeds.add(k.id);
    }
    const fresh = [...embeds].filter((id) => !inBundle.has(id) && !leftOut.has(id));
    if (!fresh.length) continue;
    const own = and(
      inArray(nodes.id, fresh),
      eq(nodes.ownerId, spaceId),
      inArray(nodes.type, [...SPACE_ITEM_KINDS]),
    );
    const joined = await via
      .select({ id: nodes.id, type: nodes.type, title: nodes.title })
      .from(nodes)
      .where(opts.sharedOnly ? and(own, sharedOrSubmitted) : own);
    for (const j of joined) {
      inBundle.add(j.id);
      items.push({ id: j.id, type: j.type as SpaceItemKind, title: j.title });
    }
    if (opts.sharedOnly && joined.length < fresh.length) {
      const privateOnes = await via.select({ id: nodes.id }).from(nodes).where(own);
      for (const p of privateOnes) if (!inBundle.has(p.id)) leftOut.add(p.id);
    }
    if (items.length > max) {
      throw opts.tooLarge ? opts.tooLarge() : new Error(BUNDLE_TOO_LARGE);
    }
  }
  return {
    items,
    links: [...links].filter((id) => !inBundle.has(id)),
    leftOut: leftOut.size,
  };
}

/** How many of `ids` are items in a personal space. The admin pool only:
 *  the space role reads no `spaces` row. */
async function countPersonal(via: Via, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const [r] = await via
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
    .where(and(inArray(nodes.id, ids), eq(spaces.kind, 'personal')));
  return r?.n ?? 0;
}

/** The bundle as it is now, with the count of what stays behind (the admin
 *  pool: the review preview, a legacy or left-behind Accept). */
export async function computeBundle(
  via: Via,
  spaceId: string,
  root: BundleItem,
  opts: WalkOptions = {},
): Promise<Bundle> {
  const w = await walkBundle(via, spaceId, root, opts);
  return { items: w.items, linksStayingBehind: w.leftOut + (await countPersonal(via, w.links)) };
}

/**
 * The bundle recorded at Submit, items still in `spaceId` only (another
 * Accept may have moved a shared embed already), in bundle order. Null when
 * nothing was recorded: a root submitted before migration 0180.
 */
export async function recordedBundle(
  via: Via,
  spaceId: string,
  rootId: string,
): Promise<BundleItem[] | null> {
  const rows = await via
    .select({
      id: nodes.id,
      type: nodes.type,
      title: nodes.title,
      ownerId: nodes.ownerId,
    })
    .from(spaceItemBundles)
    .innerJoin(nodes, eq(nodes.id, spaceItemBundles.nodeId))
    .where(eq(spaceItemBundles.rootId, rootId))
    .orderBy(asc(spaceItemBundles.position));
  if (!rows.length) return null;
  const kinds = new Set<string>(SPACE_ITEM_KINDS);
  return rows
    .filter((r) => r.ownerId === spaceId && kinds.has(r.type))
    .map((r) => ({ id: r.id, type: r.type as SpaceItemKind, title: r.title }));
}

/** A recorded bundle with the count of what stays behind (the admin pool). */
export async function withLinksStayingBehind(via: Via, items: BundleItem[]): Promise<Bundle> {
  const inBundle = new Set(items.map((i) => i.id));
  const links = new Set<string>();
  for (const item of items) {
    for (const r of await refsOf(via, item)) {
      for (const id of r.ids) if (!r.embeds.includes(id) && !inBundle.has(id)) links.add(id);
    }
  }
  return { items, linksStayingBehind: await countPersonal(via, [...links]) };
}

/** Record `items` as the bundle of `rootId`, replacing any earlier record.
 *  Written before the root is submitted (the space role's rule). */
export async function recordBundle(
  via: Pick<Tx, 'delete' | 'insert'>,
  rootId: string,
  items: BundleItem[],
): Promise<void> {
  await via.delete(spaceItemBundles).where(eq(spaceItemBundles.rootId, rootId));
  if (!items.length) return;
  await via
    .insert(spaceItemBundles)
    .values(items.map((b, position) => ({ rootId, nodeId: b.id, position })));
}

/** Forget the recorded bundles of these roots (Recall, Return, Accept). */
export async function clearBundles(via: Pick<Tx, 'delete'>, rootIds: string[]): Promise<void> {
  if (!rootIds.length) return;
  await via.delete(spaceItemBundles).where(inArray(spaceItemBundles.rootId, rootIds));
}

/**
 * The submitted item whose recorded bundle holds `id` (other than `id`
 * itself), or null. What freezes an embedded drawing, file or child page
 * while the item it renders in is waiting for review.
 */
export async function bundleHolder(
  via: Via,
  id: string,
): Promise<{ id: string; title: string } | null> {
  const [h] = await via
    .select({ id: nodes.id, title: nodes.title })
    .from(spaceItemBundles)
    .innerJoin(spaceItems, eq(spaceItems.nodeId, spaceItemBundles.rootId))
    .innerJoin(nodes, eq(nodes.id, spaceItemBundles.rootId))
    .where(
      and(
        eq(spaceItemBundles.nodeId, id),
        ne(spaceItemBundles.rootId, id),
        eq(spaceItems.reviewState, 'submitted'),
      ),
    )
    .limit(1);
  return h ?? null;
}

/**
 * Lock the rows a bundle's content lives in (the node, and its page, drawing
 * or table row) FOR UPDATE, so an autosave or a Save version cannot land
 * between the unsaved-edits check and the change that follows it. Every draft
 * write takes the same body row lock (pages/draft.ts, draws.ts, the tables
 * registry lock). Under the space role a row frozen by another submitted
 * bundle is not returned, and needs no lock: nothing can write it.
 */
export async function lockBundleRows(via: Via, items: BundleItem[]): Promise<void> {
  if (!items.length) return;
  const ids = items.map((i) => i.id);
  const byType = (t: SpaceItemKind) => items.filter((i) => i.type === t).map((i) => i.id);
  await via.select({ id: nodes.id }).from(nodes).where(inArray(nodes.id, ids)).for('update');
  const p = byType('page');
  if (p.length) {
    await via
      .select({ id: pages.nodeId })
      .from(pages)
      .where(inArray(pages.nodeId, p))
      .for('update');
  }
  const d = byType('draw');
  if (d.length) {
    await via
      .select({ id: draws.nodeId })
      .from(draws)
      .where(inArray(draws.nodeId, d))
      .for('update');
  }
  const t = byType('table');
  if (t.length) {
    await via
      .select({ id: tables.nodeId })
      .from(tables)
      .where(inArray(tables.nodeId, t))
      .for('update');
  }
}

/** A root that is submitted or shared with the team (and not accepted), for
 *  the purge's keep list. */
export const sharedOrSubmittedRoot = or(
  eq(spaceItems.reviewState, 'submitted'),
  and(eq(spaceItems.sharing, 'team'), ne(spaceItems.reviewState, 'accepted')),
)!;
