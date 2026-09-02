/**
 * App table exports — keep a brain Table as a DERIVED, read-only view of one
 * table inside a mini-app's own SQLite database.
 *
 * Direction of authority: the APP is the master. Team members (or the owner)
 * edit data in the app; after a write the platform re-materializes the linked
 * Table from the SQLite rows. The Table side refuses every grid edit while the
 * link exists (`assertTableWritable` in tables.ts; this module is the one
 * writer, passing `appSync`). The reverse direction — a Table mirrored INTO an
 * app — is deliberately not this module: one master per table, ever.
 *
 * Cost-safety: the sync is pure SQL (read SQLite, write the workbook file) and
 * `content_hash` skips the commit entirely when the rows didn't change, so a
 * chatty app cannot fan out into commit/extractor churn. Triggers are debounced
 * per app (`scheduleAppTableExportSync`, called by the db-broker routes and the
 * seed tool after a successful write).
 *
 * Server-only (opens the app SQLite via app-broker) — imported as
 * `@mantle/content/app-table-exports`, never from the content index.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, nodes, appTableExports, type AppTableExport } from '@mantle/db';
import { importMaxRows } from '@mantle/tabledb';
import { getApp } from './apps';
import { appDbReadQuery } from './app-broker';
import { createTable, saveTableDraft, commitTable } from './tables';
import { tableDocFromGrid, type TableAppLink } from '@mantle/content-core/table-model';
import { errorMessage } from '@mantle/std';

/** Same shape the seed path accepts: a plain identifier, never sqlite_*. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertTableIdent(name: string): void {
  if (!IDENT_RE.test(name) || name.toLowerCase().startsWith('sqlite_')) {
    throw new Error(`invalid app table name '${name}'`);
  }
}

/** Map a SQLite declared column type onto a Table column type. Order matters:
 *  BOOLEAN before INT (SQLite stores booleans as INTEGER affinity), DATETIME
 *  before DATE (the substring). Unknown/absent decltypes read as text. */
export function columnTypeOf(declType: string | null | undefined): string {
  const t = (declType ?? '').toUpperCase();
  if (t.includes('BOOL')) return 'checkbox';
  if (t.includes('DATETIME') || t.includes('TIMESTAMP')) return 'datetime';
  if (t.includes('DATE')) return 'date';
  if (
    t.includes('INT') ||
    t.includes('REAL') ||
    t.includes('FLOA') ||
    t.includes('DOUB') ||
    t.includes('NUM') ||
    t.includes('DEC')
  ) {
    return 'number';
  }
  return 'text';
}

type CellScalar = string | number | boolean | null;

type AppTableGrid = {
  columns: { name: string; type: string }[];
  rows: CellScalar[][];
  hash: string;
};

/** SQLite hands back TEXT/INTEGER/REAL/NULL (and BLOB, which has no grid
 *  representation — stringified rather than dropped so the row keeps shape). */
function scalarOf(v: unknown): CellScalar {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return v;
  }
  if (typeof v === 'bigint') return Number(v);
  return String(v);
}

/** Read one app SQLite table as a grid, capped at the import ceiling. Throws
 *  when the table doesn't exist or exceeds the ceiling — the caller records
 *  the message on the link's `last_error` instead of half-syncing. */
async function readAppTableGrid(
  ownerId: string,
  appNodeId: string,
  table: string,
): Promise<AppTableGrid> {
  assertTableIdent(table);
  const info = await appDbReadQuery(ownerId, appNodeId, `PRAGMA table_info("${table}")`);
  const cols = (info.rows as { name: string; type?: string }[]).map((c) => ({
    name: String(c.name),
    type: columnTypeOf(c.type),
  }));
  if (!cols.length) {
    throw new Error(`table '${table}' does not exist in the app's database`);
  }
  const cap = importMaxRows();
  const res = await appDbReadQuery(ownerId, appNodeId, `SELECT * FROM "${table}" LIMIT ${cap + 1}`);
  if (res.rows.length > cap) {
    throw new Error(`table '${table}' has more than ${cap} rows — too large to export`);
  }
  const rows = (res.rows as Record<string, unknown>[]).map((r) =>
    cols.map((c) => scalarOf(r[c.name])),
  );
  const hash = createHash('sha256')
    .update(JSON.stringify({ columns: cols, rows }))
    .digest('hex');
  return { columns: cols, rows, hash };
}

/** Denormalized DTO mark on the table node (`nodes.data.appLink`) — the link
 *  row stays authoritative; this is what `rowOf` surfaces to clients. */
async function stampAppLinkMark(tableNodeId: string, mark: TableAppLink | null): Promise<void> {
  const [n] = await db
    .select({ data: nodes.data })
    .from(nodes)
    .where(eq(nodes.id, tableNodeId))
    .limit(1);
  if (!n) return;
  const d = { ...((n.data ?? {}) as Record<string, unknown>) };
  if (mark) d.appLink = mark;
  else delete d.appLink;
  await db.update(nodes).set({ data: d, updatedAt: new Date() }).where(eq(nodes.id, tableNodeId));
}

export type AppTableExportInfo = {
  id: string;
  appNodeId: string;
  sqliteTable: string;
  tableNodeId: string;
  lastSyncedAt: string | null;
  lastError: string | null;
};

function infoOf(row: AppTableExport): AppTableExportInfo {
  return {
    id: row.id,
    appNodeId: row.appNodeId,
    sqliteTable: row.sqliteTable,
    tableNodeId: row.tableNodeId,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    lastError: row.lastError,
  };
}

export async function listAppTableExports(
  ownerId: string,
  appNodeId?: string,
): Promise<AppTableExportInfo[]> {
  const rows = await db
    .select()
    .from(appTableExports)
    .where(
      appNodeId
        ? and(eq(appTableExports.ownerId, ownerId), eq(appTableExports.appNodeId, appNodeId))
        : eq(appTableExports.ownerId, ownerId),
    );
  return rows.map(infoOf);
}

/** Materialize one link: read the SQLite table, skip if unchanged (hash),
 *  else replace the Table's workbook and commit. Records success or the
 *  failure message on the link row; never throws for a data problem. */
async function materialize(link: AppTableExport): Promise<'synced' | 'unchanged' | 'error'> {
  try {
    const grid = await readAppTableGrid(link.ownerId, link.appNodeId, link.sqliteTable);
    if (grid.hash === link.contentHash) return 'unchanged';
    const doc = tableDocFromGrid({ columns: grid.columns, rows: grid.rows });
    const saved = await saveTableDraft(
      link.ownerId,
      link.tableNodeId,
      { tabs: [{ ...doc, name: link.sqliteTable }] },
      { replace: true, appSync: true },
    );
    if (!saved) throw new Error('linked table no longer exists');
    await commitTable(link.ownerId, link.tableNodeId, undefined, { appSync: true });
    await db
      .update(appTableExports)
      .set({
        contentHash: grid.hash,
        lastSyncedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(appTableExports.id, link.id));
    return 'synced';
  } catch (err) {
    await db
      .update(appTableExports)
      .set({ lastError: errorMessage(err), updatedAt: new Date() })
      .where(eq(appTableExports.id, link.id));
    return 'error';
  }
}

/** Sync every export of an app now (or one table when named). */
export async function syncAppTableExports(
  ownerId: string,
  appNodeId: string,
  sqliteTable?: string,
): Promise<{ synced: number; unchanged: number; errors: number }> {
  const links = await db
    .select()
    .from(appTableExports)
    .where(
      sqliteTable
        ? and(
            eq(appTableExports.ownerId, ownerId),
            eq(appTableExports.appNodeId, appNodeId),
            eq(appTableExports.sqliteTable, sqliteTable),
          )
        : and(eq(appTableExports.ownerId, ownerId), eq(appTableExports.appNodeId, appNodeId)),
    );
  const out = { synced: 0, unchanged: 0, errors: 0 };
  for (const link of links) {
    const r = await materialize(link);
    if (r === 'synced') out.synced++;
    else if (r === 'unchanged') out.unchanged++;
    else out.errors++;
  }
  return out;
}

/**
 * Create (or refresh) an export link: builds the Table from the current SQLite
 * rows, marks it as an app table, and locks its grid against direct edits.
 * Idempotent per (app, table) — an existing link just re-syncs.
 */
export async function createAppTableExport(
  ownerId: string,
  appNodeId: string,
  sqliteTable: string,
  opts: { title?: string } = {},
): Promise<{ export: AppTableExportInfo; tableId: string; rows: number; created: boolean }> {
  assertTableIdent(sqliteTable);
  const app = await getApp(ownerId, appNodeId);
  if (!app) throw new Error('app not found');

  const [existing] = await db
    .select()
    .from(appTableExports)
    .where(
      and(
        eq(appTableExports.ownerId, ownerId),
        eq(appTableExports.appNodeId, appNodeId),
        eq(appTableExports.sqliteTable, sqliteTable),
      ),
    )
    .limit(1);
  if (existing) {
    await materialize(existing);
    const [fresh] = await db
      .select()
      .from(appTableExports)
      .where(eq(appTableExports.id, existing.id))
      .limit(1);
    const grid = await readAppTableGrid(ownerId, appNodeId, sqliteTable);
    return {
      export: infoOf(fresh ?? existing),
      tableId: existing.tableNodeId,
      rows: grid.rows.length,
      created: false,
    };
  }

  const grid = await readAppTableGrid(ownerId, appNodeId, sqliteTable);
  const doc = tableDocFromGrid({ columns: grid.columns, rows: grid.rows });
  const detail = await createTable(ownerId, {
    title: opts.title?.trim() || `${app.title} · ${sqliteTable}`,
    tabs: [{ ...doc, name: sqliteTable }],
    description:
      `App table: a read-only view of the '${sqliteTable}' table inside the ` +
      `'${app.title}' app's own database. Data changes in the app; this table ` +
      `refreshes automatically and refuses direct edits.`,
  });
  const [link] = await db
    .insert(appTableExports)
    .values({
      ownerId,
      appNodeId,
      sqliteTable,
      tableNodeId: detail.id,
      contentHash: grid.hash,
      lastSyncedAt: new Date(),
    })
    .returning();
  if (!link) throw new Error('failed to create the export link');
  await stampAppLinkMark(detail.id, { appId: appNodeId, appName: app.title, sqliteTable });
  return { export: infoOf(link), tableId: detail.id, rows: grid.rows.length, created: true };
}

/** Dissolve a link. The Table survives as an ordinary editable table (its
 *  data is the last materialized state); returns false when no link exists. */
export async function removeAppTableExport(
  ownerId: string,
  appNodeId: string,
  sqliteTable: string,
): Promise<boolean> {
  const [link] = await db
    .delete(appTableExports)
    .where(
      and(
        eq(appTableExports.ownerId, ownerId),
        eq(appTableExports.appNodeId, appNodeId),
        eq(appTableExports.sqliteTable, sqliteTable),
      ),
    )
    .returning();
  if (!link) return false;
  await stampAppLinkMark(link.tableNodeId, null);
  return true;
}

// ── Debounced trigger ────────────────────────────────────────────────────────
// Called after every successful app-db write (both db-broker routes + the seed
// tool). Trailing debounce per app: a burst of writes lands ONE sync. The
// timer is per-process; whichever process performed the write schedules the
// sync, and the SQLite file + Postgres registry are shared, so the result is
// the same from web or api.

const SYNC_DEBOUNCE_MS = 15_000;
const pending = new Map<string, NodeJS.Timeout>();

export function scheduleAppTableExportSync(ownerId: string, appNodeId: string): void {
  const key = `${ownerId}:${appNodeId}`;
  const existing = pending.get(key);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pending.delete(key);
    syncAppTableExports(ownerId, appNodeId).catch((err) => {
      console.error('[app-table-exports] sync failed', appNodeId, err);
    });
  }, SYNC_DEBOUNCE_MS);
  // Never hold a process open for a pending sync (dev servers, tests, CLIs).
  t.unref?.();
  pending.set(key, t);
}
