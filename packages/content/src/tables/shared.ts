/**
 * Tables · shared spine. The row/detail shapes, the counts that avoid
 * materializing a workbook, the app-bound write guard, and the ltree root.
 *
 * `assertTableWritable` lives here because it is the invariant every grid
 * write shares: a table linked to a mini-app is owned by the app's export
 * sync, and a direct grid edit would be silently overwritten by the next one.
 */
import { eq, sql } from 'drizzle-orm';
import {
  assertNotSnapshotCopy,
  currentSpaceScope,
  db,
  nodes,
  appTableExports,
  type Node,
  headsOrSpace,
  withDeadlockRetry,
  withNodeInsertHeads,
  isSnapshotCopy,
} from '@mantle/db';
import {
  ensureTableDoc,
  emptyTableDoc,
  type TableDoc,
  type TableRow,
  type TableDetail,
  type TableTabInfo,
} from '@mantle/content-core/table-model';
import { defineDomainError } from '@mantle/std';
import type { WorkbookStats } from '@mantle/tabledb';
import { loadDocsFromFile } from '../table-storage';
import { asKindRootRepair } from '../kind-root';

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

// The one error answer (A10 part 2, @mantle/std domain-errors.ts): 409, as
// the restore route answered it (the table is read-only here, the app is
// its master).
defineDomainError(AppBoundTableError, {
  reason: 'the table mirrors an app and is read-only here; the message says where to edit',
  status: 409,
});

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
 *  sync itself, and on a read-only snapshot copy always. Metadata edits
 *  (updateTable) don't call this (a copy's are refused by the database). */
export async function assertTableWritable(tableNodeId: string, appSync?: boolean): Promise<void> {
  if (appSync) return;
  // A read-only snapshot copy (W6b fix round 1): its grid never changes,
  // whoever asks (the draft ops write its SQLite file, which no database
  // trigger sees).
  const [own] = await db
    .select({ data: nodes.data })
    .from(nodes)
    .where(eq(nodes.id, tableNodeId))
    .limit(1);
  assertNotSnapshotCopy(own);
  await assertTableNotAppBound(tableNodeId);
}

/** Refuse a change to an app-bound table (its export link): a grid write
 *  through assertTableWritable, and a delete, which a snapshot copy's
 *  author or the owner may still make (W6b fix round 2, M-1: a copy is
 *  read only, never undeletable). */
export async function assertTableNotAppBound(tableNodeId: string): Promise<void> {
  // A personal table is never app-bound (exports are brain tables), and the
  // personal-space role holds no grant on the export registry: asking would
  // fail, and inside a space transaction even a caught failure aborts it.
  if (currentSpaceScope()) return;
  // The export registry is the system's (no workspace role reads it): asked
  // by its definer, which app a Table the scope reads exports (0293,
  // mantle_table_app_link; A6b: on the system pool before, 'export-link'),
  // so a member's own table write or delete is checked rather than failing
  // on the grant (W6b fix round 2). The app's name below is read in the
  // caller's scope.
  const [link] = (await db.execute(
    sql`select "public"."mantle_table_app_link"(${tableNodeId}::uuid)::text as "appNodeId"`,
  )) as unknown as { appNodeId: string | null }[];
  if (!link?.appNodeId) return;
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
    ...(isSnapshotCopy(n) ? { readOnly: true as const } : {}),
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

export type DocsRow = {
  storagePath: string | null;
  /** The draft the row points at (A3b); absent or null: no draft file. */
  draftPath?: string | null;
  data: unknown;
  draft: unknown;
};

/** Published + draft docs for a registry row: workbook file when file-backed
 *  (draft-first callers get both), JSONB otherwise. `tabId` picks the tab to
 *  materialize (file-backed only; default first). */
export function docsOf(
  row: DocsRow,
  tabId?: string,
  opts: { publishedOnly?: boolean } = {},
): {
  data: TableDoc;
  draft: TableDoc | null;
  totalRows: number;
  docClipped: boolean;
} {
  if (row.storagePath) {
    const loaded = loadDocsFromFile(row.storagePath, row.draftPath ?? null, {
      tabId,
      publishedOnly: opts.publishedOnly,
    });
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

/** The kind's root folder, made as system(repair:kind-root) (kind-root.ts). */
export async function ensureRoot(ownerId: string): Promise<void> {
  await asKindRootRepair(() => ensureRootNow(ownerId));
}

async function ensureRootNow(ownerId: string): Promise<void> {
  await headsOrSpace(
    (f) =>
      withDeadlockRetry(() =>
        withNodeInsertHeads(ownerId, [{ type: 'branch', path: TABLES_ROOT_LABEL }], f),
      ),
    (tx) => insertRoot(tx, ownerId),
  );
}

/** @heads-held by ensureRoot (through headsOrSpace). */
async function insertRoot(tx: Pick<typeof db, 'insert'>, ownerId: string): Promise<void> {
  await tx
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
