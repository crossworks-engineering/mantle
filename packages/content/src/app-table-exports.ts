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
 * Apps clients wrote (client tier audit 2026-09-30, I2): a Table exported
 * from an app a client login has written (`client_written_at`) is indexed at
 * RETRIEVAL depth only (`nodes.data.brain_depth`: summary, embedding and
 * chunks, never entities, relations or facts), so client text never becomes
 * graph facts the owner's assistant trusts. Clients run no apps since
 * workspaces W5c (the client portal went), so no new client write lands;
 * the rows they wrote before keep the mark.
 *
 * Durable (apps first-class plan D8): the debounce timer lives in one
 * process's memory, so every write also stamps the app's exports
 * (`dirty_since` the burst's first, `last_write_at` this one), and the sync
 * that reads the rows clears the mark unless a write came after its read. A
 * restart in between no longer loses the sync: the web process resumes the
 * dirty ones at boot (`resumeDirtyAppTableExports`), and the
 * `app-export-catch-up` maintenance task syncs any still dirty
 * (`syncDirtyAppTableExports`). Same hash-gated sync, so no extra commits.
 * The task is not on the nightly cron: a commit re-indexes the Table (the
 * extractor), and the cron runs free tasks only.
 *
 * Server-only (opens the app SQLite via app-broker) — imported as
 * `@mantle/content/app-table-exports`, never from the content index.
 */
import { createHash } from 'node:crypto';
import { and, eq, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  db,
  nodes,
  appDatabases,
  appTableExports,
  runAsSystem,
  type AppTableExport,
} from '@mantle/db';
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

/** Whether a client login has written this app's database
 *  (`client_written_at`, audit I3). Clients run no apps since workspaces W5c;
 *  an app a client wrote before keeps its rows, and so the mark. */
async function clientAppState(
  ownerId: string,
  appNodeId: string,
): Promise<{ clientWritten: boolean }> {
  const [row] = await db
    .select({ clientWrittenAt: appDatabases.clientWrittenAt })
    .from(nodes)
    .leftJoin(appDatabases, eq(appDatabases.appNodeId, nodes.id))
    .where(and(eq(nodes.id, appNodeId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  return { clientWritten: !!row?.clientWrittenAt };
}

/** Mark a Table that holds rows clients wrote as client-sourced for good
 *  (`client_sourced_nodes`, audit I3): the mark then outlives the export
 *  link and the app, as the rows do. By its definer
 *  (mantle_mark_export_client_sourced, 0293: only when a client wrote the
 *  app `appNodeId`; A6b: on the system pool before, 'client-sourced-mark');
 *  best-effort, like the other marks (the link check in client-sourced.ts
 *  still holds while the link exists). */
async function markExportClientSourced(
  ownerId: string,
  appNodeId: string,
  tableNodeId: string,
): Promise<void> {
  try {
    await db.execute(
      sql`select "public"."mantle_mark_export_client_sourced"(${ownerId}::uuid,
                   ${appNodeId}::uuid, ${tableNodeId}::uuid)`,
    );
  } catch (err) {
    console.warn('[app-table-exports] could not mark the export table:', errorMessage(err));
  }
}

/** Keep the Table's index depth in step with its app (audit I2): retrieval
 *  only while clients write the app, the full pipeline otherwise. Set before
 *  the commit that notifies the extractor. */
async function stampExportDepth(tableNodeId: string, retrieval: boolean): Promise<void> {
  const [n] = await db
    .select({ data: nodes.data })
    .from(nodes)
    .where(eq(nodes.id, tableNodeId))
    .limit(1);
  if (!n) return;
  const d = { ...((n.data ?? {}) as Record<string, unknown>) };
  if (retrieval === (d.brain_depth === 'retrieval')) return;
  if (retrieval) d.brain_depth = 'retrieval';
  else delete d.brain_depth;
  await db.update(nodes).set({ data: d }).where(eq(nodes.id, tableNodeId));
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
  // A write after this moment stamps dirty_since later, and stays dirty.
  const readAt = new Date();
  try {
    const grid = await readAppTableGrid(link.ownerId, link.appNodeId, link.sqliteTable);
    if (grid.hash === link.contentHash) {
      await clearDirty(link.id, readAt);
      return 'unchanged';
    }
    const { clientWritten } = await clientAppState(link.ownerId, link.appNodeId);
    await stampExportDepth(link.tableNodeId, clientWritten);
    if (clientWritten)
      await markExportClientSourced(link.ownerId, link.appNodeId, link.tableNodeId);
    const doc = tableDocFromGrid({ columns: grid.columns, rows: grid.rows });
    const saved = await saveTableDraft(
      link.ownerId,
      link.tableNodeId,
      { tabs: [{ ...doc, name: link.sqliteTable }] },
      { replace: true, appSync: true },
    );
    if (!saved) throw new Error('linked table no longer exists');
    await commitTable(link.ownerId, link.tableNodeId, undefined, { appSync: true });
    // The sync's record and the dirty clear in ONE statement: a reader never
    // sees a synced link still marked dirty by this sync's own write (the
    // F9 test read that gap under load, pre-check removal fix round A).
    await db
      .update(appTableExports)
      .set({
        contentHash: grid.hash,
        lastSyncedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
        dirtySince: dirtyAfterRead(readAt),
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

/** The sync read the rows as of `readAt`: clear the dirty mark unless a
 *  write came after that (apps audit 2026-10-02, item 7: `dirtySince` keeps
 *  a burst's FIRST write, so a write during the sync was cleared with it). */
async function clearDirty(linkId: string, readAt: Date): Promise<void> {
  await db
    .update(appTableExports)
    .set({ dirtySince: null })
    .where(
      and(
        eq(appTableExports.id, linkId),
        or(isNull(appTableExports.lastWriteAt), lte(appTableExports.lastWriteAt, readAt)),
      ),
    );
}

/** The dirty mark once a sync read the rows as of `readAt`: cleared, unless
 *  a write came after that read (clearDirty's rule, as a column value). */
function dirtyAfterRead(readAt: Date) {
  return sql`case when ${appTableExports.lastWriteAt} is null
                    or ${appTableExports.lastWriteAt} <= ${readAt.toISOString()}::timestamptz
                  then null else ${appTableExports.dirtySince} end`;
}

/** Who the export bookkeeping runs as: the dirty stamp and the debounced
 *  sync are the brain's own work, never the writer's (A8 matrix F9). A
 *  contact share's request runs as contact:rw, which writes its app's data
 *  only (migration 0294); a timer would otherwise carry the request's actor
 *  to the sync's Table writes 15 s later. */
const EXPORT_ACTOR = 'app-export';

/** Stamp an app's exports with a write: dirty since the burst's first
 *  write, and the time of this one. EVERY write stamps (one indexed update;
 *  no exports, no rows): a write in another process, or one that lands
 *  while a sync runs, must outlive the sync's clear. Best effort: the timer
 *  still runs if this fails. */
function markExportsDirty(ownerId: string, appNodeId: string): void {
  try {
    void runAsSystem(EXPORT_ACTOR, () =>
      db
        .update(appTableExports)
        .set({
          dirtySince: sql`coalesce(${appTableExports.dirtySince}, now())`,
          lastWriteAt: sql`now()`,
        })
        .where(and(eq(appTableExports.ownerId, ownerId), eq(appTableExports.appNodeId, appNodeId))),
    ).catch((err: unknown) =>
      console.error('[app-table-exports] could not mark exports dirty', appNodeId, err),
    );
  } catch (err) {
    console.error('[app-table-exports] could not mark exports dirty', appNodeId, err);
  }
}

/** The apps with an export still dirty since before `before`. */
async function dirtyApps(before: Date): Promise<{ ownerId: string; appNodeId: string }[]> {
  const rows = await db
    .selectDistinct({ ownerId: appTableExports.ownerId, appNodeId: appTableExports.appNodeId })
    .from(appTableExports)
    .where(and(isNotNull(appTableExports.dirtySince), lt(appTableExports.dirtySince, before)));
  return rows;
}

/** At boot (web): schedule the sync of every app a restart left dirty, through
 *  the usual debounce. */
export async function resumeDirtyAppTableExports(): Promise<number> {
  const apps = await dirtyApps(new Date());
  for (const a of apps) scheduleAppTableExportSync(a.ownerId, a.appNodeId);
  return apps.length;
}

/** The `app-export-catch-up` maintenance task: sync now every app whose
 *  exports have been dirty longer than `olderThanMs` (a sync the timers
 *  lost). Hash-gated like every sync: unchanged rows commit nothing. */
export async function syncDirtyAppTableExports(
  opts: { olderThanMs?: number; dryRun?: boolean; now?: Date } = {},
): Promise<{ apps: number; synced: number; unchanged: number; errors: number }> {
  const before = new Date(
    (opts.now ?? new Date()).getTime() - (opts.olderThanMs ?? DIRTY_CATCH_UP_AGE_MS),
  );
  const apps = await dirtyApps(before);
  const out = { apps: apps.length, synced: 0, unchanged: 0, errors: 0 };
  if (opts.dryRun) return out;
  for (const a of apps) {
    const r = await syncAppTableExports(a.ownerId, a.appNodeId);
    out.synced += r.synced;
    out.unchanged += r.unchanged;
    out.errors += r.errors;
  }
  return out;
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
  const { clientWritten } = await clientAppState(ownerId, appNodeId);
  const detail = await createTable(ownerId, {
    ...(clientWritten ? { brainDepth: 'retrieval' as const } : {}),
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
  if (clientWritten) await markExportClientSourced(ownerId, appNodeId, detail.id);
  return { export: infoOf(link), tableId: detail.id, rows: grid.rows.length, created: true };
}

/** Dissolve a link. The Table survives as an ordinary editable table (its
 *  data is the last materialized state); returns false when no link exists.
 *  When clients wrote the app, the Table keeps the client-sourced mark
 *  (audit I3): the rows they wrote are still in it. */
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
  const { clientWritten } = await clientAppState(ownerId, appNodeId);
  if (clientWritten) await markExportClientSourced(ownerId, appNodeId, link.tableNodeId);
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
/** A steady stream of writes (members using a team app all day) must not
 *  postpone the sync forever: it runs at most this long after the first
 *  write of a burst. */
const SYNC_MAX_WAIT_MS = 120_000;
/** The catch-up task syncs an app whose exports have been dirty this long:
 *  well past any debounce, so it never races a sync still on its timer. */
const DIRTY_CATCH_UP_AGE_MS = 20 * 60_000;
const pending = new Map<string, { timer: NodeJS.Timeout; firstAt: number }>();

/** How long to wait before the sync, for a write at `now` in a burst whose
 *  first write was at `firstAt`: the debounce, cut short by the max wait. */
export function exportSyncDelay(firstAt: number, now: number): number {
  return Math.max(0, Math.min(SYNC_DEBOUNCE_MS, firstAt + SYNC_MAX_WAIT_MS - now));
}

export function scheduleAppTableExportSync(ownerId: string, appNodeId: string): void {
  const key = `${ownerId}:${appNodeId}`;
  const existing = pending.get(key);
  markExportsDirty(ownerId, appNodeId);
  if (existing) clearTimeout(existing.timer);
  const firstAt = existing?.firstAt ?? Date.now();
  const wait = exportSyncDelay(firstAt, Date.now());
  // The timer runs as system(app-export), whoever scheduled it (F9).
  const timer = setTimeout(
    () => void runAsSystem(EXPORT_ACTOR, () => runScheduledSync(ownerId, appNodeId, key)),
    wait,
  );
  // Never hold a process open for a pending sync (dev servers, tests, CLIs).
  timer.unref?.();
  pending.set(key, { timer, firstAt });
}

/** The debounced sync, once due. */
async function runScheduledSync(ownerId: string, appNodeId: string, key: string): Promise<void> {
  try {
    pending.delete(key);
    await syncAppTableExports(ownerId, appNodeId);
  } catch (err) {
    pending.delete(key);
    console.error('[app-table-exports] sync failed', appNodeId, err);
  }
}
