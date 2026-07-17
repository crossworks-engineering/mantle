/**
 * Pages surface. A page is a `nodes` row with type='page' plus a `pages`
 * sidecar row holding the TipTap / ProseMirror document:
 *
 *   nodes.title           display name
 *   nodes.data.icon       optional emoji / icon
 *   nodes.data.summary    extractor-written summary
 *   nodes.data.visibility 'private' | 'public' (read-only sharing, phase 5)
 *   pages.doc             ProseMirror JSON (source of truth)
 *   pages.doc_text        derived plaintext (the extractor + FTS read this)
 *
 * All under the `pages` ltree root, lazy-created on first write. `page` is in
 * the extractor's DEFAULT_EXTRACT_TYPES, so summary + embedding land
 * automatically on the next pg_notify('node_ingested'); `readNodeBodyRaw`
 * reads `doc_text` from the sidecar.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db, nodes, pages, entities, entityEdges, notifyNodeIngested, type Node } from '@mantle/db';
import { docToText } from './doc-to-text';
import { referencedFileIds } from './doc-assets';
import { ensureBlockIds, repairTableRows } from './block-ids';
import { childPagePath } from './page-path';
import { insertAfterBlock, type PMBlockNode } from './block-edit';
import { buildMentionParagraph, type MentionRef } from './mention-refs';
import { splitDocByHeading, extractSection, type SplitLevel } from './page-split';

export const PAGES_ROOT_LABEL = 'pages';

/** An empty ProseMirror document — a single empty paragraph. */
export const EMPTY_DOC: Record<string, unknown> = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

export type PageVisibility = 'private' | 'public';
/** Notion-style content width: centered/narrow vs full available space. */
export type PageWidth = 'narrow' | 'wide';

export type PageRow = {
  id: string;
  /** Parent page id, or null for a top-level page. Drives the /pages tree
   *  and the `childPage` card (Phase 4a sub-pages). */
  parentId: string | null;
  title: string;
  icon: string | null;
  tags: string[];
  summary: string | null;
  visibility: PageVisibility;
  width: PageWidth;
  createdAt: string;
  updatedAt: string;
};

export type PageDetail = PageRow & {
  /** Published document — what's rendered everywhere and what the extractor
   *  indexes. Only changes on commit. */
  doc: Record<string, unknown>;
  /** Autosaved working copy if uncommitted edits exist, else null. Never
   *  rendered to other surfaces; loaded by the editor to resume work. */
  draft: Record<string, unknown> | null;
  /** When the draft was last written (ISO), or null when no draft exists.
   *  Optional: only the `getPage` read path populates it — write paths that
   *  synthesize a PageDetail from the row they just wrote skip it. */
  draftUpdatedAt?: string | null;
  /** Draft etag the editor round-trips on every autosave/commit so a stale
   *  writer can't clobber newer edits (optimistic concurrency). The read path
   *  and `commitPage` populate it; other write paths (create/update) leave it
   *  undefined and the client defaults to 0. */
  draftRev?: number;
};

function rowOf(n: Node): PageRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  return {
    id: n.id,
    parentId: n.parentId ?? null,
    title: n.title,
    // Treat a blank icon as "none" so a cleared icon (stored as '') falls back
    // to the default glyph everywhere instead of rendering as empty.
    icon: typeof d.icon === 'string' && d.icon.trim() ? d.icon : null,
    tags: n.tags ?? [],
    summary: typeof d.summary === 'string' ? d.summary : null,
    visibility: d.visibility === 'public' ? 'public' : 'private',
    width: d.width === 'wide' ? 'wide' : 'narrow',
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

function detailOf(
  n: Node,
  doc: Record<string, unknown>,
  draft: Record<string, unknown> | null = null,
  extra: { draftRev?: number } = {},
): PageDetail {
  return {
    ...rowOf(n),
    doc,
    draft,
    ...(extra.draftRev !== undefined ? { draftRev: extra.draftRev } : {}),
  };
}

// ── Draft concurrency control (audit item #3) ────────────────────────────────
// Page drafts mirror the Tables registry-lock spine (see table-storage.ts):
// every draft write, commit, and discard bumps `pages.draft_rev` and serializes
// on the pages row via SELECT … FOR UPDATE, so two autosave streams (a second
// device, or a user editing while the Pages agent applies block ops) can't
// interleave into a silent last-write-wins lost update.

type PageTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The pages-row fields the draft lock exposes to its critical section — null
 *  when no pages sidecar exists for the id (page deleted / never created). */
export type LockedPageRow = {
  draftRev: number;
  draftDoc: Record<string, unknown> | null;
} | null;

/**
 * Run `fn` while holding SELECT … FOR UPDATE on the page's sidecar row.
 * Serializes cross-process draft writers (desktop autosave vs phone vs the
 * Pages agent's block ops); the lock releases when the transaction commits or
 * rolls back. The locked row's `draftRev`/`draftDoc` are passed to `fn` (null
 * when the row is gone). Mirrors `withTableRegistryLock`.
 */
export async function withPageLock<T>(
  nodeId: string,
  fn: (tx: PageTx, locked: LockedPageRow) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const result = await tx.execute<{
      draft_rev: number;
      draft_doc: Record<string, unknown> | null;
    }>(sql`SELECT draft_rev, draft_doc FROM pages WHERE node_id = ${nodeId} FOR UPDATE`);
    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as { draft_rev: number; draft_doc: Record<string, unknown> | null }[];
    const locked: LockedPageRow = rows[0]
      ? { draftRev: Number(rows[0].draft_rev), draftDoc: rows[0].draft_doc }
      : null;
    return fn(tx, locked);
  });
}

/**
 * The etag decision, extracted pure so it's unit-testable without a DB: given
 * the row's current rev and the caller's optional `baseRev`, either report a
 * conflict (stale base) or clear the write and hand back the next rev. Callers
 * apply this INSIDE the lock, before writing — so a conflict never mutates the
 * draft. `baseRev` absent (internal callers) always proceeds, serialized by the
 * lock and rev-bumped so writes are never silently interleaved.
 */
export function evaluateDraftRev(
  currentRev: number,
  baseRev: number | undefined,
): { conflict: false; nextRev: number } | { conflict: true; rev: number } {
  if (baseRev !== undefined && baseRev !== currentRev) {
    return { conflict: true, rev: currentRev };
  }
  return { conflict: false, nextRev: currentRev + 1 };
}

async function ensureRoot(ownerId: string): Promise<void> {
  await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'branch',
      title: 'Pages',
      slug: PAGES_ROOT_LABEL,
      path: PAGES_ROOT_LABEL,
      data: { description: 'Rich documents (TipTap). Indexed and embedded automatically.' },
    })
    .onConflictDoNothing({
      target: [nodes.ownerId, nodes.path],
      where: sql`${nodes.type} = 'branch'`,
    });
}

/** Sort order for the pages list. 'edited' (last updated) is the default. */
export type PageSort = 'edited' | 'newest' | 'oldest' | 'title';

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

export type CreatePageInput = {
  title: string;
  doc?: Record<string, unknown>;
  tags?: string[];
  icon?: string;
  /** Optional parent page id (Phase 4a sub-pages). When set, the new page
   *  nests under it: `nodes.parent_id` points at the parent and the ltree
   *  `path` extends the parent's, so the child stays a descendant of the
   *  `pages` root. The tree itself is built from `parent_id`; the path is the
   *  materialised mirror. The parent must be a page owned by the same user. */
  parentId?: string | null;
};

/** Thrown by `createPage` when `parentId` doesn't resolve to one of the
 *  owner's pages. The API layer maps this to a 400. */
export class ParentPageNotFoundError extends Error {
  constructor() {
    super('createPage: parent page not found');
    this.name = 'ParentPageNotFoundError';
  }
}

export async function createPage(ownerId: string, input: CreatePageInput): Promise<PageDetail> {
  await ensureRoot(ownerId);
  const doc = input.doc ?? EMPTY_DOC;
  const docText = docToText(doc);

  // Resolve the parent (if any) up front. It must be a page owned by the same
  // user; we extend its ltree path so the child stays under the `pages` root.
  let parentId: string | null = null;
  let basePath = PAGES_ROOT_LABEL;
  if (input.parentId) {
    const [parent] = await db
      .select({ id: nodes.id, path: nodes.path })
      .from(nodes)
      .where(and(eq(nodes.id, input.parentId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
      .limit(1);
    if (!parent) throw new ParentPageNotFoundError();
    parentId = parent.id;
    basePath = parent.path;
  }

  // Generate the id up front so the path can embed it (the path is built before
  // the insert; the explicit id overrides the column's gen_random_uuid()).
  const id = randomUUID();
  const path = parentId ? childPagePath(basePath, id) : PAGES_ROOT_LABEL;

  return db.transaction(async (tx) => {
    const [node] = await tx
      .insert(nodes)
      .values({
        id,
        ownerId,
        parentId,
        type: 'page',
        title: input.title.trim().slice(0, 200) || 'Untitled page',
        path,
        data: {
          visibility: 'private',
          ...(input.icon ? { icon: input.icon } : {}),
        },
        tags: dedupeTags(input.tags ?? []),
      })
      .returning();
    if (!node) throw new Error('createPage: insert returned no row');
    await tx.insert(pages).values({ nodeId: node.id, doc, docText });
    return detailOf(node, doc);
  });
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

/** Thrown by `movePage` when the requested new parent is the page itself or one
 *  of its own descendants — re-parenting there would detach the subtree into a
 *  cycle. The tool layer maps this to a friendly message. */
export class PageCycleError extends Error {
  constructor() {
    super('movePage: cannot move a page under itself or one of its own descendants');
    this.name = 'PageCycleError';
  }
}

/** True when `maybeDescendantId` is a page beneath `ancestorId` in the
 *  parent_id tree (excludes the ancestor itself). Cycle-safe via UNION. */
async function isDescendantPage(
  ownerId: string,
  ancestorId: string,
  maybeDescendantId: string,
): Promise<boolean> {
  const result = await db.execute<{ hit: boolean }>(sql`
    WITH RECURSIVE descendants AS (
      SELECT id FROM ${nodes}
       WHERE parent_id = ${ancestorId} AND owner_id = ${ownerId} AND type = 'page'
      UNION
      SELECT n.id FROM ${nodes} n
        JOIN descendants d ON n.parent_id = d.id
       WHERE n.owner_id = ${ownerId} AND n.type = 'page'
    )
    SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ${maybeDescendantId}) AS hit
  `);
  const rows = (
    Array.isArray(result) ? result : ((result as { rows?: Array<{ hit: boolean }> }).rows ?? [])
  ) as Array<{ hit: boolean }>;
  return rows[0]?.hit === true;
}

/**
 * Re-parent a page (Phase 4d). Moves `id` to nest UNDER `newParentId` — making
 * it a sub-page — or back to the top level when `newParentId` is null. The
 * page's whole subtree moves with it: every descendant's ltree `path` is
 * recomputed from the page's new path in one recursive pass, mirroring the
 * `parentPath.childLabel` rule `createPage` uses (see page-path.ts).
 *
 * Structural only — body, tags, sharing, draft, and the brain index are all
 * untouched and nothing re-indexes (a move changes a page's place, not its
 * text). Only the moved node's `updated_at` is bumped so the move surfaces in
 * the "recently edited" sort. Guards:
 *  - `id` must be one of the owner's pages (returns null otherwise).
 *  - `newParentId`, when set, must be one of the owner's pages
 *    (`ParentPageNotFoundError`) and must NOT be the page itself or one of its
 *    descendants (`PageCycleError`).
 * A move that's already in place is a no-op (returns the current row).
 */
export async function movePage(
  ownerId: string,
  id: string,
  newParentId: string | null,
): Promise<PageRow | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
    .limit(1);
  if (!node) return null;

  const target = newParentId ?? null;
  let newPath: string = PAGES_ROOT_LABEL;

  if (target) {
    if (target === id) throw new PageCycleError();
    const [parent] = await db
      .select({ id: nodes.id, path: nodes.path })
      .from(nodes)
      .where(and(eq(nodes.id, target), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
      .limit(1);
    if (!parent) throw new ParentPageNotFoundError();
    // The new parent must not live inside the moved page's own subtree.
    if (await isDescendantPage(ownerId, id, target)) throw new PageCycleError();
    newPath = childPagePath(parent.path, id);
  }

  // Already where it's being asked to go — nothing to write.
  if ((node.parentId ?? null) === target) return rowOf(node);

  await db.transaction(async (tx) => {
    await tx
      .update(nodes)
      .set({ parentId: target, path: sql`${newPath}::ltree`, updatedAt: new Date() })
      .where(eq(nodes.id, id));
    // Rebuild every descendant's path from the moved node's new path down. The
    // moved node's children still point at it via parent_id (only the moved
    // node's own parent_id changed), so the walk reaches exactly its subtree;
    // each level composes parentNewPath || '.' || idLabel (== childPagePath).
    await tx.execute(sql`
      WITH RECURSIVE subtree AS (
        SELECT id, ${newPath}::text AS new_path
          FROM ${nodes} WHERE id = ${id}
        UNION ALL
        SELECT n.id, s.new_path || '.' || replace(n.id::text, '-', '_')
          FROM ${nodes} n
          JOIN subtree s ON n.parent_id = s.id
         WHERE n.owner_id = ${ownerId} AND n.type = 'page'
      )
      UPDATE ${nodes} SET path = subtree.new_path::ltree
        FROM subtree
       WHERE ${nodes}.id = subtree.id AND subtree.id <> ${id}
    `);
  });

  const [updated] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
  return updated ? rowOf(updated) : null;
}

/** A node that links TO a given page — one inbound `references` edge, resolved
 *  to its source node. Powers the "Referenced by" panel. */
export type Backlink = {
  id: string;
  title: string;
  type: Node['type'];
  icon: string | null;
};

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

/** Thrown by `splitPage` when the page has no heading at the requested level
 *  to split on. The tool layer maps this to a friendly message. */
export class NoSplitHeadingsError extends Error {
  constructor(level: SplitLevel) {
    super(`splitPage: no h${level} headings to split on`);
    this.name = 'NoSplitHeadingsError';
  }
}

export type SplitPageResult = {
  /** The created child pages, in document order. */
  children: { id: string; title: string }[];
  /** Whether intro content (before the first heading) was kept on the parent. */
  introKept: boolean;
};

/**
 * Split a long page into sub-pages along its headings (Phase 4b). Each heading
 * of `by` becomes a child page (title = heading text, body = the blocks under
 * it); the parent's body is replaced with a table-of-contents of `childPage`
 * cards pointing at those children.
 *
 * Safety + indexing model, mirroring the rest of Pages:
 *  - Children are created via `createPage`, whose `nodes` insert fires the
 *    extractor — so each child is indexed independently (its own summary /
 *    embedding / facts), the whole point of splitting.
 *  - The parent's new TOC is written to `draft_doc` ONLY (via `saveDraft`); the
 *    published `doc` is untouched until the user commits, so the restructure is
 *    reviewable. Operates on `draft ?? doc` (the current working content).
 *
 * Byte-faithful: blocks are redistributed, never rewritten (see page-split.ts).
 */
export async function splitPage(
  ownerId: string,
  pageId: string,
  opts: { by: SplitLevel; preserveIntro?: boolean },
): Promise<SplitPageResult> {
  const page = await getPage(ownerId, pageId);
  if (!page) throw new Error(`splitPage: page ${pageId} not found`);

  const source = (page.draft ?? page.doc) as Record<string, unknown>;
  const { intro, sections } = splitDocByHeading(source, opts.by);
  if (sections.length === 0) throw new NoSplitHeadingsError(opts.by);

  const preserveIntro = opts.preserveIntro ?? true;
  const children: { id: string; title: string }[] = [];
  const tocBlocks: Record<string, unknown>[] = preserveIntro
    ? (intro as Record<string, unknown>[])
    : [];

  for (const sec of sections) {
    const childDoc = ensureBlockIds({
      type: 'doc',
      content: sec.blocks.length ? sec.blocks : [{ type: 'paragraph' }],
    });
    const child = await createPage(ownerId, {
      title: sec.title,
      doc: childDoc,
      parentId: pageId,
    });
    children.push({ id: child.id, title: child.title });
    tocBlocks.push({
      type: 'childPage',
      attrs: { pageId: child.id, title: child.title, icon: null },
    });
  }

  const tocDoc = ensureBlockIds({
    type: 'doc',
    content: tocBlocks.length ? tocBlocks : [{ type: 'paragraph' }],
  });
  await saveDraft(ownerId, pageId, tocDoc);

  return { children, introKept: preserveIntro && intro.length > 0 };
}

/** Thrown by `extractSectionToChild` when the block id isn't a top-level
 *  heading (only top-level headings are promotable to sub-pages). */
export class SectionNotFoundError extends Error {
  constructor(headingBlockId: string) {
    super(`extractSectionToChild: no top-level heading with id ${headingBlockId}`);
    this.name = 'SectionNotFoundError';
  }
}

export type ExtractSectionResult = { childId: string; title: string };

/**
 * Promote a single heading + its body into a sub-page (Phase 4c). The section
 * runs from the heading until the next heading of equal-or-higher level; its
 * heading text becomes the child title, the blocks under it the child body, and
 * a `childPage` card replaces the section in the parent. Same safety + indexing
 * model as `splitPage`: child created via `createPage` (indexed on insert),
 * parent rewritten to `draft_doc` only. Operates on `draft ?? doc`.
 */
export async function extractSectionToChild(
  ownerId: string,
  pageId: string,
  headingBlockId: string,
): Promise<ExtractSectionResult> {
  const page = await getPage(ownerId, pageId);
  if (!page) throw new Error(`extractSectionToChild: page ${pageId} not found`);

  const source = (page.draft ?? page.doc) as Record<string, unknown>;
  const section = extractSection(source, headingBlockId);
  if (!section) throw new SectionNotFoundError(headingBlockId);

  const childDoc = ensureBlockIds({
    type: 'doc',
    content: section.childBlocks.length ? section.childBlocks : [{ type: 'paragraph' }],
  });
  const child = await createPage(ownerId, {
    title: section.title,
    doc: childDoc,
    parentId: pageId,
  });

  const newParent = ensureBlockIds({
    type: 'doc',
    content: [
      ...section.before,
      { type: 'childPage', attrs: { pageId: child.id, title: child.title, icon: null } },
      ...section.after,
    ],
  });
  await saveDraft(ownerId, pageId, newParent);

  return { childId: child.id, title: child.title };
}

/** Thrown by `addPageMention` when the mention target isn't one of the owner's
 *  nodes/entities. The tool layer maps this to a friendly message. */
export class MentionTargetNotFoundError extends Error {
  constructor(ref: MentionRef, id: string) {
    super(`addPageMention: ${ref} ${id} not found`);
    this.name = 'MentionTargetNotFoundError';
  }
}

/** Thrown by `addPageMention` when `afterBlockId` doesn't match any block in the
 *  page (stale id, or the user edited since). */
export class MentionAnchorNotFoundError extends Error {
  constructor(blockId: string) {
    super(`addPageMention: anchor block ${blockId} not found`);
    this.name = 'MentionAnchorNotFoundError';
  }
}

export type AddMentionResult = {
  targetId: string;
  /** The chip text written into the page (resolved from the target's title). */
  label: string;
  ref: MentionRef;
  /** The anchor block the chip was placed after, or null when appended. */
  afterBlockId: string | null;
  /** True when the chip was appended to the end of the page. */
  appended: boolean;
};

/**
 * Insert a mention chip into a page — the programmatic equivalent of typing
 * `@Target`. The chip is a REAL link, not plain text: ref='node' points at
 * another page/note and ref='entity' at a person/project/place. The target's
 * current title is resolved from `nodes`/`entities` so the chip text matches
 * what the user sees (override with `label`). The chip lands in a fresh
 * `[leadText ]@Target` paragraph, either appended to the end of the page or
 * dropped right after `afterBlockId` (a block id from listBlocks).
 *
 * Writes to `draft_doc` ONLY — the published doc is untouched. The graph edge
 * (`references` for a node, `mentioned_in` for an entity) is built by the
 * extractor when the user commits, exactly as for a hand-typed mention; this is
 * the same draft-then-review model the block tools use. Returns null if the
 * page doesn't exist.
 */
export async function addPageMention(
  ownerId: string,
  pageId: string,
  opts: {
    targetId: string;
    ref?: MentionRef;
    label?: string;
    leadText?: string;
    afterBlockId?: string | null;
  },
): Promise<AddMentionResult | null> {
  const page = await getPage(ownerId, pageId);
  if (!page) return null;

  const ref: MentionRef = opts.ref === 'entity' ? 'entity' : 'node';
  let label = opts.label?.trim() ?? '';
  let kind: string | null = null;

  // Resolve the target + its display label from the owner's own data, so a
  // mention can never link to (or leak the title of) something they don't own.
  if (ref === 'node') {
    const [n] = await db
      .select({ title: nodes.title, type: nodes.type })
      .from(nodes)
      .where(and(eq(nodes.id, opts.targetId), eq(nodes.ownerId, ownerId)))
      .limit(1);
    if (!n) throw new MentionTargetNotFoundError('node', opts.targetId);
    if (!label) label = n.title;
    kind = n.type;
  } else {
    const [e] = await db
      .select({ name: entities.name, kind: entities.kind })
      .from(entities)
      .where(and(eq(entities.id, opts.targetId), eq(entities.ownerId, ownerId)))
      .limit(1);
    if (!e) throw new MentionTargetNotFoundError('entity', opts.targetId);
    if (!label) label = e.name;
    kind = e.kind;
  }

  const paragraph = buildMentionParagraph({
    id: opts.targetId,
    label,
    ref,
    kind,
    leadText: opts.leadText,
  });

  // Block edits always operate on the current working copy (draft if one's open,
  // else the published doc) and write back to the draft — mirrors the block tools.
  const baseline = (page.draft ?? page.doc) as Record<string, unknown>;
  const afterBlockId = opts.afterBlockId?.trim() || null;

  let nextDoc: Record<string, unknown>;
  if (afterBlockId) {
    const res = insertAfterBlock(baseline, afterBlockId, [paragraph as PMBlockNode]);
    if (!res.found) throw new MentionAnchorNotFoundError(afterBlockId);
    nextDoc = res.doc;
  } else {
    const cloned = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown> & {
      content?: unknown[];
    };
    cloned.content = [...(Array.isArray(cloned.content) ? cloned.content : []), paragraph];
    nextDoc = cloned;
  }

  const res = await saveDraft(ownerId, pageId, nextDoc);
  if (!res.ok) return null;
  return { targetId: opts.targetId, label, ref, afterBlockId, appended: afterBlockId === null };
}

export type UpdatePageInput = Partial<{
  title: string;
  doc: Record<string, unknown>;
  tags: string[];
  icon: string;
  visibility: PageVisibility;
  width: PageWidth;
}>;

export async function updatePage(
  ownerId: string,
  id: string,
  input: UpdatePageInput,
  opts: { reindex?: boolean } = {},
): Promise<PageDetail | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
    .limit(1);
  if (!node) return null;

  const docChanged = input.doc !== undefined;
  // Re-indexing (LLM summary + embedding + fact extraction) is the expensive
  // part, so it's opt-out via `reindex`. The editor never sends a doc through
  // here — it uses the draft/commit path (saveDraft / commitPage); this
  // option exists for programmatic callers that write a doc and want (or want
  // to skip) indexing. Defaults to true.
  const willReindex = docChanged && opts.reindex !== false;
  const oldData = (node.data ?? {}) as Record<string, unknown>;
  const newData: Record<string, unknown> = { ...oldData };
  if (input.icon !== undefined) newData.icon = input.icon;
  if (input.visibility !== undefined) newData.visibility = input.visibility;
  if (input.width !== undefined) newData.width = input.width;
  // A re-index invalidates the extractor's prior summary/embedding.
  if (willReindex) {
    delete newData.summary;
    delete newData.summary_model;
    delete newData.summary_at;
    delete newData.entities;
  }

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(nodes)
      .set({
        ...(input.title !== undefined
          ? { title: input.title.trim().slice(0, 200) || 'Untitled page' }
          : {}),
        ...(input.tags !== undefined ? { tags: dedupeTags(input.tags) } : {}),
        data: newData,
        ...(willReindex ? { embedding: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, id))
      .returning();
    if (!row) throw new Error('updatePage: update returned no row');

    if (docChanged) {
      const doc = input.doc as Record<string, unknown>;
      await tx
        .update(pages)
        .set({
          doc,
          docText: docToText(doc),
          version: sql`${pages.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(pages.nodeId, id));
      return detailOf(row, doc);
    }
    const [p] = await tx
      .select({ doc: pages.doc })
      .from(pages)
      .where(eq(pages.nodeId, id))
      .limit(1);
    return detailOf(row, (p?.doc as Record<string, unknown> | null) ?? EMPTY_DOC);
  });

  if (willReindex) {
    await notifyNodeIngested(id);
  }
  return result;
}

/** Result of a draft/commit write under the `draft_rev` etag. `ok` carries the
 *  NEW rev the client adopts; `conflict` carries the CURRENT server rev so the
 *  client can resync; `missing` means the page is gone. */
export type SaveDraftResult =
  | { ok: true; rev: number }
  | { ok: false; conflict: true; rev: number }
  | { ok: false; missing: true };

/**
 * Autosave the working draft. Persists to `pages.draft_doc` ONLY — the
 * published `doc`/`doc_text`, the summary, the embedding, and the extractor are
 * all left untouched. Cheap and frequent; nothing is rendered to other
 * surfaces or indexed from a draft.
 *
 * Concurrency (audit item #3): the write runs under `withPageLock` and bumps
 * `draft_rev`. When `opts.baseRev` is supplied (the editor's autosave etag) a
 * stale value returns a typed conflict WITHOUT touching the draft, so a second
 * device or the Pages agent can't silently overwrite newer edits. Internal
 * callers omit `baseRev` — they still serialize on the lock and bump the rev,
 * so concurrent programmatic writes are never interleaved (last-write-wins).
 */
export async function saveDraft(
  ownerId: string,
  id: string,
  doc: Record<string, unknown>,
  opts: { baseRev?: number } = {},
): Promise<SaveDraftResult> {
  const [node] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
    .limit(1);
  if (!node) return { ok: false, missing: true };
  // Guarantee every persisted draft carries stable block ids — the autosave
  // endpoint accepts whatever the editor sends, and an editor that doesn't
  // yet preserve the id global attr (or a programmatic write) would
  // otherwise strip them. Idempotent + cheap.
  const enriched = ensureBlockIds(repairTableRows(doc));
  return withPageLock(id, async (tx, locked) => {
    if (!locked) return { ok: false as const, missing: true as const };
    const decision = evaluateDraftRev(locked.draftRev, opts.baseRev);
    if (decision.conflict) {
      return { ok: false as const, conflict: true as const, rev: decision.rev };
    }
    await tx
      .update(pages)
      .set({ draftDoc: enriched, draftUpdatedAt: new Date(), draftRev: sql`${pages.draftRev} + 1` })
      .where(eq(pages.nodeId, id));
    return { ok: true as const, rev: decision.nextRev };
  });
}

/**
 * Commit: publish `doc` as canonical, recompute `doc_text`, clear the draft,
 * bump the version, and fire the extractor. This is the ONLY path that indexes
 * a page body — autosaves never do, so a long editing session produces exactly
 * one index per commit instead of one per pause. Returns the published detail,
 * or null if the page doesn't exist.
 */
/**
 * Throw away the working draft (set draft_doc=null). The published `doc`
 * is untouched; brain index untouched. Used by the AI-assist panel's
 * "Discard" button after the Pages agent writes changes the user
 * decides not to keep. Returns false if the page doesn't exist.
 *
 * Bumps `draft_rev` under the lock: discarding invalidates the base any
 * in-flight writer holds, so their next conditional save conflicts (and
 * refetches) instead of resurrecting the thrown-away draft.
 */
export async function discardDraft(ownerId: string, id: string): Promise<boolean> {
  const [node] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
    .limit(1);
  if (!node) return false;
  await withPageLock(id, async (tx, locked) => {
    if (!locked) return;
    await tx
      .update(pages)
      .set({ draftDoc: null, draftUpdatedAt: null, draftRev: sql`${pages.draftRev} + 1` })
      .where(eq(pages.nodeId, id));
  });
  return true;
}

/** Max chars of a single embedded file's extracted text folded into a page. */
export const EMBED_TEXT_PER_FILE = 4000;
/** Max total chars of embedded-asset text appended to a page's doc_text. */
export const EMBED_TEXT_TOTAL = 16000;

/**
 * Fold an ordered list of embedded files' extracted text into one bounded
 * plaintext block. Pure (no DB) so the bounds/format are unit-testable: each
 * file is capped at `perFile`, the whole block at `total`, empty/whitespace
 * text is skipped, and order is preserved (diff-friendly).
 */
export function foldEmbeddedText(
  items: { title: string; text: string | null | undefined }[],
  perFile = EMBED_TEXT_PER_FILE,
  total = EMBED_TEXT_TOTAL,
): string {
  const parts: string[] = [];
  let budget = total;
  for (const it of items) {
    const text = it.text?.trim();
    if (!text) continue;
    const slice = text.slice(0, Math.min(perFile, budget));
    if (!slice) break;
    parts.push(`[Embedded file: ${it.title}]\n${slice}`);
    budget -= slice.length;
    if (budget <= 0) break;
  }
  return parts.join('\n\n');
}

/**
 * Plaintext of the files a page embeds — images (vision describe + OCR) and
 * document chips (parsed text). `docToText` only surfaces an embed's filename,
 * so without this the page is blind to what's *inside* its own images/docs.
 *
 * Each referenced `file` node's durable `data.text` (written once by the
 * universal file extractor — see extractor.ts §image/document ingest) is folded
 * into the page's `doc_text`, which both the extractor (summary/embedding/facts)
 * and FTS read. A referenced file whose own extraction hasn't landed yet is
 * simply skipped — the next commit picks it up; we deliberately do NOT add a
 * reactive re-extract trigger (keeps cost bounded, per the no-runaway rule).
 */
async function embeddedAssetText(ownerId: string, doc: unknown): Promise<string> {
  const ids = referencedFileIds(doc);
  if (ids.length === 0) return '';

  const rows = await db
    .select({ id: nodes.id, title: nodes.title, data: nodes.data })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, ids), eq(nodes.type, 'file')));
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Map doc embed-order → {title, text}, preserving order; skip unresolved ids.
  const items = ids
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => ({
      title: r.title,
      text: (r.data as Record<string, unknown> | null)?.text as string | undefined,
    }));
  return foldEmbeddedText(items);
}

/** Result of a commit under the `draft_rev` etag: the published detail (with
 *  the bumped rev), a typed conflict (stale base — nothing published), or a
 *  missing page. */
export type CommitPageResult =
  | { ok: true; page: PageDetail }
  | { ok: false; conflict: true; rev: number }
  | { ok: false; missing: true };

export async function commitPage(
  ownerId: string,
  id: string,
  doc: Record<string, unknown>,
  opts: { baseRev?: number } = {},
): Promise<CommitPageResult> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
    .limit(1);
  if (!node) return { ok: false, missing: true };

  // Guarantee the committed doc carries stable per-block ids so the
  // brain (via doc_text), Phase 2b block tools, and the editor diff
  // view all see addressable blocks. Idempotent.
  const enriched = ensureBlockIds(repairTableRows(doc));
  const newData = { ...((node.data ?? {}) as Record<string, unknown>) };
  delete newData.summary;
  delete newData.summary_model;
  delete newData.summary_at;
  delete newData.entities;
  // Fold the text *inside* embedded images (vision/OCR) + doc chips into the
  // indexed plaintext, so the page is searchable by — and its summary reflects —
  // its own assets, not just their filenames.
  const baseText = docToText(enriched);
  const assetText = await embeddedAssetText(ownerId, enriched);
  const docText = assetText ? `${baseText}\n\n${assetText}` : baseText;

  // Same etag guard as saveDraft, under the same lock: a stale `baseRev`
  // returns a conflict WITHOUT publishing, so a client committing a doc it
  // built on an out-of-date draft can't blow away a newer draft. The
  // successful commit clears the draft and bumps `draft_rev` in the same tx.
  const result = await withPageLock(id, async (tx, locked) => {
    if (!locked) return { ok: false as const, missing: true as const };
    const decision = evaluateDraftRev(locked.draftRev, opts.baseRev);
    if (decision.conflict) {
      return { ok: false as const, conflict: true as const, rev: decision.rev };
    }
    const [row] = await tx
      .update(nodes)
      .set({ data: newData, embedding: null, updatedAt: new Date() })
      .where(eq(nodes.id, id))
      .returning();
    if (!row) throw new Error('commitPage: update returned no row');
    await tx
      .update(pages)
      .set({
        doc: enriched,
        docText,
        draftDoc: null,
        draftUpdatedAt: null,
        version: sql`${pages.version} + 1`,
        draftRev: sql`${pages.draftRev} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(pages.nodeId, id));
    return {
      ok: true as const,
      page: detailOf(row, enriched, null, { draftRev: decision.nextRev }),
    };
  });

  if (result.ok) await notifyNodeIngested(id);
  return result;
}

export async function deletePage(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
    .limit(1);
  if (!row) return false;
  await db.delete(nodes).where(eq(nodes.id, id)); // `pages` row cascades.
  return true;
}

function dedupeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (!t || t.length > 40 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}
