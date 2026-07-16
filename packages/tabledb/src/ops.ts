import { randomUUID } from 'node:crypto';

import { loadCell, storeCell, sqlTypeFor } from './cells';
import type { AggregateKind, CellValue, Column, ColumnType, View } from './doc-types';
import { storageType } from './doc-types';
import { createFtsShadow, ftsColumns, ftsTableName } from './fts';
import { dedupe, physicalName, quoteIdent, viewLabel, viewNameForTab } from './names';
import { openTableFile, type SqliteDb } from './sqlite';

/**
 * Incremental op application on a DRAFT workbook file (P3). The grid and the
 * agent tools stop shipping whole documents: each edit becomes an op
 * descriptor, batches apply atomically (BEGIN…COMMIT), and the registry lock
 * (content-side) serializes writers across processes.
 *
 * Ops mirror table-model's pure operations one-for-one — same names, same
 * semantics. Cell coercion is INJECTED by the caller (content passes
 * table-model's coerceCell) so a value written through an op is bit-identical
 * to what the same edit produced on the JSONB path.
 *
 * Row order: `_pos` fractional inserts (add-after = midpoint); when the gap
 * underflows, the whole tab renumbers in the same transaction (rare, cheap).
 */

export type TableOp =
  | {
      op: 'row_add';
      tabId?: string;
      rowId?: string;
      cells?: Record<string, CellValue>;
      afterRowId?: string | null;
      atStart?: boolean;
    }
  | { op: 'row_update'; tabId?: string; rowId: string; cells: Record<string, CellValue> }
  | { op: 'row_delete'; tabId?: string; rowId: string }
  | { op: 'cell_set'; tabId?: string; rowId: string; columnId: string; value: CellValue }
  | {
      op: 'column_add';
      tabId?: string;
      column: Omit<Column, 'id'> & { id?: string };
      afterColumnId?: string | null;
    }
  | { op: 'column_update'; tabId?: string; columnId: string; patch: ColumnPatch }
  | { op: 'column_delete'; tabId?: string; columnId: string }
  | { op: 'aggregate_set'; tabId?: string; columnId: string; kind: AggregateKind }
  | { op: 'view_set'; tabId?: string; view: View }
  | { op: 'select_option_add'; tabId?: string; columnId: string; label: string }
  // Tab CRUD (v2.1 P1). For these, tabId IS the target (required except add).
  | { op: 'tab_add'; tabId?: string; name: string; afterTabId?: string | null }
  | { op: 'tab_rename'; tabId: string; name: string }
  | { op: 'tab_reorder'; tabId: string; afterTabId?: string | null }
  | { op: 'tab_delete'; tabId: string };

/** column_update patch: `undefined` (key absent) = keep, explicit `null` =
 *  CLEAR. JSON transport drops undefined keys, so a differ signalling "this
 *  property was removed" must send null — `Partial<Column>` couldn't say it
 *  (audit: width/format/options/formula/ref clears from the grid were
 *  silently lost). name/type are never clearable. */
export type ColumnPatch = {
  name?: string;
  type?: ColumnType;
  format?: Column['format'] | null;
  options?: Column['options'] | null;
  formula?: string | null;
  width?: number | null;
  ref?: Column['ref'] | null;
};

export type CoerceFn = (value: unknown, type: ColumnType) => CellValue;

export type ApplyResult = {
  applied: number;
  /** Ids assigned to row_add / column_add ops, in op order (null for others). */
  createdIds: (string | null)[];
};

type ColRow = {
  tab_id: string;
  col_id: string;
  physical: string;
  name: string;
  type: ColumnType;
  options_json: string | null;
  position: number;
};

/** Storage/coerce type for a _columns row — a linked column stores as 'select'.
 *  Mirrors doc-types' storageType for ColRow. */
function rowStorageType(col: Pick<ColRow, 'type'>): ColumnType {
  return storageType({ type: col.type });
}

type TabRow = { tab_id: string; name: string; physical_table: string; view_name: string };

const POS_EPSILON = 1e-9;

function firstTab(db: SqliteDb): TabRow {
  const tab = db
    .prepare(`SELECT tab_id, name, physical_table, view_name FROM _tabs ORDER BY position LIMIT 1`)
    .get() as TabRow | undefined;
  if (!tab) throw new Error('tabledb ops: workbook has no tabs');
  return tab;
}

/** Resolve an op's target tab: explicit tabId, else the first tab (the
 *  pre-v2.1 contract every existing caller relies on). Unknown ids throw. */
function resolveTab(db: SqliteDb, tabId?: string): TabRow {
  if (tabId === undefined) return firstTab(db);
  const tab = db
    .prepare(`SELECT tab_id, name, physical_table, view_name FROM _tabs WHERE tab_id = ?`)
    .get(tabId) as TabRow | undefined;
  if (!tab) throw new Error(`tabledb ops: no tab '${tabId}' in this workbook`);
  return tab;
}

/** A view name unique across the file (case-insensitive vs other tabs' views
 *  AND everything else in sqlite_master — views share the namespace with the
 *  physical `t_*` tables and FTS shadows, so a tab literally named like one
 *  must suffix instead of failing the whole batch). */
function uniqueViewName(db: SqliteDb, wanted: string, excludeTabId?: string): string {
  const tabRows = db.prepare(`SELECT tab_id, view_name FROM _tabs`).all() as unknown as {
    tab_id: string;
    view_name: string;
  }[];
  const allViewNames = new Set(tabRows.map((t) => t.view_name.toLowerCase()));
  const taken = new Set(
    tabRows.filter((t) => t.tab_id !== excludeTabId).map((t) => t.view_name.toLowerCase()),
  );
  const master = db
    .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view')`)
    .all() as unknown as {
    name: string;
  }[];
  for (const m of master) {
    const n = m.name.toLowerCase();
    // Tab view names are handled above (the excluded tab's own view must stay
    // claimable on rename-to-self); everything else in master is reserved.
    if (!allViewNames.has(n)) taken.add(n);
  }
  let name = wanted;
  let n = 2;
  while (taken.has(name.toLowerCase())) name = `${wanted}_${n++}`;
  return name;
}

function columnsOf(db: SqliteDb, tabId: string): ColRow[] {
  // SELECT * — pre-v2.1 files have no ref_json column; missing fields read as
  // undefined instead of erroring.
  return db
    .prepare(`SELECT * FROM _columns WHERE tab_id = ? ORDER BY position`)
    .all(tabId) as unknown as ColRow[];
}

/** Lazy in-file upgrade: drafts copied from older published files lack the
 *  ref_json (pre-v2.1) column — add it before ops run (idempotent, cheap
 *  PRAGMA check). */
function ensureRefColumn(db: SqliteDb): void {
  const cols = db.prepare(`PRAGMA table_info(_columns)`).all() as unknown as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('ref_json')) db.exec(`ALTER TABLE _columns ADD COLUMN ref_json TEXT`);
}

/** type='reference' columns must point at an EXISTING (tab, column) in this
 *  workbook — never cross-file (ATTACH is denied in table_sql by design) and
 *  never at themselves. */
function validateRef(
  db: SqliteDb,
  ref: unknown,
  selfColId?: string,
): { tabId: string; columnId: string } {
  const r = (ref ?? {}) as { tabId?: unknown; columnId?: unknown };
  const tabId = String(r.tabId ?? '');
  const columnId = String(r.columnId ?? '');
  if (!tabId || !columnId)
    throw new Error('tabledb ops: a reference column needs ref {tabId, columnId}');
  if (columnId === selfColId)
    throw new Error('tabledb ops: a reference column cannot reference itself');
  const hit = db
    .prepare(`SELECT type FROM _columns WHERE tab_id = ? AND col_id = ?`)
    .get(tabId, columnId) as { type?: string } | undefined;
  if (!hit)
    throw new Error(
      `tabledb ops: reference target ${tabId}/${columnId} does not exist in this workbook`,
    );
  if (hit.type === 'formula')
    throw new Error('tabledb ops: a reference column cannot target a formula column');
  return { tabId, columnId };
}

/** Drop a tab's FTS shadow + triggers when present. Ops normally run on
 *  DRAFT files (shadows already stripped by ensureDraftFile), but column DDL
 *  against a shadow-carrying file breaks inside the triggers — drop first,
 *  defensively; finalizePublishedFile rebuilds shadows on promote. */
function dropFtsShadow(db: SqliteDb, tab: TabRow): void {
  db.exec(`DROP TRIGGER IF EXISTS ${tab.physical_table}_fts_ai`);
  db.exec(`DROP TRIGGER IF EXISTS ${tab.physical_table}_fts_ad`);
  db.exec(`DROP TRIGGER IF EXISTS ${tab.physical_table}_fts_au`);
  db.exec(`DROP TABLE IF EXISTS ${ftsTableName(tab.physical_table)}`);
}

/** Recreate the display-named SQL view from the current _columns (after any
 *  column add/delete/rename). Same labeling rules as the initial build. */
function rebuildView(db: SqliteDb, tab: TabRow): void {
  const cols = columnsOf(db, tab.tab_id).filter((c) => c.type !== 'formula');
  const labels = dedupe(cols.map((c) => viewLabel(c.name)));
  db.exec(`DROP VIEW IF EXISTS ${quoteIdent(tab.view_name)}`);
  const projections = cols.map((c, i) => `${c.physical} AS ${quoteIdent(labels[i]!)}`);
  db.exec(
    `CREATE VIEW ${quoteIdent(tab.view_name)} AS SELECT _rid, _pos${projections.length ? ', ' + projections.join(', ') : ''} FROM ${tab.physical_table}`,
  );
}

/**
 * Post-promotion finalize: a draft file just renamed into the published slot
 * has no FTS shadows (drafts never carry them) — rebuild them for every tab
 * and checkpoint. The promote path's counterpart to writeDocFile's fts flag.
 */
export function finalizePublishedFile(absPath: string): void {
  const db = openTableFile(absPath);
  try {
    const tabs = db
      .prepare(`SELECT tab_id, name, physical_table, view_name FROM _tabs ORDER BY position`)
      .all() as unknown as TabRow[];
    for (const tab of tabs) rebuildFtsShadow(db, tab);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

/** Drop + rebuild the FTS shadow to match the current text columns. Only used
 *  on files that HAVE a shadow (published promotions); drafts skip it. */
export function rebuildFtsShadow(db: SqliteDb, tab: TabRow): void {
  const fts = ftsTableName(tab.physical_table);
  db.exec(`DROP TRIGGER IF EXISTS ${tab.physical_table}_fts_ai`);
  db.exec(`DROP TRIGGER IF EXISTS ${tab.physical_table}_fts_ad`);
  db.exec(`DROP TRIGGER IF EXISTS ${tab.physical_table}_fts_au`);
  db.exec(`DROP TABLE IF EXISTS ${fts}`);
  const cols = columnsOf(db, tab.tab_id);
  // ftsColumns keys on storageType (a linked column is text). name is unused by
  // ftsColumns but kept for shape.
  const wanted = new Set(
    ftsColumns(
      cols.map((c) => ({
        id: c.col_id,
        name: c.name,
        type: c.type,
      })),
    ).map((c) => c.id),
  );
  const physicals = cols.filter((c) => wanted.has(c.col_id)).map((c) => c.physical);
  if (physicals.length === 0) return;
  createFtsShadow(db, tab.physical_table, physicals);
  const colList = physicals.join(', ');
  db.exec(
    `INSERT INTO ${fts}(rowid, ${colList}) SELECT rowid, ${colList} FROM ${tab.physical_table}`,
  );
}

function renumberPositions(db: SqliteDb, physicalTable: string): void {
  db.exec(`
    UPDATE ${physicalTable} SET _pos = (
      SELECT rn FROM (
        SELECT _rid AS rid, ROW_NUMBER() OVER (ORDER BY _pos, _rid) AS rn FROM ${physicalTable}
      ) WHERE rid = ${physicalTable}._rid
    )
  `);
}

function posForInsert(
  db: SqliteDb,
  physicalTable: string,
  afterRowId?: string | null,
  atStart?: boolean,
): number {
  if (atStart) {
    // Explicit front insert (the differ's "new first row"). `afterRowId:
    // null/undefined` must stay append — the tool path depends on it.
    const row = db.prepare(`SELECT min(_pos) AS m FROM ${physicalTable}`).get();
    const min = row?.m == null ? null : Number(row.m);
    if (min == null) return 1;
    const mid = min / 2;
    if (min < POS_EPSILON || mid <= 0 || mid >= min) {
      renumberPositions(db, physicalTable);
      return posForInsert(db, physicalTable, afterRowId, true);
    }
    return mid;
  }
  if (!afterRowId) {
    const row = db.prepare(`SELECT max(_pos) AS m FROM ${physicalTable}`).get();
    return Number(row?.m ?? 0) + 1;
  }
  const anchor = db.prepare(`SELECT _pos FROM ${physicalTable} WHERE _rid = ?`).get(afterRowId);
  if (!anchor) {
    const row = db.prepare(`SELECT max(_pos) AS m FROM ${physicalTable}`).get();
    return Number(row?.m ?? 0) + 1;
  }
  const anchorPos = Number(anchor._pos);
  const next = db
    .prepare(`SELECT min(_pos) AS m FROM ${physicalTable} WHERE _pos > ?`)
    .get(anchorPos);
  const nextPos = next?.m == null ? null : Number(next.m);
  if (nextPos == null) return anchorPos + 1;
  const mid = (anchorPos + nextPos) / 2;
  if (nextPos - anchorPos < POS_EPSILON || mid <= anchorPos || mid >= nextPos) {
    renumberPositions(db, physicalTable);
    return posForInsert(db, physicalTable, afterRowId);
  }
  return mid;
}

type NonTabOp = Exclude<TableOp, { op: `tab_${string}` }>;

function applyOne(db: SqliteDb, tab: TabRow, op: NonTabOp, coerce: CoerceFn): string | null {
  const cols = columnsOf(db, tab.tab_id);
  const byId = new Map(cols.map((c) => [c.col_id, c]));
  const table = tab.physical_table;

  const setCells = (rowId: string, cells: Record<string, CellValue>, merge: boolean): void => {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [colId, raw] of Object.entries(cells)) {
      const col = byId.get(colId);
      if (!col || col.type === 'formula') continue;
      const st = rowStorageType(col);
      const v = storeCell(coerce(raw, st), st);
      sets.push(`${col.physical} = ?`);
      values.push(v);
    }
    if (sets.length === 0 && merge) return;
    db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE _rid = ?`).run(...values, rowId);
  };

  switch (op.op) {
    case 'row_add': {
      const rowId = op.rowId ?? randomUUID();
      const pos = posForInsert(db, table, op.afterRowId, op.atStart === true);
      db.prepare(`INSERT INTO ${table} (_rid, _pos) VALUES (?, ?)`).run(rowId, pos);
      if (op.cells && Object.keys(op.cells).length > 0) setCells(rowId, op.cells, true);
      return rowId;
    }
    case 'row_update': {
      setCells(op.rowId, op.cells, true);
      return null;
    }
    case 'row_delete': {
      db.prepare(`DELETE FROM ${table} WHERE _rid = ?`).run(op.rowId);
      return null;
    }
    case 'cell_set': {
      setCells(op.rowId, { [op.columnId]: op.value }, true);
      return null;
    }
    case 'column_add': {
      const colId = op.column.id ?? randomUUID();
      if (byId.has(colId)) throw new Error(`tabledb ops: column ${colId} already exists`);
      const physicals = new Set(cols.map((c) => c.physical));
      let physical = physicalName('c', colId);
      let n = 2;
      while (physicals.has(physical)) physical = `${physicalName('c', colId)}_${n++}`;
      const anchor = op.afterColumnId ? byId.get(op.afterColumnId) : undefined;
      const position = anchor ? anchor.position + 1 : cols.length;
      if (anchor) {
        db.prepare(
          `UPDATE _columns SET position = position + 1 WHERE tab_id = ? AND position > ?`,
        ).run(tab.tab_id, anchor.position);
      }
      const isRef = op.column.type === 'reference';
      const ref = isRef ? validateRef(db, op.column.ref, colId) : null;
      db.prepare(
        `INSERT INTO _columns (tab_id, col_id, physical, name, type, format_json, options_json, formula_src, width, position, ref_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        tab.tab_id,
        colId,
        physical,
        op.column.name,
        op.column.type,
        op.column.format ? JSON.stringify(op.column.format) : null,
        op.column.options ? JSON.stringify(op.column.options) : null,
        op.column.formula ?? null,
        op.column.width ?? null,
        position,
        ref ? JSON.stringify(ref) : null,
      );
      if (op.column.type !== 'formula') {
        dropFtsShadow(db, tab);
        // A linked column's affinity follows its storage type (select → TEXT).
        const st = storageType({ type: op.column.type });
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${physical} ${sqlTypeFor(st)}`);
      }
      rebuildView(db, tab);
      return colId;
    }
    case 'column_update': {
      const col = byId.get(op.columnId);
      if (!col) return null; // mirror updateColumn's silent no-op on unknown id
      const patch = op.patch;
      const nextType = (patch.type ?? col.type) as ColumnType;
      const wasRef = col.type === 'reference';
      const willRef = nextType === 'reference';
      // ref_json: validate on link / re-point (patch.ref present, or newly
      // linked); clear on unlink.
      if (willRef && (patch.ref !== undefined || !wasRef)) {
        const ref = validateRef(db, patch.ref, op.columnId);
        db.prepare(`UPDATE _columns SET ref_json = ? WHERE tab_id = ? AND col_id = ?`).run(
          JSON.stringify(ref),
          tab.tab_id,
          op.columnId,
        );
      } else if (!willRef && wasRef) {
        db.prepare(`UPDATE _columns SET ref_json = NULL WHERE tab_id = ? AND col_id = ?`).run(
          tab.tab_id,
          op.columnId,
        );
      }
      // `null` = explicit CLEAR (JSON drops undefined keys, so the differ
      // signals property removal with null); absent key = keep current.
      db.prepare(
        `UPDATE _columns SET name = ?, type = ?, format_json = ?, options_json = ?, formula_src = ?, width = ?
         WHERE tab_id = ? AND col_id = ?`,
      ).run(
        patch.name ?? col.name,
        nextType,
        patch.format !== undefined
          ? patch.format
            ? JSON.stringify(patch.format)
            : null
          : ((db
              .prepare(`SELECT format_json FROM _columns WHERE tab_id = ? AND col_id = ?`)
              .get(tab.tab_id, op.columnId)?.format_json as string | null) ?? null),
        patch.options !== undefined
          ? patch.options
            ? JSON.stringify(patch.options)
            : null
          : col.options_json,
        patch.formula !== undefined
          ? patch.formula
          : ((db
              .prepare(`SELECT formula_src FROM _columns WHERE tab_id = ? AND col_id = ?`)
              .get(tab.tab_id, op.columnId)?.formula_src as string | null) ?? null),
        patch.width !== undefined
          ? patch.width
          : ((db
              .prepare(`SELECT width FROM _columns WHERE tab_id = ? AND col_id = ?`)
              .get(tab.tab_id, op.columnId)?.width as number | null) ?? null),
        tab.tab_id,
        op.columnId,
      );
      const typeChanged = patch.type !== undefined && patch.type !== col.type;
      // STORAGE shape before/after — a linked column stores as 'select', so a
      // text↔select retype (same storage) needn't re-coerce while other type
      // changes must.
      const prevStorage = rowStorageType(col);
      const nextStorage = storageType({ type: nextType });
      // Formula columns have NO physical column, so a retype across the
      // formula boundary is DDL, not a value rewrite — without it _columns
      // points at a column that doesn't exist and every subsequent read of
      // the file throws (audit: formula→text bricked the workbook).
      if (col.type === 'formula' && nextType !== 'formula') {
        dropFtsShadow(db, tab);
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.physical} ${sqlTypeFor(nextStorage)}`);
      } else if (col.type !== 'formula' && nextType === 'formula') {
        // Doc semantics: formula cells are never stored — drop the values
        // with the column (the view depends on it; drop that first).
        dropFtsShadow(db, tab);
        db.exec(`DROP VIEW IF EXISTS ${quoteIdent(tab.view_name)}`);
        db.exec(`ALTER TABLE ${table} DROP COLUMN ${col.physical}`);
      }
      // Storage change: re-coerce through the SAME coerce fn the doc path uses,
      // FROM THE DOC-SHAPED VALUE (loadCell first) — coercing the raw SQL
      // storage form diverged (checkbox stored 0/1 retyped to text became
      // '1' instead of 'true' — audit). Stored↔stored needs no DDL (SQLite is
      // dynamically typed); values rewrite in place. Keyed on STORAGE type so
      // text↔select (same storage) is a no-op and select↔checkbox re-coerces.
      if (col.type !== 'formula' && nextType !== 'formula' && prevStorage !== nextStorage) {
        const rows = db
          .prepare(
            `SELECT _rid, ${col.physical} AS v FROM ${table} WHERE ${col.physical} IS NOT NULL`,
          )
          .all();
        const upd = db.prepare(`UPDATE ${table} SET ${col.physical} = ? WHERE _rid = ?`);
        for (const r of rows) {
          const docValue = loadCell(r.v, prevStorage);
          upd.run(storeCell(coerce(docValue, nextStorage), nextStorage), String(r._rid));
        }
      }
      // Rename relabels the view; a formula-boundary change alters which
      // columns it projects.
      if ((patch.name && patch.name !== col.name) || typeChanged) rebuildView(db, tab);
      return null;
    }
    case 'column_delete': {
      const col = byId.get(op.columnId);
      if (!col) return null;
      db.prepare(`DELETE FROM _columns WHERE tab_id = ? AND col_id = ?`).run(
        tab.tab_id,
        op.columnId,
      );
      db.prepare(`DELETE FROM _aggregates WHERE tab_id = ? AND col_id = ?`).run(
        tab.tab_id,
        op.columnId,
      );
      if (col.type !== 'formula') {
        // The display view references the column — drop it BEFORE the column
        // (SQLite refuses to drop a column a view depends on), then rebuild.
        // FTS triggers reference it too (draft files carry none; defensive).
        dropFtsShadow(db, tab);
        db.exec(`DROP VIEW IF EXISTS ${quoteIdent(tab.view_name)}`);
        db.exec(`ALTER TABLE ${table} DROP COLUMN ${col.physical}`);
      }
      rebuildView(db, tab);
      return null;
    }
    case 'aggregate_set': {
      db.prepare(`DELETE FROM _aggregates WHERE tab_id = ? AND col_id = ?`).run(
        tab.tab_id,
        op.columnId,
      );
      if (op.kind !== 'none') {
        db.prepare(`INSERT INTO _aggregates (tab_id, col_id, kind) VALUES (?, ?, ?)`).run(
          tab.tab_id,
          op.columnId,
          op.kind,
        );
      }
      return null;
    }
    case 'view_set': {
      const viewId = op.view.id || randomUUID();
      const spec = JSON.stringify({ sort: op.view.sort ?? [], filters: op.view.filters ?? [] });
      const existing = db.prepare(`SELECT position FROM _views WHERE view_id = ?`).get(viewId);
      if (existing) {
        db.prepare(`UPDATE _views SET name = ?, spec_json = ? WHERE view_id = ?`).run(
          op.view.name,
          spec,
          viewId,
        );
      } else {
        const posRow = db
          .prepare(`SELECT count(*) AS n FROM _views WHERE tab_id = ?`)
          .get(tab.tab_id);
        db.prepare(
          `INSERT INTO _views (view_id, tab_id, name, spec_json, position) VALUES (?, ?, ?, ?, ?)`,
        ).run(viewId, tab.tab_id, op.view.name, spec, Number(posRow?.n ?? 0));
      }
      return viewId;
    }
    case 'select_option_add': {
      const col = byId.get(op.columnId);
      if (!col) return null;
      const trimmed = op.label.trim();
      if (!trimmed) return null;
      const options =
        (col.options_json
          ? (JSON.parse(col.options_json) as { id: string; label: string }[])
          : []) ?? [];
      if (options.some((o) => o.label.toLowerCase() === trimmed.toLowerCase())) return null;
      const slug = trimmed
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      const optId = slug && !options.some((o) => o.id === slug) ? slug : randomUUID();
      db.prepare(`UPDATE _columns SET options_json = ? WHERE tab_id = ? AND col_id = ?`).run(
        JSON.stringify([...options, { id: optId, label: trimmed }]),
        tab.tab_id,
        op.columnId,
      );
      return optId;
    }
  }
}

/** Renumber _tabs positions to the given tab_id order. */
function writeTabOrder(db: SqliteDb, order: string[]): void {
  const upd = db.prepare(`UPDATE _tabs SET position = ? WHERE tab_id = ?`);
  order.forEach((id, i) => upd.run(i, id));
}

function tabOrder(db: SqliteDb): string[] {
  return (
    db.prepare(`SELECT tab_id FROM _tabs ORDER BY position`).all() as unknown as {
      tab_id: string;
    }[]
  ).map((t) => t.tab_id);
}

/** Tab CRUD ops (v2.1 P1). Runs inside the batch transaction like applyOne. */
function applyTabOp(db: SqliteDb, op: Extract<TableOp, { op: `tab_${string}` }>): string | null {
  switch (op.op) {
    case 'tab_add': {
      const tabId = op.tabId ?? randomUUID();
      if (db.prepare(`SELECT 1 FROM _tabs WHERE tab_id = ?`).get(tabId)) {
        throw new Error(`tabledb ops: tab ${tabId} already exists`);
      }
      const physicalTable = physicalName('t', tabId);
      const viewName = uniqueViewName(db, viewNameForTab(op.name));
      db.prepare(
        `INSERT INTO _tabs (tab_id, name, position, physical_table, view_name) VALUES (?, ?, ?, ?, ?)`,
      ).run(tabId, op.name, tabOrder(db).length, physicalTable, viewName);
      db.exec(`CREATE TABLE ${physicalTable} (_rid TEXT PRIMARY KEY, _pos REAL NOT NULL)`);
      db.exec(`CREATE INDEX ${physicalTable}_pos ON ${physicalTable}(_pos)`);
      db.exec(`CREATE VIEW ${quoteIdent(viewName)} AS SELECT _rid, _pos FROM ${physicalTable}`);
      if (op.afterTabId !== undefined) {
        const order = tabOrder(db).filter((id) => id !== tabId);
        // null = front; unknown anchor appends (mirrors posForInsert's row rule).
        const anchor = op.afterTabId === null ? -1 : order.indexOf(op.afterTabId);
        const at = op.afterTabId === null ? 0 : anchor >= 0 ? anchor + 1 : order.length;
        order.splice(at, 0, tabId);
        writeTabOrder(db, order);
      }
      return tabId;
    }
    case 'tab_rename': {
      const tab = resolveTab(db, op.tabId);
      const viewName = uniqueViewName(db, viewNameForTab(op.name), tab.tab_id);
      db.exec(`DROP VIEW IF EXISTS ${quoteIdent(tab.view_name)}`);
      db.prepare(`UPDATE _tabs SET name = ?, view_name = ? WHERE tab_id = ?`).run(
        op.name,
        viewName,
        tab.tab_id,
      );
      rebuildView(db, { ...tab, name: op.name, view_name: viewName });
      return null;
    }
    case 'tab_reorder': {
      const tab = resolveTab(db, op.tabId);
      const order = tabOrder(db).filter((id) => id !== tab.tab_id);
      const at = op.afterTabId == null ? 0 : order.indexOf(op.afterTabId) + 1;
      if (op.afterTabId != null && at === 0)
        throw new Error(`tabledb ops: no tab '${op.afterTabId}' to reorder after`);
      order.splice(at, 0, tab.tab_id);
      writeTabOrder(db, order);
      return null;
    }
    case 'tab_delete': {
      const tab = resolveTab(db, op.tabId);
      if (tabOrder(db).length <= 1)
        throw new Error('tabledb ops: a workbook needs at least one tab');
      // FTS shadow (published files only) + triggers, then view, then data.
      dropFtsShadow(db, tab);
      db.exec(`DROP VIEW IF EXISTS ${quoteIdent(tab.view_name)}`);
      db.exec(`DROP TABLE IF EXISTS ${tab.physical_table}`);
      db.prepare(`DELETE FROM _columns WHERE tab_id = ?`).run(tab.tab_id);
      db.prepare(`DELETE FROM _views WHERE tab_id = ?`).run(tab.tab_id);
      db.prepare(`DELETE FROM _aggregates WHERE tab_id = ?`).run(tab.tab_id);
      db.prepare(`DELETE FROM _tabs WHERE tab_id = ?`).run(tab.tab_id);
      writeTabOrder(db, tabOrder(db));
      return null;
    }
  }
}

const TAB_OPS = new Set(['tab_add', 'tab_rename', 'tab_reorder', 'tab_delete']);

/** Apply an op batch atomically to a workbook file. The caller holds the
 *  registry lock; this owns the sqlite transaction. Each op targets its
 *  `tabId` (default: first tab); tab CRUD ops manage the tabs themselves. */
export function applyOpsToFile(absPath: string, ops: TableOp[], coerce: CoerceFn): ApplyResult {
  if (ops.length === 0) return { applied: 0, createdIds: [] };
  const db = openTableFile(absPath);
  try {
    ensureRefColumn(db);
    const createdIds: (string | null)[] = [];
    db.exec('BEGIN');
    try {
      for (const op of ops) {
        // Resolve per op — a tab_add/tab_delete earlier in the batch changes
        // what later ops may target.
        createdIds.push(
          TAB_OPS.has(op.op)
            ? applyTabOp(db, op as Extract<TableOp, { op: `tab_${string}` }>)
            : applyOne(db, resolveTab(db, op.tabId), op as NonTabOp, coerce),
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { applied: ops.length, createdIds };
  } finally {
    db.close();
  }
}
