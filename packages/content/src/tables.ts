/**
 * Tables surface. A table is a `nodes` row with type='table' plus a `tables`
 * sidecar row holding the typed grid:
 *
 *   nodes.title           display name
 *   nodes.data.icon       optional emoji / icon
 *   nodes.data.summary    extractor-written summary
 *   nodes.data.visibility 'private' | 'public'
 *   tables.data           TableDoc JSON (source of truth)
 *   tables.data_text      derived markdown rendering (extractor + FTS read this)
 *   tables.draft_data     autosaved working copy, promoted on commit
 *
 * All under the `tables` ltree root, lazy-created on first write. `table` is in
 * the extractor's DEFAULT_EXTRACT_TYPES, so summary + embedding land
 * automatically on the next pg_notify('node_ingested'); `readNodeBodyRaw` reads
 * `data_text` from the sidecar. This is the Pages surface re-cut for grids —
 * `data`↔`doc`, `data_text`↔`doc_text`, `draft_data`↔`draft_doc`.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db, nodes, tables, notifyNodeIngested, type Node } from '@mantle/db';
import {
  MATERIALIZE_MAX,
  TableTooLargeError,
  publishedPath,
  relativeStoragePath,
  resolveStoragePath,
  writeDocFile,
  type WorkbookStats,
} from '@mantle/tabledb';
import { ensureTableDoc, emptyTableDoc, type TableDoc } from './table-model';
import {
  draftAbsFor,
  loadDocsFromFile,
  registryFileColumns,
  removeTableFile,
  withTableRegistryLock,
} from './table-storage';
import { tableToText } from './table-to-text';

export const TABLES_ROOT_LABEL = 'tables';

export type TableVisibility = 'private' | 'public';

export type TableRow = {
  id: string;
  title: string;
  icon: string | null;
  tags: string[];
  summary: string | null;
  visibility: TableVisibility;
  /** Quick stats for the list (cheap to compute from the doc). */
  columnCount: number;
  rowCount: number;
  createdAt: string;
  updatedAt: string;
};

export type TableDetail = TableRow & {
  /** Published grid — what's rendered everywhere and what the extractor
   *  indexes. Only changes on commit. */
  data: TableDoc;
  /** Autosaved working copy if uncommitted edits exist, else null. */
  draft: TableDoc | null;
};

function rowOf(n: Node, counts: { columnCount: number; rowCount: number }): TableRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  return {
    id: n.id,
    title: n.title,
    icon: typeof d.icon === 'string' ? d.icon : null,
    tags: n.tags ?? [],
    summary: typeof d.summary === 'string' ? d.summary : null,
    visibility: d.visibility === 'public' ? 'public' : 'private',
    columnCount: counts.columnCount,
    rowCount: counts.rowCount,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

function countsOf(data: TableDoc): { columnCount: number; rowCount: number } {
  return { columnCount: data.columns.length, rowCount: data.rows.length };
}

/** Counts for the list WITHOUT materializing: registry `stats` when the table
 *  is file-backed (or backfilled), else a JSONB parse (legacy rows only —
 *  the pre-v2 behavior). */
function countsFromRegistry(stats: unknown, data: unknown): { columnCount: number; rowCount: number } {
  const s = stats as WorkbookStats | null;
  if (s && Array.isArray(s.tabs)) {
    return {
      columnCount: s.tabs.reduce((a, t) => Math.max(a, t.columns), 0),
      rowCount: s.tabs.reduce((a, t) => a + t.rows, 0),
    };
  }
  return countsOf(ensureTableDoc(data));
}

function detailOf(n: Node, data: TableDoc, draft: TableDoc | null = null): TableDetail {
  return { ...rowOf(n, countsOf(data)), data, draft };
}

/** Published + draft docs for a registry row: workbook file when file-backed
 *  (draft-first callers get both), JSONB otherwise. */
function docsOf(row: { storagePath: string | null; data: unknown; draft: unknown }): {
  data: TableDoc;
  draft: TableDoc | null;
} {
  if (row.storagePath) return loadDocsFromFile(row.storagePath);
  return {
    data: ensureTableDoc(row.data ?? emptyTableDoc()),
    draft: row.draft != null ? ensureTableDoc(row.draft) : null,
  };
}

/** Truncation guard (plan §4): whole-doc writes past the materialize window
 *  are refused on BOTH the draft and commit routes — a windowed doc committed
 *  whole would BE published truncation. Imports split at 10k today, so this
 *  cannot fire for legitimate docs; it exists to make the failure loud. */
function guardWholeDoc(doc: TableDoc): void {
  if (doc.rows.length > MATERIALIZE_MAX) {
    throw new TableTooLargeError(doc.rows.length, MATERIALIZE_MAX);
  }
}

/** P1 workbooks carry the single engine-default tab; real tab names arrive
 *  with multi-tab (un-split) imports in P3. */
const TAB_NAME = 'Sheet1';

async function ensureRoot(ownerId: string): Promise<void> {
  await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'branch',
      title: 'Tables',
      slug: TABLES_ROOT_LABEL,
      path: TABLES_ROOT_LABEL,
      data: { description: 'Typed database grids. Indexed and embedded automatically.' },
    })
    .onConflictDoNothing({
      target: [nodes.ownerId, nodes.path],
      where: sql`${nodes.type} = 'branch'`,
    });
}

export type TableSort = 'edited' | 'newest' | 'oldest' | 'title';
type ListTablesOpts = { query?: string; tag?: string; sort?: TableSort };

function tableOrderBy(sort?: TableSort) {
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

function tableConds(ownerId: string, opts: ListTablesOpts) {
  const conds = [eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')];
  if (opts.query?.trim()) {
    const q = `%${opts.query.trim()}%`;
    const c = or(
      ilike(nodes.title, q),
      sql`${tables.dataText} ilike ${q}`,
      sql`${nodes.data}->>'summary' ilike ${q}`,
    );
    if (c) conds.push(c);
  }
  if (opts.tag) conds.push(sql`${opts.tag} = ANY(${nodes.tags})`);
  return conds;
}

export async function listTables(
  ownerId: string,
  opts: ListTablesOpts & { limit?: number; offset?: number } = {},
): Promise<TableRow[]> {
  // Counts come from the registry `stats` column — the list NEVER opens
  // workbook files and only falls back to a JSONB parse for legacy rows that
  // haven't committed since v2 (thundering-herd guard, plan §9).
  const rows = await db
    .select({ node: nodes, data: tables.data, stats: tables.stats })
    .from(nodes)
    .leftJoin(tables, eq(tables.nodeId, nodes.id))
    .where(and(...tableConds(ownerId, opts)))
    .orderBy(tableOrderBy(opts.sort))
    .limit(opts.limit ?? 500)
    .offset(opts.offset ?? 0);
  return rows.map((r) => rowOf(r.node, countsFromRegistry(r.stats, r.data)));
}

export async function countTables(ownerId: string, opts: ListTablesOpts = {}): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .leftJoin(tables, eq(tables.nodeId, nodes.id))
    .where(and(...tableConds(ownerId, opts)));
  return row?.n ?? 0;
}

export async function listTableTags(
  ownerId: string,
): Promise<{ tag: string; count: number }[]> {
  const rows = await db
    .select({ tags: nodes.tags })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')));
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export async function getTable(ownerId: string, id: string): Promise<TableDetail | null> {
  const [row] = await db
    .select({
      node: nodes,
      data: tables.data,
      draft: tables.draftData,
      storagePath: tables.storagePath,
    })
    .from(nodes)
    .leftJoin(tables, eq(tables.nodeId, nodes.id))
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!row) return null;
  const { data, draft } = docsOf(row);
  return detailOf(row.node, data, draft);
}

export type CreateTableInput = {
  title: string;
  data?: TableDoc;
  tags?: string[];
  icon?: string;
  /** Provenance: the `file` node this grid was imported from. Stamped on the
   *  table node's `data.sourceFileId` so an auto-importer can dedupe (don't
   *  re-create a table for a file that already has one) and the UI can link back
   *  to the source. Ignored by the table renderer (the grid lives in
   *  `tables.data`). */
  sourceFileId?: string;
};

export async function createTable(
  ownerId: string,
  input: CreateTableInput,
): Promise<TableDetail> {
  await ensureRoot(ownerId);
  const data = ensureTableDoc(input.data ?? emptyTableDoc());
  guardWholeDoc(data);
  const id = randomUUID();

  // Sqlite-first (signed off 2026-07-15): the workbook file is written inside
  // the transaction, BEFORE the registry row that references it becomes
  // visible — a registry row pointing at a missing file can never be
  // committed. On any failure the transaction rolls back and the orphan file
  // is swept. JSONB `data`/`data_text` are dual-written through the
  // transition (rollback = clear storage_path, plan §9).
  const publishedAbs = publishedPath(ownerId, id);
  try {
    return await db.transaction(async (tx) => {
      const [node] = await tx
        .insert(nodes)
        .values({
          id,
          ownerId,
          type: 'table',
          title: input.title.trim().slice(0, 200) || 'Untitled table',
          path: TABLES_ROOT_LABEL,
          data: {
            visibility: 'private',
            ...(input.icon ? { icon: input.icon } : {}),
            ...(input.sourceFileId ? { sourceFileId: input.sourceFileId } : {}),
          },
          tags: dedupeTags(input.tags ?? []),
        })
        .returning();
      if (!node) throw new Error('createTable: insert returned no row');
      const res = writeDocFile(publishedAbs, data, { nodeId: id, ownerId, tabName: TAB_NAME });
      await tx.insert(tables).values({
        nodeId: node.id,
        data,
        dataText: tableToText(data, { title: node.title }),
        ...registryFileColumns(res, relativeStoragePath(ownerId, id)),
      });
      return detailOf(node, data);
    });
  } catch (err) {
    removeTableFile(publishedAbs);
    throw err;
  }
}

export type UpdateTableInput = Partial<{
  title: string;
  tags: string[];
  icon: string;
  visibility: TableVisibility;
}>;

/** Metadata-only update (title / tags / icon / visibility). Never touches the
 *  grid or the index — grid edits go through saveTableDraft + commitTable. */
export async function updateTable(
  ownerId: string,
  id: string,
  input: UpdateTableInput,
): Promise<TableDetail | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!node) return null;

  const oldData = (node.data ?? {}) as Record<string, unknown>;
  const newData: Record<string, unknown> = { ...oldData };
  if (input.icon !== undefined) newData.icon = input.icon;
  if (input.visibility !== undefined) newData.visibility = input.visibility;

  const [row] = await db
    .update(nodes)
    .set({
      ...(input.title !== undefined
        ? { title: input.title.trim().slice(0, 200) || 'Untitled table' }
        : {}),
      ...(input.tags !== undefined ? { tags: dedupeTags(input.tags) } : {}),
      data: newData,
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id))
    .returning();
  if (!row) return null;

  const [p] = await db
    .select({ data: tables.data, draft: tables.draftData, storagePath: tables.storagePath })
    .from(tables)
    .where(eq(tables.nodeId, id))
    .limit(1);
  const { data, draft } = docsOf(p ?? { storagePath: null, data: null, draft: null });
  return detailOf(row, data, draft);
}

/** Autosave the working grid to `tables.draft_data` only — published `data`,
 *  `data_text`, summary, embedding, and the extractor are all untouched. Cheap
 *  and frequent. Returns false if the table doesn't exist. */
export async function saveTableDraft(
  ownerId: string,
  id: string,
  data: TableDoc,
): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id, storagePath: tables.storagePath })
    .from(nodes)
    .leftJoin(tables, eq(tables.nodeId, nodes.id))
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!row) return false;
  const doc = ensureTableDoc(data);
  guardWholeDoc(doc);
  // Registry lock spine: the draft-file rebuild and the registry update are
  // one locked step, so a concurrent agent op / second process can't
  // interleave mid-write. draft_rev bumps on every batch (the P3 op route's
  // etag; bumped from day one so it's trustworthy by then).
  await withTableRegistryLock(id, async (tx) => {
    if (row.storagePath) {
      writeDocFile(draftAbsFor(row.storagePath), doc, { nodeId: id, ownerId, tabName: TAB_NAME });
    }
    await tx
      .update(tables)
      .set({
        draftData: doc,
        draftUpdatedAt: new Date(),
        draftRev: sql`${tables.draftRev} + 1`,
      })
      .where(eq(tables.nodeId, id));
  });
  return true;
}

/** Throw away the working draft. Published grid + index untouched. */
export async function discardTableDraft(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id, storagePath: tables.storagePath })
    .from(nodes)
    .leftJoin(tables, eq(tables.nodeId, nodes.id))
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!row) return false;
  await withTableRegistryLock(id, async (tx) => {
    if (row.storagePath) removeTableFile(draftAbsFor(row.storagePath));
    await tx
      .update(tables)
      .set({ draftData: null, draftUpdatedAt: null, draftRev: sql`${tables.draftRev} + 1` })
      .where(eq(tables.nodeId, id));
  });
  return true;
}

/**
 * Commit: publish `data` as canonical, recompute `data_text`, clear the draft,
 * bump the version, and fire the extractor. The ONLY path that indexes a table —
 * autosaves never do, so a long editing session produces exactly one re-index
 * per commit (cost-safe, matching Pages). Returns the published detail, or null
 * if the table doesn't exist.
 */
export async function commitTable(
  ownerId: string,
  id: string,
  data: TableDoc,
): Promise<TableDetail | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!node) return null;

  const doc = ensureTableDoc(data);
  guardWholeDoc(doc);
  const newData = { ...((node.data ?? {}) as Record<string, unknown>) };
  delete newData.summary;
  delete newData.summary_model;
  delete newData.summary_at;
  delete newData.entities;
  const dataText = tableToText(doc, { title: node.title });

  // Commit under the registry lock (plan §3.3): write the new published file
  // (build + checkpoint + atomic rename inside writeDocFile), drop the draft
  // file, then bump version/stats — one serialized step. A legacy JSONB table
  // converts to file-backed here (commit has the full doc in hand, and the
  // lock is the same one migration takes, so the two can never fork).
  const publishedAbs = publishedPath(ownerId, id);
  const result = await withTableRegistryLock(id, async (tx) => {
    const [row] = await tx
      .update(nodes)
      .set({ data: newData, embedding: null, updatedAt: new Date() })
      .where(eq(nodes.id, id))
      .returning();
    if (!row) throw new Error('commitTable: update returned no row');
    const res = writeDocFile(publishedAbs, doc, { nodeId: id, ownerId, tabName: TAB_NAME });
    removeTableFile(draftAbsFor(relativeStoragePath(ownerId, id)));
    await tx
      .update(tables)
      .set({
        data: doc,
        dataText,
        draftData: null,
        draftUpdatedAt: null,
        draftRev: sql`${tables.draftRev} + 1`,
        version: sql`${tables.version} + 1`,
        updatedAt: new Date(),
        ...registryFileColumns(res, relativeStoragePath(ownerId, id)),
      })
      .where(eq(tables.nodeId, id));
    return detailOf(row, doc, null);
  });

  await notifyNodeIngested(id);
  return result;
}

export async function deleteTable(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id, storagePath: tables.storagePath })
    .from(nodes)
    .leftJoin(tables, eq(tables.nodeId, nodes.id))
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!row) return false;
  await db.delete(nodes).where(eq(nodes.id, id)); // `tables` row cascades.
  // Workbook files go AFTER the registry delete commits (a failed delete must
  // never leave a registry row pointing at removed files). Best-effort; the
  // sanity check reports orphaned files.
  if (row.storagePath) {
    const abs = resolveStoragePath(row.storagePath);
    removeTableFile(abs);
    removeTableFile(draftAbsFor(row.storagePath));
  }
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
