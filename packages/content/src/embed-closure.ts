/**
 * Embedding means sharing (audit F19 follow-up, Jason 2026-09-28). Lowering
 * an item is an admin's decision for the item AND what it embeds: when a
 * page, drawing or note goes below admin, everything it embeds goes down with
 * it, to the same level, in the same transaction. So the level label always
 * tells the truth (a public page's images are public) and share links keep
 * working. See docs/access-levels.md section 1.
 *
 * The EMBED CLOSURE of an item, followed transitively:
 *  - a page: its images and file embeds, its embedded drawings, its child
 *    page cards (`referencedEmbedIds`);
 *  - a drawing: its images (`draws.file_refs`);
 *  - a note: the images, file embeds and drawings in its markdown.
 * Links are not embeds (a link mark, a mention chip, a drawing element's
 * link). A folder is not an embedding kind: its contents keep their own
 * levels (folder links show only their level, audit F19).
 *
 * The rules, here and in every caller:
 *  - never raise anything, and never touch an embed already at or below the
 *    level;
 *  - only workspace kinds go down (the type ceiling): an embed that can never
 *    go below admin stays admin and is reported;
 *  - the owner's items only, so a personal space's items are never in a brain
 *    item's closure;
 *  - a level change starts no work: nothing here notifies the extractor.
 *
 * Every read and write runs through the caller's `q` (the pool or its
 * transaction): the walk that decides what to lower sees the rows the caller
 * is changing.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  db,
  draws,
  isViewerLevel,
  nodes,
  pages,
  profiles,
  WORKSPACE_NODE_TYPES,
  type ViewerLevel,
} from '@mantle/db';
import { markdownToDoc } from '@mantle/content-core/markdown';
import { referencedDrawIds, referencedEmbedIds, referencedFileIds } from './doc-assets';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** The pool, or a caller's transaction. */
export type ClosureDb = typeof db | Tx;

/** The kinds whose embeds follow them. */
export const EMBEDDING_KINDS: readonly string[] = ['page', 'draw', 'note'];

/** One item in an embed closure, at its current level. */
export type EmbedItem = { id: string; type: string; title: string; audience: ViewerLevel };

/** One item a level change lowered with the item that embeds it. */
export type LoweredItem = {
  id: string;
  type: string;
  title: string;
  from: ViewerLevel;
  to: ViewerLevel;
};

export type LowerEmbedsResult = {
  /** Embeds taken down to the item's level. */
  lowered: LoweredItem[];
  /** Embeds that can never go below admin (the type ceiling): left at admin,
   *  so people at the item's level do not see them. */
  ceiling: EmbedItem[];
};

const RANK: Record<ViewerLevel, number> = { public: 0, client: 1, team: 2, admin: 3 };
/** The levels strictly above `level`. */
const levelsAbove = (level: ViewerLevel): ViewerLevel[] =>
  (Object.keys(RANK) as ViewerLevel[]).filter((l) => RANK[l] > RANK[level]);
/** A walk never runs away on a pathological brain. */
const MAX_ITEMS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKSPACE = new Set<string>(WORKSPACE_NODE_TYPES);

function asLevel(v: string): ViewerLevel {
  return isViewerLevel(v) ? v : 'admin';
}

/** Is level `a` strictly above `b`? */
export function levelAbove(a: ViewerLevel, b: ViewerLevel): boolean {
  return RANK[a] > RANK[b];
}

/** What a note's markdown embeds: images, file embeds and drawings. (A
 *  `page:` link in a note is a link, not a child page.) */
export function noteEmbedIds(markdown: string): string[] {
  if (!markdown) return [];
  const doc = markdownToDoc(markdown);
  return [...new Set([...referencedFileIds(doc), ...referencedDrawIds(doc)])];
}

/** What a drawing embeds: the file of every image in its file map. */
export function drawEmbedIds(fileRefs: unknown): string[] {
  if (!fileRefs || typeof fileRefs !== 'object') return [];
  return [
    ...new Set(Object.values(fileRefs).filter((v): v is string => typeof v === 'string' && !!v)),
  ];
}

/** The file ids of the images a scene PLACES (live image elements), through
 *  its file map: the images a drawing's snapshot carries. */
export function drawPlacedFileIds(scene: unknown, fileRefs: unknown): string[] {
  const refs = (fileRefs && typeof fileRefs === 'object' ? fileRefs : {}) as Record<
    string,
    unknown
  >;
  const elements = (scene as { elements?: unknown } | null)?.elements;
  if (!Array.isArray(elements)) return [];
  const out = new Set<string>();
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const e = el as { type?: unknown; fileId?: unknown; isDeleted?: unknown };
    if (e.type !== 'image' || e.isDeleted === true || typeof e.fileId !== 'string') continue;
    const id = refs[e.fileId];
    if (typeof id === 'string' && id) out.add(id);
  }
  return [...out];
}

/** The ids `items` embed directly, read through `q`. */
async function directEmbeds(
  q: ClosureDb,
  ownerId: string,
  items: readonly { id: string; type: string }[],
): Promise<string[]> {
  const of = (type: string) => items.filter((i) => i.type === type).map((i) => i.id);
  const pageIds = of('page');
  const drawIds = of('draw');
  const noteIds = of('note');
  const out: string[] = [];
  if (pageIds.length > 0) {
    const rows = await q
      .select({ doc: pages.doc })
      .from(pages)
      .where(inArray(pages.nodeId, pageIds));
    for (const r of rows) out.push(...referencedEmbedIds(r.doc));
  }
  if (drawIds.length > 0) {
    const rows = await q
      .select({ fileRefs: draws.fileRefs })
      .from(draws)
      .where(inArray(draws.nodeId, drawIds));
    for (const r of rows) out.push(...drawEmbedIds(r.fileRefs));
  }
  if (noteIds.length > 0) {
    const rows = await q
      .select({ data: nodes.data })
      .from(nodes)
      .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, noteIds)));
    for (const r of rows) {
      const content = (r.data as Record<string, unknown> | null)?.content;
      out.push(...noteEmbedIds(typeof content === 'string' ? content : ''));
    }
  }
  return out;
}

/** The owner's rows for `ids`. Anything that is not a uuid is dropped: a
 *  stray attribute must never reach a uuid comparison (22P02). */
async function loadItems(
  q: ClosureDb,
  ownerId: string,
  ids: readonly string[],
): Promise<EmbedItem[]> {
  const valid = [...new Set(ids.map((id) => id.toLowerCase()))].filter((id) => UUID.test(id));
  if (valid.length === 0) return [];
  const rows = await q
    .select({ id: nodes.id, type: nodes.type, title: nodes.title, audience: nodes.audience })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, valid)));
  return rows.map((r) => ({ ...r, audience: asLevel(r.audience) }));
}

/** Walk out from `start` (already in `seen`), adding what each item embeds,
 *  transitively, to `out`. */
async function expand(
  q: ClosureDb,
  ownerId: string,
  start: readonly EmbedItem[],
  seen: Set<string>,
  out: EmbedItem[],
): Promise<void> {
  let frontier = start.filter((i) => EMBEDDING_KINDS.includes(i.type));
  while (frontier.length > 0 && out.length < MAX_ITEMS) {
    const next = [
      ...new Set((await directEmbeds(q, ownerId, frontier)).map((id) => id.toLowerCase())),
    ].filter((id) => !seen.has(id));
    for (const id of next) seen.add(id);
    const rows = await loadItems(q, ownerId, next);
    out.push(...rows);
    frontier = rows.filter((i) => EMBEDDING_KINDS.includes(i.type));
  }
}

/**
 * An item's embed closure: what it embeds, what those embed, and so on,
 * each at its own level. The item itself is not in it. Empty for a kind that
 * embeds nothing (a file, a folder, a table).
 */
export async function embedClosure(
  ownerId: string,
  nodeId: string,
  q: ClosureDb = db,
): Promise<EmbedItem[]> {
  const [root] = await loadItems(q, ownerId, [nodeId]);
  if (!root || !EMBEDDING_KINDS.includes(root.type)) return [];
  const out: EmbedItem[] = [];
  await expand(q, ownerId, [root], new Set([root.id.toLowerCase()]), out);
  return out;
}

/** The items `ids` name (the owner's only) plus their own embed closures:
 *  what a save that ADDED those embeds brings along. `exclude`: ids never
 *  to include (the saving item itself). */
export async function embedClosureOf(
  ownerId: string,
  ids: readonly string[],
  q: ClosureDb = db,
  exclude: readonly string[] = [],
): Promise<EmbedItem[]> {
  const seen = new Set(exclude.map((id) => id.toLowerCase()));
  const start = (await loadItems(q, ownerId, ids)).filter((i) => !seen.has(i.id.toLowerCase()));
  for (const i of start) seen.add(i.id.toLowerCase());
  const out = [...start];
  await expand(q, ownerId, start, seen, out);
  return out;
}

/**
 * The brain's items that `items` (rows of another owner: a personal space's
 * bundle before Accept moves it in) embed, plus their own embed closures in
 * the brain, each at its current level: what an Accept at a level below
 * admin takes down with the bundle (member-review.ts). `exclude`: ids never
 * to include (the bundle itself).
 */
export async function brainEmbedsOf(
  brainId: string,
  fromOwnerId: string,
  items: readonly { id: string; type: string }[],
  q: ClosureDb = db,
  exclude: readonly string[] = [],
): Promise<EmbedItem[]> {
  const direct = await directEmbeds(q, fromOwnerId, items);
  if (direct.length === 0) return [];
  return embedClosureOf(brainId, direct, q, exclude);
}

/**
 * Take `items` down to `level`: every workspace-kind item above it goes to
 * it; one already at or below it is left alone, and nothing is ever raised.
 * A kind that can never go below admin stays admin and comes back in
 * `ceiling`. At admin there is nothing to do.
 */
export async function lowerEmbeds(
  ownerId: string,
  items: readonly EmbedItem[],
  level: ViewerLevel,
  q: ClosureDb = db,
): Promise<LowerEmbedsResult> {
  if (level === 'admin') return { lowered: [], ceiling: [] };
  const ceiling = items.filter((i) => !WORKSPACE.has(i.type));
  const wanted = items.filter((i) => WORKSPACE.has(i.type) && levelAbove(i.audience, level));
  if (wanted.length === 0) return { lowered: [], ceiling };
  // Guarded by the level in the WHERE too: a row another writer took to or
  // below `level` since the walk read it is left where it is.
  const done = await q
    .update(nodes)
    .set({ audience: level })
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        inArray(
          nodes.id,
          wanted.map((i) => i.id),
        ),
        inArray(nodes.audience, levelsAbove(level)),
      ),
    )
    .returning({ id: nodes.id });
  const changed = new Set(done.map((r) => r.id));
  return {
    lowered: wanted
      .filter((i) => changed.has(i.id))
      .map((i) => ({ id: i.id, type: i.type, title: i.title, from: i.audience, to: level })),
    ceiling,
  };
}

/** Lower an item's whole embed closure to `level` (the item's new level). */
export async function lowerEmbedClosure(
  ownerId: string,
  nodeId: string,
  level: ViewerLevel,
  q: ClosureDb = db,
): Promise<LowerEmbedsResult> {
  if (level === 'admin') return { lowered: [], ceiling: [] };
  return lowerEmbeds(ownerId, await embedClosure(ownerId, nodeId, q), level, q);
}

/**
 * Later embeds follow on save: an item below admin that GAINED embeds in a
 * save (a page or draft commit, a drawing commit, a note's text) takes the
 * new ones, and what they embed, to its own level. Only what was added: an
 * embed the item already had keeps its level, so an admin who raised one on
 * purpose is not overruled by the next edit. `before` / `after` are the
 * item's direct embeds either side of the save.
 */
export async function followNewEmbeds(
  ownerId: string,
  item: { id: string; audience: string },
  before: readonly string[],
  after: readonly string[],
  q: ClosureDb = db,
): Promise<LoweredItem[]> {
  const level = asLevel(item.audience);
  if (level === 'admin') return [];
  const had = new Set(before.map((id) => id.toLowerCase()));
  const added = [...new Set(after.map((id) => id.toLowerCase()))].filter((id) => !had.has(id));
  if (added.length === 0) return [];
  const items = await embedClosureOf(ownerId, added, q, [item.id]);
  return (await lowerEmbeds(ownerId, items, level, q)).lowered;
}

/** One item below admin whose embed closure holds items above it. */
export type EmbedClosureGap = {
  id: string;
  type: string;
  title: string;
  audience: ViewerLevel;
  /** The closure's workspace items above the item's level. */
  above: EmbedItem[];
};

/**
 * Every item below admin whose embed closure holds a workspace item above
 * it: what the boot reconcile closes, and the shadow report's `closureGaps`.
 * Kinds that can never go below admin are left out: nothing can close them.
 */
export async function findEmbedClosureGaps(
  ownerId: string,
  q: ClosureDb = db,
): Promise<EmbedClosureGap[]> {
  const roots = await q
    .select({ id: nodes.id, type: nodes.type, title: nodes.title, audience: nodes.audience })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        sql`${nodes.type}::text in ('page', 'draw', 'note')`,
        sql`${nodes.audience} <> 'admin'`,
      ),
    );
  const gaps: EmbedClosureGap[] = [];
  for (const r of roots) {
    const level = asLevel(r.audience);
    const above = (await embedClosure(ownerId, r.id, q)).filter(
      (c) => WORKSPACE.has(c.type) && levelAbove(c.audience, level),
    );
    if (above.length > 0) gaps.push({ ...r, audience: level, above });
  }
  return gaps;
}

/**
 * Close the gaps: every item below admin takes its embed closure down to its
 * level. The same decision an admin makes by lowering an item today, applied
 * to the items lowered before this release. One transaction; each item is
 * read afresh (an earlier step may have lowered it), so one pass is enough
 * and a second finds nothing. Logs each change.
 */
export async function reconcileEmbedClosures(
  ownerId: string,
  log: (line: string) => void = () => {},
): Promise<LoweredItem[]> {
  return db.transaction(async (tx) => {
    const gaps = await findEmbedClosureGaps(ownerId, tx);
    const all: LoweredItem[] = [];
    for (const g of gaps) {
      const [now] = await loadItems(tx, ownerId, [g.id]);
      if (!now || now.audience === 'admin') continue;
      const { lowered } = await lowerEmbedClosure(ownerId, g.id, now.audience, tx);
      for (const l of lowered) {
        log(
          `[embeds] ${l.type} ${l.id} "${l.title}" ${l.from} -> ${l.to} (embedded by ${now.type} ${now.id})`,
        );
      }
      all.push(...lowered);
    }
    return all;
  });
}

/** The version of the reconcile below; bump it to run it again on every
 *  brain (a later release that finds a new kind of gap). */
export const EMBED_RECONCILE_VERSION = 1;
const MARKER = 'embedClosureReconciled';

/**
 * The boot reconcile, once per brain: close the gaps (reconcileEmbedClosures)
 * and record that it ran, in the owner's preferences. Once, not every boot:
 * after it an admin may RAISE one embed on purpose (the link then stops
 * serving it), and a reconcile on the next boot must not lower it again.
 * Safe to call on every boot: with the marker set it reads one row and
 * returns null; run again without it, it finds nothing left and changes
 * nothing.
 */
export async function reconcileEmbedClosuresOnce(
  ownerId: string,
  log: (line: string) => void = () => {},
): Promise<LoweredItem[] | null> {
  const [row] = await db
    .select({ v: sql<string | null>`${profiles.preferences}->>${MARKER}` })
    .from(profiles)
    .where(eq(profiles.userId, ownerId))
    .limit(1);
  if (Number(row?.v ?? 0) >= EMBED_RECONCILE_VERSION) return null;
  const lowered = await reconcileEmbedClosures(ownerId, log);
  const mark = { [MARKER]: EMBED_RECONCILE_VERSION };
  await db
    .insert(profiles)
    .values({ userId: ownerId, preferences: mark })
    .onConflictDoUpdate({
      target: profiles.userId,
      set: {
        preferences: sql`${profiles.preferences} || ${JSON.stringify(mark)}::jsonb`,
        updatedAt: new Date(),
      },
    });
  return lowered;
}
