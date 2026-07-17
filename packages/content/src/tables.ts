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
import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import {
  MATERIALIZE_MAX,
  TableTooLargeError,
  importMaxRows,
  applyOpsToFile,
  draftPathFor,
  fileStats,
  finalizePublishedFile,
  publishedPath,
  readDocClipped,
  relativeStoragePath,
  resolveStoragePath,
  shapeHashOf,
  shapeHashOfFile,
  snapshotFile,
  writeDocFile,
  type TableOp,
  type WorkbookStats,
} from '@mantle/tabledb';
import {
  coerceCell,
  ensureTableDoc,
  ensureWorkbookDoc,
  emptyTableDoc,
  type TableDoc,
  type WorkbookDoc,
} from './table-model';
import {
  buildTableDataText,
  draftAbsFor,
  ensureDraftFile,
  ensureFileBacked,
  loadDocsFromFile,
  registryFileColumns,
  removeTableFile,
  withTableRegistryLock,
} from './table-storage';

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

export type TableTabInfo = { id: string; name: string; rows: number; columns: number };

export type TableDetail = TableRow & {
  /** Published grid — what's rendered everywhere and what the extractor
   *  indexes. Only changes on commit. For tables past the materialize window
   *  this is a LEADING WINDOW (`docClipped`) — page the rest via the rows
   *  route / windowed readers; `rowCount` stays the true total. For multi-tab
   *  workbooks this is ONE tab (the requested one, default first). */
  data: TableDoc;
  /** Autosaved working copy if uncommitted edits exist, else null. */
  draft: TableDoc | null;
  /** True when data/draft rows were clipped at the materialize window. */
  docClipped?: boolean;
  /** Draft-op etag: send back as if_rev so a stale client loses loudly. */
  draftRev?: number;
  /** Workbook tabs in position order (from registry stats; absent for legacy
   *  JSONB tables). `data`/`draft` carry the tab identified by `tabId`. */
  tabs?: TableTabInfo[];
  /** Which tab `data`/`draft` materialize (multi-tab workbooks). */
  tabId?: string;
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
function countsFromRegistry(
  stats: unknown,
  data: unknown,
): { columnCount: number; rowCount: number } {
  const s = stats as WorkbookStats | null;
  if (s && Array.isArray(s.tabs)) {
    return {
      columnCount: s.tabs.reduce((a, t) => Math.max(a, t.columns), 0),
      rowCount: s.tabs.reduce((a, t) => a + t.rows, 0),
    };
  }
  return countsOf(ensureTableDoc(data));
}

function detailOf(
  n: Node,
  data: TableDoc,
  draft: TableDoc | null = null,
  extra: {
    totalRows?: number;
    docClipped?: boolean;
    draftRev?: number;
    tabs?: TableTabInfo[];
    tabId?: string;
  } = {},
): TableDetail {
  const counts = countsOf(data);
  if (extra.totalRows !== undefined) counts.rowCount = extra.totalRows;
  return {
    ...rowOf(n, counts),
    data,
    draft,
    ...(extra.docClipped ? { docClipped: true } : {}),
    ...(extra.draftRev !== undefined ? { draftRev: extra.draftRev } : {}),
    ...(extra.tabs ? { tabs: extra.tabs } : {}),
    ...(extra.tabId ? { tabId: extra.tabId } : {}),
  };
}

/** Tab list for the detail payload, straight from registry stats. */
function tabsFromStats(stats: unknown): TableTabInfo[] | undefined {
  const s = stats as WorkbookStats | null;
  if (!s || !Array.isArray(s.tabs) || s.tabs.length === 0) return undefined;
  return s.tabs.map((t) => ({ id: t.tabId, name: t.name, rows: t.rows, columns: t.columns }));
}

type DocsRow = { storagePath: string | null; data: unknown; draft: unknown };

/** Published + draft docs for a registry row: workbook file when file-backed
 *  (draft-first callers get both), JSONB otherwise. `tabId` picks the tab to
 *  materialize (file-backed only; default first). */
function docsOf(
  row: DocsRow,
  tabId?: string,
): {
  data: TableDoc;
  draft: TableDoc | null;
  totalRows: number;
  docClipped: boolean;
} {
  if (row.storagePath) {
    const loaded = loadDocsFromFile(row.storagePath, { tabId });
    return {
      data: loaded.data,
      draft: loaded.draft,
      totalRows: loaded.totalRows,
      docClipped: loaded.docClipped,
    };
  }
  const data = ensureTableDoc(row.data ?? emptyTableDoc());
  return {
    data,
    draft: row.draft != null ? ensureTableDoc(row.draft) : null,
    totalRows: data.rows.length,
    docClipped: false,
  };
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

export async function listTableTags(ownerId: string): Promise<{ tag: string; count: number }[]> {
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

export async function getTable(
  ownerId: string,
  id: string,
  opts: { tabId?: string } = {},
): Promise<TableDetail | null> {
  const [row] = await db
    .select({
      node: nodes,
      data: tables.data,
      draft: tables.draftData,
      storagePath: tables.storagePath,
      draftRev: tables.draftRev,
      stats: tables.stats,
    })
    .from(nodes)
    .leftJoin(tables, eq(tables.nodeId, nodes.id))
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!row) return null;
  // Tab list: the DRAFT file's when one exists (a tab added/renamed in the
  // draft must show), else registry stats (published, no file open needed).
  let tabs = row.storagePath ? tabsFromStats(row.stats) : undefined;
  if (row.storagePath) {
    const draftAbs = draftAbsFor(row.storagePath);
    if (existsSync(draftAbs)) {
      try {
        tabs = tabsFromStats(fileStats(draftAbs)) ?? tabs;
      } catch {
        // draft consumed by a concurrent commit — published stats stand
      }
    }
  }
  const tabId = opts.tabId ?? tabs?.[0]?.id;
  // Materialize the RESOLVED tab, not the caller's (possibly undefined) one:
  // when a draft tab_delete/tab_reorder changed the first tab, "default tab"
  // must mean the same tab on both the published and draft side (audit: the
  // payload mixed published tab A with draft tab B).
  const { data, draft, totalRows, docClipped } = docsOf(row, tabId);
  return detailOf(row.node, data, draft, {
    totalRows,
    docClipped,
    draftRev: row.draftRev ?? 0,
    ...(tabs ? { tabs } : {}),
    ...(tabs && tabId ? { tabId } : {}),
  });
}

export type ApplyTableOpsResult =
  | { ok: true; draftRev: number; createdIds: (string | null)[] }
  | { ok: false; conflict: true; currentRev: number };

/**
 * Apply an op batch to a table's DRAFT (P3): the whole batch lands atomically
 * on the draft workbook file under the registry lock; `draft_rev` is the etag
 * — a caller presenting a stale `ifRev` gets a conflict (refetch, re-apply),
 * never a silent interleave. A legacy JSONB table lazily migrates to file
 * storage on its first op (same lock, so migration and ops can't fork).
 * Returns null when the table doesn't exist.
 */
export async function applyTableOps(
  ownerId: string,
  id: string,
  ops: TableOp[],
  opts: { ifRev?: number } = {},
): Promise<ApplyTableOpsResult | null> {
  const [node] = await db
    .select({ id: nodes.id, title: nodes.title })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!node) return null;
  return withTableRegistryLock(id, async (tx, locked) => {
    if (!locked) return null;
    if (opts.ifRev !== undefined && locked.draftRev !== opts.ifRev) {
      return { ok: false as const, conflict: true as const, currentRev: locked.draftRev };
    }
    const { storagePath } = await ensureFileBacked(tx, { id, ownerId, title: node.title }, locked);
    const publishedAbs = resolveStoragePath(storagePath);
    const draftAbs = ensureDraftFile(publishedAbs);
    const res = applyOpsToFile(draftAbs, ops, coerceCell);
    // JSONB draft mirror (rollback safety) — only while it fits the window
    // AND stays single-tab (the mirror can't represent tabs); otherwise null
    // and the file is the sole draft carrier.
    const clipped = readDocClipped(draftAbs, MATERIALIZE_MAX);
    const multiTab = fileStats(draftAbs).tabs.length > 1;
    await tx
      .update(tables)
      .set({
        draftData: clipped.clipped || multiTab ? null : ensureTableDoc(clipped.doc),
        draftUpdatedAt: new Date(),
        draftRev: sql`${tables.draftRev} + 1`,
      })
      .where(eq(tables.nodeId, id));
    return { ok: true as const, draftRev: locked.draftRev + 1, createdIds: res.createdIds };
  });
}

export type CreateTableInput = {
  title: string;
  data?: TableDoc;
  /** Multi-tab creation (import: one workbook per spreadsheet, sheet→tab).
   *  Mutually exclusive with `data`; wins when both are set. */
  tabs?: WorkbookDoc['tabs'];
  tags?: string[];
  icon?: string;
  /** Provenance: the `file` node this grid was imported from. Stamped on the
   *  table node's `data.sourceFileId` so an auto-importer can dedupe (don't
   *  re-create a table for a file that already has one) and the UI can link back
   *  to the source. Ignored by the table renderer (the grid lives in
   *  `tables.data`). */
  sourceFileId?: string;
};

export async function createTable(ownerId: string, input: CreateTableInput): Promise<TableDetail> {
  await ensureRoot(ownerId);
  const workbook = input.tabs?.length ? ensureWorkbookDoc({ tabs: input.tabs }) : null;
  const data = workbook
    ? ensureTableDoc(workbook.tabs[0])
    : ensureTableDoc(input.data ?? emptyTableDoc());
  const totalRows = workbook
    ? workbook.tabs.reduce((a, t) => a + t.rows.length, 0)
    : data.rows.length;
  // Imports are the one whole-doc entry point allowed past the materialize
  // window (part-splitting is dead) — bounded by the explicit-error ceiling
  // (signed off: error with guidance, never auto-raise or silent partial).
  if (totalRows > importMaxRows()) {
    throw new TableTooLargeError(totalRows, importMaxRows(), 'import');
  }
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
      const res = writeDocFile(publishedAbs, workbook ?? data, {
        nodeId: id,
        ownerId,
        tabName: TAB_NAME,
        fts: true,
      });
      await tx.insert(tables).values({
        nodeId: node.id,
        // JSONB mirror only while it fits the window AND stays single-tab;
        // beyond either, the file is the sole carrier (a multi-hundred-MB
        // blob mirrors nothing useful, and the mirror can't represent tabs).
        data: !workbook && data.rows.length <= MATERIALIZE_MAX ? data : {},
        dataText: buildTableDataText(publishedAbs, workbook ? null : data, node.title),
        ...registryFileColumns(res, relativeStoragePath(ownerId, id)),
      });
      return detailOf(node, data, null, {
        totalRows,
        tabs: tabsFromStats(res.stats),
        tabId: res.stats.tabs[0]?.tabId,
      });
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

/** A workbook (multi-tab) write shape, vs a bare single-tab doc. */
function isWorkbook(data: TableDoc | WorkbookDoc): data is WorkbookDoc {
  return 'tabs' in data && Array.isArray((data as WorkbookDoc).tabs);
}

/** Refuse a bare single-tab doc against a multi-tab workbook: writing it
 *  whole would silently DROP every other tab. Tab-aware callers pass a
 *  WorkbookDoc; per-tab editors use draft ops with a tabId. */
function guardSingleTabWrite(tabCount: number): void {
  if (tabCount > 1) {
    throw new Error(
      'this table is a multi-tab workbook — a whole-grid save would drop the other tabs; edit via draft ops (tabId) or send the full workbook',
    );
  }
}

/** Stats of a workbook file, or null when it is unreadable/absent. */
function statsOrNull(absPath: string): WorkbookStats | null {
  try {
    return existsSync(absPath) ? fileStats(absPath) : null;
  } catch {
    return null;
  }
}

/** The tab count a whole-doc write would actually clobber: the DRAFT's when
 *  one exists (registry stats only see the published file — a tab added by
 *  an import/draft op is invisible there; audit: a bare PUT could silently
 *  destroy draft-only tabs), else the published count from the locked row. */
function effectiveTabCount(
  locked: { tabCount: number | null } | null,
  storagePath: string | null,
): number {
  if (storagePath) {
    const draftStats = statsOrNull(draftAbsFor(storagePath));
    if (draftStats) return draftStats.tabs.length;
  }
  return locked?.tabCount ?? 1;
}

/** First tab's display name in draft-then-published order — bare-doc rebuilds
 *  must keep it (audit: the whole-doc fallback renamed "Inventory" back to
 *  'Sheet1', flipping the shape hash and forcing a re-summarize). */
function effectiveTabName(storagePath: string | null): string {
  if (storagePath) {
    const name =
      statsOrNull(draftAbsFor(storagePath))?.tabs[0]?.name ??
      statsOrNull(resolveStoragePath(storagePath))?.tabs[0]?.name;
    if (name) return name;
  }
  return TAB_NAME;
}

export type SaveTableDraftResult =
  | { ok: true; draftRev: number }
  | { ok: false; conflict: true; currentRev: number };

/** Autosave the working grid to the DRAFT only — published `data`,
 *  `data_text`, summary, embedding, and the extractor are all untouched. Cheap
 *  and frequent. Returns null if the table doesn't exist. Accepts a bare doc
 *  (single-tab tables) or a full WorkbookDoc (tab-aware callers / import).
 *  `ifRev` is the same etag the op route uses — a stale value conflicts
 *  instead of clobbering newer edits. `replace` marks a deliberate
 *  whole-workbook replacement (import): the payload is a complete new table
 *  parsed from a file, so the clipped-grid truncation guard doesn't apply and
 *  the payload cap is the import ceiling, not the grid window. */
export async function saveTableDraft(
  ownerId: string,
  id: string,
  data: TableDoc | WorkbookDoc,
  opts: { ifRev?: number; replace?: boolean } = {},
): Promise<SaveTableDraftResult | null> {
  const [row] = await db
    .select({ id: nodes.id, title: nodes.title })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!row) return null;
  const workbook = isWorkbook(data) ? ensureWorkbookDoc(data) : null;
  const doc = workbook ? null : ensureTableDoc(data as TableDoc);
  const totalRows = workbook
    ? workbook.tabs.reduce((a, t) => a + t.rows.length, 0)
    : doc!.rows.length;
  const payloadCap = opts.replace ? importMaxRows() : MATERIALIZE_MAX;
  if (totalRows > payloadCap) throw new TableTooLargeError(totalRows, payloadCap);
  // Registry lock spine: the draft-file rebuild and the registry update are
  // one locked step, so a concurrent agent op / second process can't
  // interleave mid-write. Storage is decided from the LOCKED row, not a
  // pre-lock read — racing the migration sweep with a stale null path wrote
  // the draft to JSONB only, invisible to every file-backed read surface
  // (audit finding 4). draft_rev bumps on every batch (the op route's etag).
  return await withTableRegistryLock(id, async (tx, locked) => {
    const currentRev = locked?.draftRev ?? 0;
    if (opts.ifRev !== undefined && currentRev !== opts.ifRev) {
      return { ok: false as const, conflict: true as const, currentRev };
    }
    let storagePath = locked?.storagePath ?? null;
    if (!storagePath && workbook) {
      // A workbook draft has no JSONB mirror — the file is its ONLY carrier,
      // so a legacy table converts to file-backed before the draft lands.
      storagePath = (await ensureFileBacked(tx, { id, ownerId, title: row.title }, locked))
        .storagePath;
    }
    if (storagePath) {
      if (!opts.replace) {
        // Whole-doc writes are only legal while the table itself fits the
        // window — a windowed doc saved whole would truncate the table (audit
        // finding 5: an exactly-10k clipped doc slipped the row-count guard).
        // Guard against the LARGEST doc this write would clobber: the draft
        // can have grown past the published stats via op batches.
        const effRows = Math.max(
          locked?.totalRows ?? 0,
          statsOrNull(draftAbsFor(storagePath))?.totalRows ?? 0,
        );
        if (effRows > MATERIALIZE_MAX) throw new TableTooLargeError(effRows, MATERIALIZE_MAX);
      }
      if (!workbook) guardSingleTabWrite(effectiveTabCount(locked, storagePath));
      writeDocFile(draftAbsFor(storagePath), workbook ?? doc!, {
        nodeId: id,
        ownerId,
        tabName: workbook ? TAB_NAME : effectiveTabName(storagePath),
      });
    }
    await tx
      .update(tables)
      .set({
        // JSONB draft mirror carries single-tab docs only (the legacy
        // rollback lever can't represent tabs — v2.1 plan decision 2).
        draftData: workbook ? null : doc,
        draftUpdatedAt: new Date(),
        draftRev: sql`${tables.draftRev} + 1`,
      })
      .where(eq(tables.nodeId, id));
    return { ok: true as const, draftRev: currentRev + 1 };
  });
}

/** Throw away the working draft. Published grid + index untouched. */
export async function discardTableDraft(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!row) return false;
  await withTableRegistryLock(id, async (tx, locked) => {
    if (locked?.storagePath) removeTableFile(draftAbsFor(locked.storagePath));
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
  data?: TableDoc | WorkbookDoc,
): Promise<TableDetail | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!node) return null;

  // ── Promote path (P3): no doc posted — publish the SERVER draft file. ──
  // The op route is the writer; commit is: lock → checkpoint → atomic rename
  // draft→published → rebuild FTS → re-derive stats/shape/dataText from the
  // file. This is the only commit shape that works past the materialize
  // window (there is no whole doc to post).
  if (data === undefined) {
    const result = await withTableRegistryLock(id, async (tx, locked) => {
      if (!locked?.storagePath) {
        // Legacy JSONB table: its draft (if any) lives in draftData — fall
        // through to the doc path semantics via the mirror.
        const [p] = await tx
          .select({ draft: tables.draftData })
          .from(tables)
          .where(eq(tables.nodeId, id))
          .limit(1);
        if (p?.draft == null) return 'no_draft' as const;
        return { legacyDraft: ensureTableDoc(p.draft) };
      }
      const publishedAbs = resolveStoragePath(locked.storagePath);
      const draftAbs = draftPathFor(publishedAbs);
      if (!existsSync(draftAbs)) return 'no_draft' as const;

      // Promote via VACUUM INTO, not a bare rename (audit findings 1+2):
      // the snapshot reads THROUGH the draft's WAL, so frames a concurrent
      // reader kept un-checkpointed are captured (a checkpoint's status is
      // advisory and a rename moves only the main file — the old path could
      // silently drop the newest ops). And the published file is REPLACED
      // atomically, never deleted first — a crash at any step leaves either
      // the old published file or the new one, both complete.
      const promoteTmp = `${publishedAbs}.promote-${randomUUID().slice(0, 8)}`;
      try {
        snapshotFile(draftAbs, promoteTmp);
        // Sweep the OLD published file's sidecars BEFORE the swap: SQLite
        // does NOT salt-match a WAL to its database file, so a leftover -wal
        // (checkpoint blocked by a concurrent reader) would be recovered
        // into the NEW file on the next write open — silent corruption of
        // committed data. We hold the registry lock; no writer races this.
        rmSync(`${publishedAbs}-wal`, { force: true });
        rmSync(`${publishedAbs}-shm`, { force: true });
        renameSync(promoteTmp, publishedAbs);
      } finally {
        removeTableFile(promoteTmp);
      }
      removeTableFile(draftAbs);
      finalizePublishedFile(publishedAbs);

      const newShapeHash = shapeHashOfFile(publishedAbs);
      const newData = { ...((node.data ?? {}) as Record<string, unknown>) };
      const shapeUnchanged =
        locked.shapeHash != null &&
        locked.shapeHash === newShapeHash &&
        typeof newData.summary === 'string';
      if (!shapeUnchanged) {
        delete newData.summary;
        delete newData.summary_model;
        delete newData.summary_at;
        delete newData.entities;
      }
      delete newData.extract_completed_at;

      const [row] = await tx
        .update(nodes)
        .set({ data: newData, embedding: null, updatedAt: new Date() })
        .where(eq(nodes.id, id))
        .returning();
      if (!row) throw new Error('commitTable: update returned no row');

      const clipped = readDocClipped(publishedAbs, MATERIALIZE_MAX);
      const stats = fileStats(publishedAbs);
      // JSONB mirror: single-tab, in-window docs only (the rollback lever
      // can't represent tabs — v2.1 plan decision 2).
      const mirror = clipped.clipped || stats.tabs.length > 1 ? {} : ensureTableDoc(clipped.doc);
      await tx
        .update(tables)
        .set({
          data: mirror,
          dataText: buildTableDataText(publishedAbs, null, node.title),
          draftData: null,
          draftUpdatedAt: null,
          draftRev: sql`${tables.draftRev} + 1`,
          version: sql`${tables.version} + 1`,
          updatedAt: new Date(),
          ...registryFileColumns(
            { sizeBytes: statSync(publishedAbs).size, stats, shapeHash: newShapeHash },
            locked.storagePath,
          ),
        })
        .where(eq(tables.nodeId, id));
      return detailOf(row, ensureTableDoc(clipped.doc), null, {
        totalRows: clipped.total,
        docClipped: clipped.clipped,
      });
    });
    if (result === 'no_draft') {
      return Promise.reject(new Error('no draft to commit — the table is already published'));
    }
    if (result && typeof result === 'object' && 'legacyDraft' in result) {
      return commitTable(ownerId, id, result.legacyDraft);
    }
    if (result) await notifyNodeIngested(id);
    return result ?? null;
  }

  const workbook = isWorkbook(data) ? ensureWorkbookDoc(data) : null;
  const doc = workbook ? null : ensureTableDoc(data as TableDoc);
  const commitDoc: TableDoc | WorkbookDoc = workbook ?? doc!;
  const commitTotalRows = workbook
    ? workbook.tabs.reduce((a, t) => a + t.rows.length, 0)
    : doc!.rows.length;
  if (commitTotalRows > MATERIALIZE_MAX)
    throw new TableTooLargeError(commitTotalRows, MATERIALIZE_MAX);

  // Commit under the registry lock (plan §3.3): write the new published file
  // (build + FTS shadows + checkpoint + atomic rename inside writeDocFile),
  // drop the draft file, then bump version/stats — one serialized step. A
  // legacy JSONB table converts to file-backed here (commit has the full doc
  // in hand, and the lock is the same one migration takes, so the two can
  // never fork).
  const publishedAbs = publishedPath(ownerId, id);
  const result = await withTableRegistryLock(id, async (tx, locked) => {
    // Shape-hash gate (plan §6): cell-only edits keep the existing summary/
    // entities — the extractor sees them and skips its LLM pass, refreshing
    // only the cheap deterministic layers (profile chunks, embedding).
    // Schema changes (or a first commit) clear them → full re-summarize.
    // extract_completed_at is always cleared: SOME re-index always runs.
    // Bare docs keep the file's existing tab name (a whole-doc commit is not
    // a rename — 'Sheet1' here flipped the shape hash and re-summarized).
    const tabName = workbook ? TAB_NAME : effectiveTabName(locked?.storagePath ?? null);
    const newShapeHash = shapeHashOf(commitDoc, tabName);
    const newData = { ...((node.data ?? {}) as Record<string, unknown>) };
    const shapeUnchanged =
      locked?.shapeHash != null &&
      locked.shapeHash === newShapeHash &&
      typeof newData.summary === 'string';
    if (!shapeUnchanged) {
      delete newData.summary;
      delete newData.summary_model;
      delete newData.summary_at;
      delete newData.entities;
    }
    delete newData.extract_completed_at;

    // A bare single-tab doc must not clobber a multi-tab workbook (the
    // whole-grid UI path pre-P5); workbook payloads replace everything by
    // design (import).
    if (!workbook) guardSingleTabWrite(effectiveTabCount(locked, locked?.storagePath ?? null));
    const [row] = await tx
      .update(nodes)
      .set({ data: newData, embedding: null, updatedAt: new Date() })
      .where(eq(nodes.id, id))
      .returning();
    if (!row) throw new Error('commitTable: update returned no row');
    const res = writeDocFile(publishedAbs, commitDoc, { nodeId: id, ownerId, tabName, fts: true });
    removeTableFile(draftAbsFor(relativeStoragePath(ownerId, id)));
    await tx
      .update(tables)
      .set({
        // JSONB mirror: single-tab docs only (v2.1 plan decision 2).
        data: workbook ? {} : doc!,
        dataText: buildTableDataText(publishedAbs, doc, node.title),
        draftData: null,
        draftUpdatedAt: null,
        draftRev: sql`${tables.draftRev} + 1`,
        version: sql`${tables.version} + 1`,
        updatedAt: new Date(),
        ...registryFileColumns(res, relativeStoragePath(ownerId, id)),
      })
      .where(eq(tables.nodeId, id));
    return detailOf(row, workbook ? ensureTableDoc(workbook.tabs[0]) : doc!, null, {
      totalRows: commitTotalRows,
    });
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
