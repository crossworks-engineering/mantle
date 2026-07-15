import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { storeCell, loadCell, sqlTypeFor } from './cells';
import type { AggregateKind, Column, ColumnType, Row, TableDocLike, View } from './doc-types';
import { dedupe, physicalName, quoteIdent, viewLabel, viewNameForTab } from './names';
import { openTableFile, sqlQuote, type SqliteDb } from './sqlite';

/**
 * Workbook-file engine (Tables v2 P1). The file IS the workbook: one Table
 * node = one sqlite file = N logical tabs (P1 writes a single tab; multi-tab
 * arrives with un-split imports in P3, on this same layout).
 *
 * In-file schema (engine-managed; agents/users never run DDL):
 *   _meta                k/v: schema_version, engine_version, node_id, owner_id
 *   _tabs                tab_id, name, position, physical_table, view_name
 *   _columns             tab_id, col_id, name, type, format/options/formula
 *                        JSON, width, position, physical (stable-id column name)
 *   _views, _aggregates  saved views + footer aggregates (JSON payloads)
 *   t_<tabid>            _rid TEXT PK, _pos REAL (explicit row order), c_<colid>…
 *   <TabName> (SQL VIEW) display-named projection over the physical table —
 *                        formula columns omitted in P1 (translation is P2)
 *
 * All writes here are whole-file builds: build into a temp sibling, checkpoint,
 * close, atomically rename over the destination. Incremental op application
 * lands in P3 (draft-ops); P1's autosave rebuild measures 23ms at 10k rows.
 */

export const ENGINE_VERSION = 1;
export const SCHEMA_VERSION = 1;

/** Largest tab the doc materializer will load whole (UI/back-compat bridge). */
export const MATERIALIZE_MAX = 10_000;

/** Import safety ceiling (signed off 2026-07-15: EXPLICIT error, no auto-raise,
 *  never a silent partial import). Env-tunable per box. */
export function importMaxRows(): number {
  const raw = Number(process.env.TABLE_IMPORT_MAX_ROWS ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2_000_000;
}

export class TableTooLargeError extends Error {
  constructor(
    public readonly rowCount: number,
    public readonly limit: number,
    what = 'materialize',
  ) {
    super(
      what === 'import'
        ? `import exceeds the ${limit.toLocaleString()}-row table ceiling (${rowCount.toLocaleString()} rows). ` +
          `Import it as a file instead, or raise TABLE_IMPORT_MAX_ROWS on this box. Nothing was imported.`
        : `table too large to load whole (${rowCount.toLocaleString()} rows > ${limit.toLocaleString()}). ` +
          `Use windowed reads.`,
    );
    this.name = 'TableTooLargeError';
  }
}

export type TabStats = { tabId: string; name: string; rows: number; columns: number };
export type WorkbookStats = { tabs: TabStats[]; totalRows: number };

export type WriteResult = {
  sizeBytes: number;
  stats: WorkbookStats;
  shapeHash: string;
};

export type WriteDocMeta = {
  nodeId: string;
  ownerId: string;
  /** Display name for the single P1 tab (defaults to 'Sheet1'). */
  tabName?: string;
};

/** Structure fingerprint gating the LLM re-summarize pass (plan §6): tab names
 *  + column (name, type) sequence + BUCKETED rowcount — cell edits never
 *  change it; schema edits and order-of-magnitude growth do. */
export function shapeHashOf(doc: TableDocLike, tabName = 'Sheet1'): string {
  const bucket = (n: number): string => {
    if (n === 0) return '0';
    const mag = 10 ** Math.floor(Math.log10(n));
    return String(mag);
  };
  const h = createHash('sha256');
  h.update(
    JSON.stringify({
      tabs: [tabName],
      columns: doc.columns.map((c) => [c.name, c.type]),
      rows: bucket(doc.rows.length),
    }),
  );
  return h.digest('hex').slice(0, 32);
}

type ColumnPlan = { col: Column; physical: string; label: string };

function planColumns(columns: Column[]): ColumnPlan[] {
  const physicals = dedupe(columns.map((c) => physicalName('c', c.id)));
  const labels = dedupe(columns.map((c) => viewLabel(c.name)));
  return columns.map((col, i) => ({ col, physical: physicals[i]!, label: labels[i]! }));
}

function createSchema(db: SqliteDb, meta: WriteDocMeta): void {
  db.exec(`CREATE TABLE _meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
  db.exec(`CREATE TABLE _tabs (
    tab_id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL,
    physical_table TEXT NOT NULL, view_name TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE _columns (
    tab_id TEXT NOT NULL, col_id TEXT NOT NULL, physical TEXT NOT NULL,
    name TEXT NOT NULL, type TEXT NOT NULL,
    format_json TEXT, options_json TEXT, formula_src TEXT, width INTEGER,
    position INTEGER NOT NULL,
    PRIMARY KEY (tab_id, col_id)
  )`);
  db.exec(`CREATE TABLE _views (
    view_id TEXT PRIMARY KEY, tab_id TEXT NOT NULL, name TEXT NOT NULL,
    spec_json TEXT NOT NULL, position INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE _aggregates (
    tab_id TEXT NOT NULL, col_id TEXT NOT NULL, kind TEXT NOT NULL,
    PRIMARY KEY (tab_id, col_id)
  )`);
  const putMeta = db.prepare(`INSERT INTO _meta (k, v) VALUES (?, ?)`);
  putMeta.run('schema_version', String(SCHEMA_VERSION));
  putMeta.run('engine_version', String(ENGINE_VERSION));
  putMeta.run('node_id', meta.nodeId);
  putMeta.run('owner_id', meta.ownerId);
}

function createTab(
  db: SqliteDb,
  tabId: string,
  tabName: string,
  plans: ColumnPlan[],
): { physicalTable: string; viewName: string } {
  const physicalTable = physicalName('t', tabId);
  const viewName = viewNameForTab(tabName);
  db.prepare(`INSERT INTO _tabs (tab_id, name, position, physical_table, view_name) VALUES (?, ?, 0, ?, ?)`).run(
    tabId,
    tabName,
    physicalTable,
    viewName,
  );
  const insCol = db.prepare(
    `INSERT INTO _columns (tab_id, col_id, physical, name, type, format_json, options_json, formula_src, width, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  plans.forEach(({ col, physical }, i) => {
    insCol.run(
      tabId,
      col.id,
      physical,
      col.name,
      col.type,
      col.format ? JSON.stringify(col.format) : null,
      col.options ? JSON.stringify(col.options) : null,
      col.formula ?? null,
      col.width ?? null,
      i,
    );
  });

  // Data table: stable-id columns; formula columns have no storage.
  const stored = plans.filter((p) => p.col.type !== 'formula');
  const colDefs = stored.map((p) => `${p.physical} ${sqlTypeFor(p.col.type)}`);
  db.exec(
    `CREATE TABLE ${physicalTable} (_rid TEXT PRIMARY KEY, _pos REAL NOT NULL${colDefs.length ? ', ' + colDefs.join(', ') : ''})`,
  );
  db.exec(`CREATE INDEX ${physicalTable}_pos ON ${physicalTable}(_pos)`);
  // Auto-indexes for range-y types (plan §3.2).
  for (const p of stored) {
    if (['date', 'datetime', 'number', 'currency', 'percent', 'select'].includes(p.col.type)) {
      db.exec(`CREATE INDEX ${physicalTable}_${p.physical} ON ${physicalTable}(${p.physical})`);
    }
  }

  // Display-named SQL view. Formula columns are omitted in P1 (SQL translation
  // is P2 work); table_get will surface the mapping + omissions.
  const projections = stored.map((p) => `${p.physical} AS ${quoteIdent(p.label)}`);
  db.exec(
    `CREATE VIEW ${quoteIdent(viewName)} AS SELECT _rid, _pos${projections.length ? ', ' + projections.join(', ') : ''} FROM ${physicalTable}`,
  );
  return { physicalTable, viewName };
}

function insertRows(db: SqliteDb, physicalTable: string, plans: ColumnPlan[], rows: Row[]): void {
  const stored = plans.filter((p) => p.col.type !== 'formula');
  const cols = stored.map((p) => p.physical);
  const ins = db.prepare(
    `INSERT INTO ${physicalTable} (_rid, _pos${cols.length ? ', ' + cols.join(', ') : ''})
     VALUES (?, ?${', ?'.repeat(cols.length)})`,
  );
  db.exec('BEGIN');
  try {
    rows.forEach((row, i) => {
      const values = stored.map((p) => storeCell(row.cells[p.col.id] ?? null, p.col.type));
      ins.run(row.id, i + 1, ...values);
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function writeViewsAndAggregates(db: SqliteDb, tabId: string, doc: TableDocLike): void {
  const insView = db.prepare(`INSERT INTO _views (view_id, tab_id, name, spec_json, position) VALUES (?, ?, ?, ?, ?)`);
  (doc.views ?? []).forEach((v, i) => {
    insView.run(v.id || randomUUID(), tabId, v.name, JSON.stringify({ sort: v.sort ?? [], filters: v.filters ?? [] }), i);
  });
  const insAgg = db.prepare(`INSERT INTO _aggregates (tab_id, col_id, kind) VALUES (?, ?, ?)`);
  for (const [colId, kind] of Object.entries(doc.aggregates ?? {})) {
    if (kind && kind !== 'none') insAgg.run(tabId, colId, kind);
  }
}

/**
 * Write a complete workbook file from a doc — build into a temp sibling,
 * checkpoint, close, atomic rename over `destAbs`. Used by create, import,
 * draft rebuild (P1 autosave), commit promotion, and lazy migration.
 */
export function writeDocFile(destAbs: string, doc: TableDocLike, meta: WriteDocMeta): WriteResult {
  mkdirSync(path.dirname(destAbs), { recursive: true });
  const build = `${destAbs}.build-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    const db = openTableFile(build, { mustExist: false });
    try {
      const tabId = 't1';
      const tabName = meta.tabName ?? 'Sheet1';
      createSchema(db, meta);
      const plans = planColumns(doc.columns);
      const { physicalTable } = createTab(db, tabId, tabName, plans);
      insertRows(db, physicalTable, plans, doc.rows);
      writeViewsAndAggregates(db, tabId, doc);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    renameSync(build, destAbs);
  } finally {
    rmSync(build, { force: true });
    rmSync(`${build}-wal`, { force: true });
    rmSync(`${build}-shm`, { force: true });
  }
  const tabStats: TabStats = {
    tabId: 't1',
    name: meta.tabName ?? 'Sheet1',
    rows: doc.rows.length,
    columns: doc.columns.length,
  };
  return {
    sizeBytes: statSync(destAbs).size,
    stats: { tabs: [tabStats], totalRows: doc.rows.length },
    shapeHash: shapeHashOf(doc, tabStats.name),
  };
}

type TabRow = { tab_id: string; name: string; physical_table: string };

function readColumns(db: SqliteDb, tabId: string): { columns: Column[]; physicals: Map<string, string> } {
  const rows = db
    .prepare(`SELECT col_id, physical, name, type, format_json, options_json, formula_src, width FROM _columns WHERE tab_id = ? ORDER BY position`)
    .all(tabId);
  const physicals = new Map<string, string>();
  const columns = rows.map((r) => {
    const col: Column = {
      id: String(r.col_id),
      name: String(r.name),
      type: String(r.type) as ColumnType,
    };
    if (r.format_json != null) col.format = JSON.parse(String(r.format_json));
    if (r.options_json != null) col.options = JSON.parse(String(r.options_json));
    if (r.formula_src != null) col.formula = String(r.formula_src);
    if (r.width != null) col.width = Number(r.width);
    physicals.set(col.id, String(r.physical));
    return col;
  });
  return { columns, physicals };
}

/**
 * Materialize the first (P1: only) tab back into a doc — the UI/back-compat
 * bridge keeping every existing surface working on file-backed tables.
 * Draft-first callers decide WHICH file to read; this reads one file.
 * Throws TableTooLargeError past `maxRows` (default MATERIALIZE_MAX).
 */
export function readDocFile(absPath: string, opts: { maxRows?: number } = {}): TableDocLike {
  const maxRows = opts.maxRows ?? MATERIALIZE_MAX;
  const db = openTableFile(absPath, { readOnly: true });
  try {
    const tab = db.prepare(`SELECT tab_id, name, physical_table FROM _tabs ORDER BY position LIMIT 1`).get() as
      | TabRow
      | undefined;
    if (!tab) return { columns: [], rows: [], aggregates: {}, views: [] };

    const { columns, physicals } = readColumns(db, tab.tab_id);

    const countRow = db.prepare(`SELECT count(*) AS n FROM ${tab.physical_table}`).get();
    const rowCount = Number(countRow?.n ?? 0);
    if (rowCount > maxRows) throw new TableTooLargeError(rowCount, maxRows);

    const stored = columns.filter((c) => c.type !== 'formula');
    const select = stored.map((c) => physicals.get(c.id)!).join(', ');
    const raw = db
      .prepare(`SELECT _rid${select ? ', ' + select : ''} FROM ${tab.physical_table} ORDER BY _pos, _rid`)
      .all();
    const rows: Row[] = raw.map((r) => {
      const cells: Record<string, import('./doc-types').CellValue> = {};
      for (const c of stored) {
        const v = loadCell(r[physicals.get(c.id)!], c.type);
        if (v !== null) cells[c.id] = v;
      }
      return { id: String(r._rid), cells };
    });

    const aggregates: Record<string, AggregateKind> = {};
    for (const a of db.prepare(`SELECT col_id, kind FROM _aggregates WHERE tab_id = ?`).all(tab.tab_id)) {
      aggregates[String(a.col_id)] = String(a.kind) as AggregateKind;
    }
    const views: View[] = db
      .prepare(`SELECT view_id, name, spec_json FROM _views WHERE tab_id = ? ORDER BY position`)
      .all(tab.tab_id)
      .map((v) => {
        const spec = JSON.parse(String(v.spec_json)) as { sort?: View['sort']; filters?: View['filters'] };
        const view: View = { id: String(v.view_id), name: String(v.name) };
        if (spec.sort?.length) view.sort = spec.sort;
        if (spec.filters?.length) view.filters = spec.filters;
        return view;
      });

    return { columns, rows, aggregates, views };
  } finally {
    db.close();
  }
}

/** Registry-stats read: per-tab row/column counts WITHOUT loading rows. */
export function fileStats(absPath: string): WorkbookStats {
  const db = openTableFile(absPath, { readOnly: true });
  try {
    const tabs = db.prepare(`SELECT tab_id, name, physical_table FROM _tabs ORDER BY position`).all() as unknown as TabRow[];
    const out: TabStats[] = tabs.map((t) => {
      const n = Number(db.prepare(`SELECT count(*) AS n FROM ${t.physical_table}`).get()?.n ?? 0);
      const cols = Number(db.prepare(`SELECT count(*) AS n FROM _columns WHERE tab_id = ?`).get(t.tab_id)?.n ?? 0);
      return { tabId: t.tab_id, name: t.name, rows: n, columns: cols };
    });
    return { tabs: out, totalRows: out.reduce((a, t) => a + t.rows, 0) };
  } finally {
    db.close();
  }
}

/** Consistent point-in-time snapshot (backup primitive — plan §8 gate 2). */
export function snapshotFile(absPath: string, destAbs: string): void {
  mkdirSync(path.dirname(destAbs), { recursive: true });
  rmSync(destAbs, { force: true }); // VACUUM INTO refuses an existing dest
  const db = openTableFile(absPath, { readOnly: true });
  try {
    db.exec(`VACUUM INTO ${sqlQuote(destAbs)}`);
  } finally {
    db.close();
  }
}
