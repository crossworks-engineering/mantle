/**
 * Pages · read paths. Every query that returns a page without changing one:
 * the list/count/tag surface, the single-page read and inbound backlinks.
 * Where a page sits (its folder) is the item tree's read (tree/read.ts);
 * pages do not nest (folder phase 7).
 *
 * The one write it performs is `persistBlockIdBackfill`: maintenance, not an
 * edit (no version bump, no re-index, fire-and-forget), and a compare-and-set
 * over what the read saw, so an edit that lands first is never lost.
 */
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import {
  db,
  nodeReadByWorkspace,
  draftAllowed,
  draftColumn,
  emailAttachmentSql,
  entityEdges,
  nodes,
  pages,
  runReadPathWrite,
} from '@mantle/db';
import { ensureBlockIds, repairTableRows } from '@mantle/content-core/block-ids';
import type { Backlink, PageRow, PageSort } from '@mantle/client-types';
import { EMPTY_DOC, PAGES_ROOT_LABEL, detailOf, rowOf, type PageDetail } from './shared';
import { inScopeTransaction, readsDrafts } from '@mantle/db/viewer';

type ListPagesOpts = {
  query?: string;
  tag?: string;
  sort?: PageSort;
  /** Leave out email attachments and items made from one (an API key
   *  without the Search area: access matrix M4, T4). */
  withoutEmailCopies?: boolean;
  /** Only the pages this workspace reads (`?ws=`, W5b2): a checked id. */
  ws?: string;
};

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
  if (opts.withoutEmailCopies) conds.push(sql`not ${emailAttachmentSql()}`);
  if (opts.ws) conds.push(nodeReadByWorkspace(opts.ws));
  return conds;
}

export async function listPages(
  ownerId: string,
  opts: ListPagesOpts & { limit?: number; offset?: number } = {},
): Promise<PageRow[]> {
  // Only the node columns are used: selecting the whole pages row would also
  // read the draft, which a below-admin viewer may not (member logins 0b).
  const rows = await db
    .select({ nodes })
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
  // Below admin (a team-level agent, member logins Phase 0b) the draft is the
  // author's working copy and is not readable: the published doc only. In a
  // member's own space (Phase 2) the draft IS the reader's working copy.
  const published = !readsDrafts();
  const [row] = await db
    .select({
      node: nodes,
      doc: pages.doc,
      // An Admin user's request scope reads a draft only of an item it may
      // edit (draftColumn: the rule is in the query, W6a).
      draft: published ? sql<null>`null` : draftColumn<unknown>(pages.draftDoc),
      draftUpdatedAt: published ? sql<null>`null` : draftColumn<Date>(pages.draftUpdatedAt),
      draftRev: published ? sql<null>`null` : draftColumn<number>(pages.draftRev),
      // Whether the reader may edit the page (the draft rule): only an
      // editor's read repairs it (W6a fix round 1, L2).
      mayEdit: published ? sql<boolean>`false` : draftAllowed(),
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
  // Never inside a scope's own transaction (a personal space, withScope,
  // withSystemTx): it ends with its caller, before a fire-and-forget write
  // would run, and on a viewer role the write is refused (W6a fix round 2).
  // The next read outside one repairs the page. In a request scope the
  // write goes to the system pool (`db`, packages/db gateway/handles.ts).
  // Nor for a reader who may not edit the page (an Admin user with Read
  // only): a read never writes an item its reader cannot change.
  if (
    (docChanged || draftChanged) &&
    !published &&
    row.mayEdit === true &&
    row.doc !== null &&
    !inScopeTransaction()
  ) {
    // Arch A2a: a named system write (it never runs as the reader, so a
    // read-only key's read still repairs), detached from the read.
    void runReadPathWrite('backfill:page-block-ids', () =>
      persistBlockIdBackfill(
        id,
        { doc: row.doc as Record<string, unknown>, draft: rawDraft, draftRev: row.draftRev ?? 0 },
        docChanged ? doc : null,
        draftChanged ? draft : null,
      ),
    );
  }

  return {
    ...detailOf(row.node, doc, draft, { draftRev: row.draftRev ?? 0 }),
    draftUpdatedAt: draft ? (row.draftUpdatedAt?.toISOString() ?? null) : null,
    folderId: await pageFolderId(ownerId, String(row.node.path)),
  };
}

/**
 * The folder a page sits in (folder phase 7): the `branch` row at its path,
 * the owner's or the brain's (a member's draft sits at a brain folder's
 * path); null at the top level. Answered by `mantle_page_folder_id`
 * (migration 0210, SECURITY DEFINER), whatever role the caller runs under:
 * a folder's own row is not readable by a member (it inherits only from
 * above itself), and the id alone gives nothing away: the tree route
 * answers 404 for a folder the reader may not see.
 */
async function pageFolderId(
  ownerId: string,
  path: string,
  reader?: 'client',
): Promise<string | null> {
  if (path === PAGES_ROOT_LABEL || !path.startsWith(`${PAGES_ROOT_LABEL}.`)) return null;
  const rows = (await db.execute(sql`
    select mantle_page_folder_id(${ownerId}::uuid, ${path}::ltree, ${reader ?? null})::text as id`)) as unknown as Array<{
    id: string | null;
  }>;
  return rows[0]?.id ?? null;
}

/** The folder a page sits in, by the page's id (for the reader bodies that
 *  carry a doc without the row: the member Library, accepted items, a
 *  client's shared items). The page row is read as the caller (it reads the
 *  page itself). For a client (`reader`), only a folder shared with clients
 *  is named: a page shared on its own gives away no unshared folder. Null
 *  at the top level or for no such page. */
export async function pageFolderIdOf(
  ownerId: string,
  pageId: string,
  reader?: 'client',
): Promise<string | null> {
  const [row] = await db
    .select({ path: nodes.path })
    .from(nodes)
    .where(and(eq(nodes.id, pageId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
    .limit(1);
  return row ? pageFolderId(ownerId, String(row.path), reader) : null;
}

/** What a read saw of the pages row: the repair writes only over exactly that. */
export type BlockIdRepairSeen = {
  doc: Record<string, unknown>;
  draft: Record<string, unknown> | null;
  draftRev: number;
};

/**
 * Write enriched `doc` and/or `draft_doc` back to the pages row when the
 * lazy backfill in getPage added ids. Fire-and-forget: never blocks the
 * read path, never re-extracts (deliberately no notifyNodeIngested, no
 * version bump, no updatedAt touch: this is maintenance, not an edit).
 *
 * A compare-and-set (W8b): the row is written only while its doc, draft and
 * draft_rev are still what the read saw. An autosave or commit that lands
 * between the read and this write wins, and the repair writes nothing; the
 * next read injects the ids again. Answers whether it wrote.
 */
export async function persistBlockIdBackfill(
  id: string,
  seen: BlockIdRepairSeen,
  doc: Record<string, unknown> | null,
  draft: Record<string, unknown> | null,
): Promise<boolean> {
  try {
    const patch: Record<string, unknown> = {};
    if (doc) patch.doc = doc;
    if (draft) patch.draftDoc = draft;
    if (Object.keys(patch).length === 0) return false;
    const seenDraft = seen.draft === null ? null : JSON.stringify(seen.draft);
    const wrote = await db
      .update(pages)
      .set(patch)
      .where(
        and(
          eq(pages.nodeId, id),
          eq(pages.draftRev, seen.draftRev),
          sql`${pages.doc} = ${JSON.stringify(seen.doc)}::jsonb`,
          sql`${pages.draftDoc} is not distinct from ${seenDraft}::jsonb`,
        ),
      )
      .returning({ id: pages.nodeId });
    return wrote.length > 0;
  } catch (err) {
    console.error('[pages] block-id backfill persist failed (non-fatal):', err);
    return false;
  }
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
