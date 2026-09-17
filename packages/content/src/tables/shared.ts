/**
 * Tables · shared spine. The row/detail shapes, the counts that avoid
 * materializing a workbook, the app-bound write guard, and the ltree root.
 *
 * `assertTableWritable` lives here because it is the invariant every grid
 * write shares: a table linked to a mini-app is owned by the app's export
 * sync, and a direct grid edit would be silently overwritten by the next one.
 */
import { eq, sql } from 'drizzle-orm';
import { db, nodes, appTableExports, type Node } from '@mantle/db';
import {
  ensureTableDoc,
  emptyTableDoc,
  type TableDoc,
  type TableRow,
  type TableDetail,
  type TableTabInfo,
} from '@mantle/content-core/table-model';
import type { WorkbookStats } from '@mantle/tabledb';
import { loadDocsFromFile } from '../table-storage';

export const TABLES_ROOT_LABEL = 'tables';

/** Thrown when a grid edit reaches an APP TABLE — a table linked to a mini-app
 *  as a derived export view. The app's SQLite is the master; the only writer
 *  here is the sync (which passes `appSync`). */
export class AppBoundTableError extends Error {
  constructor(appName: string | null) {
    super(
      `this is an app table — it mirrors the "${appName ?? 'linked'}" app's own database and is read-only here; edit the data in the app (the table refreshes automatically), or remove the export with app_table_export_remove`,
    );
    this.name = 'AppBoundTableError';
  }
}

/** The export link for a table, or null. Authoritative (the `nodes.data.appLink`
 *  mark is a denormalized copy for DTOs; the guard trusts only this row). */
export async function appExportLinkOf(tableNodeId: string) {
  const [row] = await db
    .select({ appNodeId: appTableExports.appNodeId, sqliteTable: appTableExports.sqliteTable })
    .from(appTableExports)
    .where(eq(appTableExports.tableNodeId, tableNodeId))
    .limit(1);
  return row ?? null;
}

/** Refuse grid mutation on an app-bound table unless the caller is the export
 *  sync itself. Metadata edits (updateTable) stay allowed and don't call this. */
export async function assertTableWritable(tableNodeId: string, appSync?: boolean): Promise<void> {
  if (appSync) return;
  const link = await appExportLinkOf(tableNodeId);
  if (!link) return;
  const [app] = await db
    .select({ title: nodes.title })
    .from(nodes)
    .where(eq(nodes.id, link.appNodeId))
    .limit(1);
  throw new AppBoundTableError(app?.title ?? null);
}

export function appLinkOf(d: Record<string, unknown>): TableRow['appLink'] {
  const l = d.appLink as Record<string, unknown> | undefined;
  if (!l || typeof l.appId !== 'string' || typeof l.sqliteTable !== 'string') return null;
  return {
    appId: l.appId,
    appName: typeof l.appName === 'string' ? l.appName : null,
    sqliteTable: l.sqliteTable,
  };
}

export function rowOf(n: Node, counts: { columnCount: number; rowCount: number }): TableRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  return {
    id: n.id,
    title: n.title,
    icon: typeof d.icon === 'string' ? d.icon : null,
    tags: n.tags ?? [],
    summary: typeof d.summary === 'string' ? d.summary : null,
    description: typeof d.description === 'string' ? d.description : null,
    visibility: d.visibility === 'public' ? 'public' : 'private',
    appLink: appLinkOf(d),
    columnCount: counts.columnCount,
    rowCount: counts.rowCount,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

export function countsOf(data: TableDoc): { columnCount: number; rowCount: number } {
  return { columnCount: data.columns.length, rowCount: data.rows.length };
}

/** Counts for the list WITHOUT materializing: registry `stats` when the table
 *  is file-backed (or backfilled), else a JSONB parse (legacy rows only —
 *  the pre-v2 behavior). */
export function countsFromRegistry(
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

export function detailOf(
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
export function tabsFromStats(stats: unknown): TableTabInfo[] | undefined {
  const s = stats as WorkbookStats | null;
  if (!s || !Array.isArray(s.tabs) || s.tabs.length === 0) return undefined;
  return s.tabs.map((t) => ({ id: t.tabId, name: t.name, rows: t.rows, columns: t.columns }));
}

export type DocsRow = { storagePath: string | null; data: unknown; draft: unknown };

/** Published + draft docs for a registry row: workbook file when file-backed
 *  (draft-first callers get both), JSONB otherwise. `tabId` picks the tab to
 *  materialize (file-backed only; default first). */
export function docsOf(
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
export const TAB_NAME = 'Sheet1';

export async function ensureRoot(ownerId: string): Promise<void> {
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

/** Normalise a tag list for storage: trimmed, lowercased, deduped, bounded. */
export function dedupeTags(tags: string[]): string[] {
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
