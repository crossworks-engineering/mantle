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
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db, nodes, pages, notifyNodeIngested, type Node } from '@mantle/db';
import { docToText } from './doc-to-text';

export const PAGES_ROOT_LABEL = 'pages';

/** An empty ProseMirror document — a single empty paragraph. */
export const EMPTY_DOC: Record<string, unknown> = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

export type PageVisibility = 'private' | 'public';

export type PageRow = {
  id: string;
  title: string;
  icon: string | null;
  tags: string[];
  summary: string | null;
  visibility: PageVisibility;
  createdAt: string;
  updatedAt: string;
};

export type PageDetail = PageRow & { doc: Record<string, unknown> };

function rowOf(n: Node): PageRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  return {
    id: n.id,
    title: n.title,
    icon: typeof d.icon === 'string' ? d.icon : null,
    tags: n.tags ?? [],
    summary: typeof d.summary === 'string' ? d.summary : null,
    visibility: d.visibility === 'public' ? 'public' : 'private',
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

function detailOf(n: Node, doc: Record<string, unknown>): PageDetail {
  return { ...rowOf(n), doc };
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

type ListPagesOpts = { query?: string; tag?: string };

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
    .orderBy(desc(nodes.updatedAt))
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
    .select({ node: nodes, doc: pages.doc })
    .from(nodes)
    .leftJoin(pages, eq(pages.nodeId, nodes.id))
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
    .limit(1);
  if (!row) return null;
  return detailOf(row.node, (row.doc as Record<string, unknown> | null) ?? EMPTY_DOC);
}

export type CreatePageInput = {
  title: string;
  doc?: Record<string, unknown>;
  tags?: string[];
  icon?: string;
};

export async function createPage(ownerId: string, input: CreatePageInput): Promise<PageDetail> {
  await ensureRoot(ownerId);
  const doc = input.doc ?? EMPTY_DOC;
  const docText = docToText(doc);
  return db.transaction(async (tx) => {
    const [node] = await tx
      .insert(nodes)
      .values({
        ownerId,
        type: 'page',
        title: input.title.trim().slice(0, 200) || 'Untitled page',
        path: PAGES_ROOT_LABEL,
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

export type UpdatePageInput = Partial<{
  title: string;
  doc: Record<string, unknown>;
  tags: string[];
  icon: string;
  visibility: PageVisibility;
}>;

export async function updatePage(
  ownerId: string,
  id: string,
  input: UpdatePageInput,
): Promise<PageDetail | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
    .limit(1);
  if (!node) return null;

  const docChanged = input.doc !== undefined;
  const oldData = (node.data ?? {}) as Record<string, unknown>;
  const newData: Record<string, unknown> = { ...oldData };
  if (input.icon !== undefined) newData.icon = input.icon;
  if (input.visibility !== undefined) newData.visibility = input.visibility;
  // A doc change invalidates the extractor's prior summary/embedding.
  if (docChanged) {
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
        ...(docChanged ? { embedding: null } : {}),
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

  if (docChanged) {
    await notifyNodeIngested(id);
  }
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
