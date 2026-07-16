import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { storeCell, loadCell, sqlTypeFor } from './cells';
import type { AggregateKind, Column, ColumnType, RefMode, Row, TableDocLike, View, WorkbookDocLike, WorkbookTabDoc } from './doc-types';
import { storageType } from './doc-types';
import { createFtsShadow, ftsColumns, ftsTableName } from './fts';
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
export const SCHEMA_VERSION = 2;

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
  /** Display name for the tab when writing a bare TableDocLike (defaults to
   *  'Sheet1'). Ignored for WorkbookDocLike input — tabs carry their names. */
  tabName?: string;
  /** Build FTS5 trigram shadows (published writes: create/import/commit).
   *  NEVER set for draft rebuilds — ~0.5s at 10k rows vs 23ms without. */
  fts?: boolean;
};

function rowBucket(n: number): string {
  if (n === 0) return '0';
  return String(10 ** Math.floor(Math.log10(n)));
}

function hashShape(parts: { tabs: string[]; columns: [string, string][]; rows: string }): string {
  const h = createHash('sha256');
  h.update(JSON.stringify(parts));
  return h.digest('hex').slice(0, 32);
}

/** Structure fingerprint gating the LLM re-summarize pass (plan §6): tab names
 *  + column (name, type) sequence + BUCKETED rowcount — cell edits never
 *  change it; schema edits and order-of-magnitude growth do. */
export function shapeHashOf(doc: TableDocLike | WorkbookDocLike, tabName = 'Sheet1'): string {
  const tabs = asWorkbookTabs(doc, tabName);
  return hashShape({
    tabs: tabs.map((t) => t.name),
    columns: tabs.flatMap((t) => t.columns.map((c): [string, string] => [c.name, c.type])),
    rows: rowBucket(tabs.reduce((a, t) => a + t.rows.length, 0)),
  });
}

/** Normalize the write shape: a bare TableDocLike becomes a one-tab workbook
 *  (name from the caller's tabName, id 't1' — byte-identical files to pre-v2.1
 *  writes). Multi-tab docs get positional ids where absent. */
export function asWorkbookTabs(doc: TableDocLike | WorkbookDocLike, fallbackTabName = 'Sheet1'): (WorkbookTabDoc & { id: string })[] {
  const tabs: WorkbookTabDoc[] =
    'tabs' in doc ? doc.tabs : [{ ...doc, id: 't1', name: fallbackTabName }];
  if (tabs.length === 0) throw new Error('tabledb: a workbook needs at least one tab');
  const seen = new Set<string>();
  return tabs.map((t, i) => {
    let id = t.id ?? `t${i + 1}`;
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);
    return { ...t, id };
  });
}

/** Same fingerprint computed FROM a workbook file (draft-promote path, where
 *  no doc is materialized). Must agree with shapeHashOf for the same state. */
export function shapeHashOfFile(absPath: string): string {
  const db = openTableFile(absPath, { readOnly: true });
  try {
    const tabs = db.prepare(`SELECT tab_id, name, physical_table FROM _tabs ORDER BY position`).all();
    const names = tabs.map((t) => String(t.name));
    const columns: [string, string][] = [];
    let rows = 0;
    for (const t of tabs) {
      for (const c of db
        .prepare(`SELECT name, type FROM _columns WHERE tab_id = ? ORDER BY position`)
        .all(String(t.tab_id))) {
        columns.push([String(c.name), String(c.type)]);
      }
      rows += Number(db.prepare(`SELECT count(*) AS n FROM ${String(t.physical_table)}`).get()?.n ?? 0);
    }
    return hashShape({ tabs: names, columns, rows: rowBucket(rows) });
  } finally {
    db.close();
  }
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
    ref_json TEXT, ref_mode TEXT,
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
  opts: { position?: number; viewName?: string } = {},
): { physicalTable: string; viewName: string } {
  const physicalTable = physicalName('t', tabId);
  const viewName = opts.viewName ?? viewNameForTab(tabName);
  db.prepare(`INSERT INTO _tabs (tab_id, name, position, physical_table, view_name) VALUES (?, ?, ?, ?, ?)`).run(
    tabId,
    tabName,
    opts.position ?? 0,
    physicalTable,
    viewName,
  );
  const insCol = db.prepare(
    `INSERT INTO _columns (tab_id, col_id, physical, name, type, format_json, options_json, formula_src, width, position, ref_json, ref_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      col.ref ? JSON.stringify(col.ref) : null,
      col.type === 'reference' ? (col.refMode ?? 'select') : null,
    );
  });

  // Data table: stable-id columns; formula columns have no storage. A linked
  // column's SQL affinity follows its refMode (checkbox → INTEGER, else TEXT).
  const stored = plans.filter((p) => p.col.type !== 'formula');
  const colDefs = stored.map((p) => `${p.physical} ${sqlTypeFor(storageType(p.col))}`);
  db.exec(
    `CREATE TABLE ${physicalTable} (_rid TEXT PRIMARY KEY, _pos REAL NOT NULL${colDefs.length ? ', ' + colDefs.join(', ') : ''})`,
  );
  db.exec(`CREATE INDEX ${physicalTable}_pos ON ${physicalTable}(_pos)`);
  // Auto-indexes for range-y types (plan §3.2).
  for (const p of stored) {
    if (['date', 'datetime', 'number', 'currency', 'percent', 'select', 'reference'].includes(p.col.type)) {
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
      const values = stored.map((p) => storeCell(row.cells[p.col.id] ?? null, storageType(p.col)));
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
export function writeDocFile(destAbs: string, doc: TableDocLike | WorkbookDocLike, meta: WriteDocMeta): WriteResult {
  mkdirSync(path.dirname(destAbs), { recursive: true });
  const tabs = asWorkbookTabs(doc, meta.tabName ?? 'Sheet1');
  // View names are display-derived and must be unique across the whole file —
  // they share sqlite's namespace with the physical `t_*` tables and FTS
  // shadows, so a tab literally named like one suffixes instead of failing
  // the CREATE VIEW (audit: a tab named "t_t1" aborted the whole write).
  const reserved = new Set<string>();
  for (const t of tabs) {
    const physical = physicalName('t', t.id);
    reserved.add(physical.toLowerCase());
    reserved.add(ftsTableName(physical).toLowerCase());
  }
  const viewNames = dedupe(tabs.map((t) => viewNameForTab(t.name))).map((name) => {
    let out = name;
    let n = 2;
    while (reserved.has(out.toLowerCase())) out = `${name}_${n++}`;
    reserved.add(out.toLowerCase());
    return out;
  });
  const build = `${destAbs}.build-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    const db = openTableFile(build, { mustExist: false });
    try {
      createSchema(db, meta);
      tabs.forEach((tab, i) => {
        const plans = planColumns(tab.columns);
        const { physicalTable } = createTab(db, tab.id, tab.name, plans, {
          position: i,
          viewName: viewNames[i]!,
        });
        if (meta.fts) {
          // Before the bulk insert: the insert trigger populates the index in
          // the same pass.
          const wanted = new Set(ftsColumns(tab.columns).map((c) => c.id));
          createFtsShadow(db, physicalTable, plans.filter((p) => wanted.has(p.col.id)).map((p) => p.physical));
        }
        insertRows(db, physicalTable, plans, tab.rows);
        writeViewsAndAggregates(db, tab.id, tab);
      });
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    // Sweep the DESTINATION's sidecars BEFORE the rename: a stale -wal left
    // beside the old file (checkpoint is advisory — a concurrent reader can
    // block it) would otherwise be replayed into the NEW file on the next
    // write open, silently corrupting it. SQLite does not salt-match a WAL
    // to its database file. Callers hold the registry lock, so no writer
    // races this window.
    rmSync(`${destAbs}-wal`, { force: true });
    rmSync(`${destAbs}-shm`, { force: true });
    renameSync(build, destAbs);
  } finally {
    rmSync(build, { force: true });
    rmSync(`${build}-wal`, { force: true });
    rmSync(`${build}-shm`, { force: true });
  }
  const tabStats: TabStats[] = tabs.map((t) => ({
    tabId: t.id,
    name: t.name,
    rows: t.rows.length,
    columns: t.columns.length,
  }));
  return {
    sizeBytes: statSync(destAbs).size,
    stats: { tabs: tabStats, totalRows: tabStats.reduce((a, t) => a + t.rows, 0) },
    shapeHash: shapeHashOf(doc, meta.tabName ?? 'Sheet1'),
  };
}

type TabRow = { tab_id: string; name: string; physical_table: string };

function readColumns(db: SqliteDb, tabId: string): { columns: Column[]; physicals: Map<string, string> } {
  // SELECT * — pre-v2.1 files have no ref_json column; a missing field reads
  // as undefined instead of erroring the whole open.
  const rows = db
    .prepare(`SELECT * FROM _columns WHERE tab_id = ? ORDER BY position`)
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
    if (r.ref_json != null) col.ref = JSON.parse(String(r.ref_json));
    if (r.ref_mode != null) col.refMode = String(r.ref_mode) as RefMode;
    physicals.set(col.id, String(r.physical));
    return col;
  });
  return { columns, physicals };
}

export type ClippedDoc = {
  doc: TableDocLike;
  /** True row count in the file (doc.rows may be a leading window). */
  total: number;
  /** doc.rows was clipped at the window — callers page the rest via
   *  listRowsWindow / the rows route. */
  clipped: boolean;
};

/** Like readDocFile but CLIPS instead of throwing: doc.rows carries the first
 *  `maxRows` rows (0 = schema only) and `total`/`clipped` say what was left
 *  behind. The read path for tables past the materialize window. */
export function readDocClipped(absPath: string, maxRows = MATERIALIZE_MAX, tabId?: string): ClippedDoc {
  const db = openTableFile(absPath, { readOnly: true });
  try {
    const tab = resolveTabRow(db, tabId);
    if (!tab) return { doc: { columns: [], rows: [], aggregates: {}, views: [] }, total: 0, clipped: false };
    const total = Number(db.prepare(`SELECT count(*) AS n FROM ${tab.physical_table}`).get()?.n ?? 0);
    const doc = readTabDoc(db, tab, Math.min(maxRows, total));
    return { doc, total, clipped: total > maxRows };
  } finally {
    db.close();
  }
}

/** Resolve a tab by id (or the first tab by position when no id is given).
 *  Unknown ids throw — a caller naming a tab that isn't there is a bug, not
 *  a fall-back-to-first situation. */
function resolveTabRow(db: SqliteDb, tabId?: string): TabRow | undefined {
  if (tabId === undefined) {
    return db.prepare(`SELECT tab_id, name, physical_table FROM _tabs ORDER BY position LIMIT 1`).get() as
      | TabRow
      | undefined;
  }
  const tab = db.prepare(`SELECT tab_id, name, physical_table FROM _tabs WHERE tab_id = ?`).get(tabId) as
    | TabRow
    | undefined;
  if (!tab) throw new Error(`tabledb: no tab '${tabId}' in this workbook`);
  return tab;
}

/** Materialize EVERY tab back into docs (whole-workbook read — export, the
 *  multi-tab commit path). Throws TableTooLargeError when the workbook's
 *  total row count exceeds `maxRows`. */
export function readWorkbookDoc(absPath: string, opts: { maxRows?: number } = {}): WorkbookDocLike {
  const maxRows = opts.maxRows ?? MATERIALIZE_MAX;
  const db = openTableFile(absPath, { readOnly: true });
  try {
    const tabRows = db.prepare(`SELECT tab_id, name, physical_table FROM _tabs ORDER BY position`).all() as unknown as TabRow[];
    const counts = tabRows.map((t) => Number(db.prepare(`SELECT count(*) AS n FROM ${t.physical_table}`).get()?.n ?? 0));
    const total = counts.reduce((a, n) => a + n, 0);
    if (total > maxRows) throw new TableTooLargeError(total, maxRows);
    const tabs: WorkbookTabDoc[] = tabRows.map((t, i) => ({
      id: t.tab_id,
      name: t.name,
      ...readTabDoc(db, t, counts[i]!),
    }));
    return { tabs };
  } finally {
    db.close();
  }
}

function readTabDoc(db: SqliteDb, tab: TabRow, limit: number): TableDocLike {
  const { columns, physicals } = readColumns(db, tab.tab_id);
  const stored = columns.filter((c) => c.type !== 'formula');
  const select = stored.map((c) => physicals.get(c.id)!).join(', ');
  const raw =
    limit > 0
      ? db
          .prepare(`SELECT _rid${select ? ', ' + select : ''} FROM ${tab.physical_table} ORDER BY _pos, _rid LIMIT ?`)
          .all(limit)
      : [];
  const rows: Row[] = raw.map((r) => {
    const cells: Record<string, import('./doc-types').CellValue> = {};
    for (const c of stored) {
      const v = loadCell(r[physicals.get(c.id)!], storageType(c));
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
}

/**
 * Materialize one tab back into a doc (default: the first by position) — the
 * UI/back-compat bridge keeping every existing surface working on file-backed
 * tables. Draft-first callers decide WHICH file to read; this reads one file.
 * Throws TableTooLargeError past `maxRows` (default MATERIALIZE_MAX).
 */
export function readDocFile(absPath: string, opts: { maxRows?: number; tabId?: string } = {}): TableDocLike {
  const maxRows = opts.maxRows ?? MATERIALIZE_MAX;
  const db = openTableFile(absPath, { readOnly: true });
  try {
    const tab = resolveTabRow(db, opts.tabId);
    if (!tab) return { columns: [], rows: [], aggregates: {}, views: [] };

    const countRow = db.prepare(`SELECT count(*) AS n FROM ${tab.physical_table}`).get();
    const rowCount = Number(countRow?.n ?? 0);
    if (rowCount > maxRows) throw new TableTooLargeError(rowCount, maxRows);

    return readTabDoc(db, tab, rowCount);
  } finally {
    db.close();
  }
}

export type WorkbookColumnRef = {
  name: string;
  physical: string;
  type: ColumnType;
  /** type='reference': the cross-tab source, resolved to display names
   *  ("CarModels"."Model") so schema surfaces can state the join edge. */
  refersTo?: { tab: string; column: string };
};
export type WorkbookTabRef = {
  name: string;
  viewName: string;
  physicalTable: string;
  /** FTS5 trigram shadow over the tab's text columns, or null when absent
   *  (pre-P2 file or no text columns). MATCH terms need double quotes. */
  ftsTable: string | null;
  rowCount: number;
  columns: WorkbookColumnRef[];
};

/** The SQL surface of a workbook, for table_sql callers: display-named views,
 *  physical tables/columns, FTS shadows. */
export function describeWorkbook(absPath: string): WorkbookTabRef[] {
  const db = openTableFile(absPath, { readOnly: true });
  try {
    const tabs = db.prepare(`SELECT tab_id, name, physical_table, view_name FROM _tabs ORDER BY position`).all();
    const tabNameById = new Map(tabs.map((t) => [String(t.tab_id), String(t.name)]));
    // col_id → display name across the whole file, for resolving ref edges.
    const colNameById = new Map(
      (db.prepare(`SELECT col_id, name FROM _columns`).all() as unknown as { col_id: string; name: string }[]).map(
        (c) => [c.col_id, c.name],
      ),
    );
    return tabs.map((t) => {
      const physicalTable = String(t.physical_table);
      // SELECT * — pre-v2.1 files have no ref_json column.
      const cols = db
        .prepare(`SELECT * FROM _columns WHERE tab_id = ? AND type != 'formula' ORDER BY position`)
        .all(String(t.tab_id));
      const fts = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(`${physicalTable}_fts`);
      return {
        name: String(t.name),
        viewName: String(t.view_name),
        physicalTable,
        ftsTable: fts ? `${physicalTable}_fts` : null,
        rowCount: Number(db.prepare(`SELECT count(*) AS n FROM ${physicalTable}`).get()?.n ?? 0),
        columns: cols.map((c) => {
          const out: WorkbookColumnRef = {
            name: String(c.name),
            physical: String(c.physical),
            type: String(c.type) as ColumnType,
          };
          // Only a linked-SELECT is a value edge worth advertising to the
          // schema/table_sql surface. A linked-checkbox only borrows the
          // source's label (a boolean, not its values) — no edge, matching
          // profile.ts (v2.2). A deleted source degrades to plain text: the
          // edge simply stops being advertised (Excel-style).
          if (c.ref_json != null && (c.ref_mode ?? 'select') === 'select') {
            const ref = JSON.parse(String(c.ref_json)) as { tabId: string; columnId: string };
            const tab = tabNameById.get(ref.tabId);
            const column = colNameById.get(ref.columnId);
            if (tab && column) out.refersTo = { tab, column };
          }
          return out;
        }),
      };
    });
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
