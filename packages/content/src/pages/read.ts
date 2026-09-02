/**
 * Pages · read paths. Every query that returns a page without changing one:
 * the list/count/tag surface, the single-page read, the tree's one-level
 * child read and descendant count, and inbound backlinks.
 *
 * The one write it performs is `persistBlockIdBackfill` — maintenance, not an
 * edit: no version bump, no re-index, fire-and-forget.
 */
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db, entityEdges, nodes, pages } from '@mantle/db';
import { ensureBlockIds, repairTableRows } from '@mantle/content-core/block-ids';
import type { Backlink, PageRow, PageSort } from '@mantle/client-types';
import { EMPTY_DOC, detailOf, rowOf, type PageDetail } from './shared';

type ListPagesOpts = { query?: string; tag?: string; sort?: PageSort };

/** Map a sort key to its ORDER BY clause. */
function pageOrderBy(sort?: PageSort) {
  switch (sort) {
    case 'newest':
      return desc(nodes.createdAt);
    case 'oldest':
      return asc(nodes.createdAt);
    case 'title':
      return asc(nodes.title);
    case 'edited':
    default:
      return desc(nodes.updatedAt);
  }
}

/** Shared WHERE conditions for page list/count queries. Joins the `pages`
 *  sidecar so the text query can match the document body (`doc_text`). */
function pageConds(ownerId: string, opts: ListPagesOpts) {
  const conds = [eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')];
  if (opts.query?.trim()) {
    const q = `%${opts.query.trim()}%`;
    const c = or(
      ilike(nodes.title, q),
      sql`${pages.docText} ilike ${q}`,
      sql`${nodes.data}->>'summary' ilike ${q}`,
    );
    if (c) conds.push(c);
  }
  if (opts.tag) conds.push(sql`${opts.tag} = ANY(${nodes.tags})`);
  return conds;
}

export async function listPages(
  ownerId: string,
  opts: ListPagesOpts & { limit?: number; offset?: number } = {},
): Promise<PageRow[]> {
  const rows = await db
    .select()
    .from(nodes)
    .leftJoin(pages, eq(pages.nodeId, nodes.id))
    .where(and(...pageConds(ownerId, opts)))
    .orderBy(pageOrderBy(opts.sort))
    .limit(opts.limit ?? 500)
    .offset(opts.offset ?? 0);
  return rows.map((r) => rowOf(r.nodes));
}

/** Total pages matching the same filters as `listPages` (drives pagination). */
export async function countPages(ownerId: string, opts: ListPagesOpts = {}): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .leftJoin(pages, eq(pages.nodeId, nodes.id))
    .where(and(...pageConds(ownerId, opts)));
  return row?.n ?? 0;
}

/** All distinct tags across the user's pages with usage counts, ordered by
 *  frequency then name. Drives the pages tag filter. */
export async function listPageTags(ownerId: string): Promise<{ tag: string; count: number }[]> {
  const rows = await db
    .select({ tags: nodes.tags })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')));
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export async function getPage(ownerId: string, id: string): Promise<PageDetail | null> {
  const [row] = await db
    .select({
      node: nodes,
      doc: pages.doc,
      draft: pages.draftDoc,
      draftUpdatedAt: pages.draftUpdatedAt,
      draftRev: pages.draftRev,
    })
    .from(nodes)
    .leftJoin(pages, eq(pages.nodeId, nodes.id))
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
    .limit(1);
  if (!row) return null;

  // Lazy block-id backfill — legacy docs that predate Phase 2b come back
  // through this read path enriched with stable per-block ids. ensureBlockIds
  // returns the SAME reference when ids are already present, so we use
  // reference inequality to detect "we just injected something" and persist
  // that enrichment fire-and-forget. Without the persist step, ids would
  // regenerate on every read (block-edit tools couldn't trust them between
  // calls); with it, every page becomes id-stable on first access and stays
  // that way until the user edits.
  const rawDoc = (row.doc as Record<string, unknown> | null) ?? EMPTY_DOC;
  const rawDraft = (row.draft as Record<string, unknown> | null) ?? null;
  // repairTableRows BEFORE ensureBlockIds: a malformed draft (a tableRow with a
  // bare paragraph child, from a bad agent block edit) makes the editor throw
  // `RangeError: Invalid content for node tableRow` on load. Repairing here
  // self-heals existing bad docs on read — the change is then persisted back by
  // the lazy backfill below, so no migration is needed.
  const doc = ensureBlockIds(repairTableRows(rawDoc));
  const draft = rawDraft ? ensureBlockIds(repairTableRows(rawDraft)) : null;

  const docChanged = doc !== rawDoc && row.doc !== null; // only persist if there's a row to update
  const draftChanged = draft !== rawDraft && rawDraft !== null;
  if (docChanged || draftChanged) {
    void persistBlockIdBackfill(id, docChanged ? doc : null, draftChanged ? draft : null);
  }

  return {
    ...detailOf(row.node, doc, draft, { draftRev: row.draftRev ?? 0 }),
    draftUpdatedAt: draft ? (row.draftUpdatedAt?.toISOString() ?? null) : null,
  };
}

/**
 * Write enriched `doc` and/or `draft_doc` back to the pages row when the
 * lazy backfill in getPage added ids. Fire-and-forget — never blocks the
 * read path, never re-extracts (deliberately no notifyNodeIngested + no
 * version bump + no updatedAt touch — this is maintenance, not an edit).
 *
 * Race window with the editor's autosave: tiny. If the user is actively
 * editing and their autosave lands between our read and our write, their
 * write wins (the draft contains the latest content; ids will be re-
 * injected on the NEXT read). No harm done.
 */
async function persistBlockIdBackfill(
  id: string,
  doc: Record<string, unknown> | null,
  draft: Record<string, unknown> | null,
): Promise<void> {
  try {
    const patch: Record<string, unknown> = {};
    if (doc) patch.doc = doc;
    if (draft) patch.draftDoc = draft;
    if (Object.keys(patch).length === 0) return;
    await db.update(pages).set(patch).where(eq(pages.nodeId, id));
  } catch (err) {
    console.error('[pages] block-id backfill persist failed (non-fatal):', err);
  }
}

/** Immediate children of a page — the tree's expand-one-level read, ordered by
 *  title for a stable sidebar. Drives the /pages collapsible tree and lets the
 *  `childPage` card refresh a child's current title/icon. */
export async function listChildPages(ownerId: string, parentId: string): Promise<PageRow[]> {
  const rows = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'page'), eq(nodes.parentId, parentId)))
    .orderBy(asc(nodes.title));
  return rows.map((r) => rowOf(r));
}

/** Count ALL descendant pages (children, grandchildren, …) under a page via the
 *  parent_id tree. Used to warn before delete: parent_id is ON DELETE CASCADE,
 *  so deleting a parent silently takes its whole subtree. `UNION` (not UNION
 *  ALL) makes it cycle-safe even if the tree ever contained a loop. */
export async function countPageDescendants(ownerId: string, id: string): Promise<number> {
  const result = await db.execute<{ count: number }>(sql`
    WITH RECURSIVE descendants AS (
      SELECT id FROM ${nodes}
       WHERE parent_id = ${id} AND owner_id = ${ownerId} AND type = 'page'
      UNION
      SELECT n.id FROM ${nodes} n
        JOIN descendants d ON n.parent_id = d.id
       WHERE n.owner_id = ${ownerId} AND n.type = 'page'
    )
    SELECT count(*)::int AS count FROM descendants
  `);
  const rows = (
    Array.isArray(result) ? result : ((result as { rows?: Array<{ count: number }> }).rows ?? [])
  ) as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}

/**
 * Nodes that reference this page — the inbound `node --references--> node` edges
 * the extractor builds from @-mention chips with `ref:'node'` (see docs/pages.md
 * §5). Joined to `nodes` so dangling edges (source deleted) drop out, deduped by
 * source, newest-updated first. Read-only; the extractor is the sole edge writer.
 */
export async function listBacklinks(ownerId: string, pageId: string): Promise<Backlink[]> {
  const rows = await db
    .select({
      id: nodes.id,
      title: nodes.title,
      type: nodes.type,
      data: nodes.data,
      updatedAt: nodes.updatedAt,
    })
    .from(entityEdges)
    .innerJoin(nodes, eq(nodes.id, entityEdges.sourceId))
    .where(
      and(
        eq(entityEdges.ownerId, ownerId),
        eq(entityEdges.relation, 'references'),
        eq(entityEdges.sourceKind, 'node'),
        eq(entityEdges.targetKind, 'node'),
        eq(entityEdges.targetId, pageId),
      ),
    )
    .orderBy(desc(nodes.updatedAt));

  const seen = new Set<string>();
  const out: Backlink[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue; // dedupe (idempotent extractor shouldn't dupe, but be safe)
    seen.add(r.id);
    const icon = typeof r.data?.icon === 'string' ? (r.data.icon as string) : null;
    out.push({ id: r.id, title: r.title, type: r.type, icon });
  }
  return out;
}
