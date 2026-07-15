import { randomUUID } from 'node:crypto';

import { loadCell, storeCell, sqlTypeFor } from './cells';
import type { AggregateKind, CellValue, Column, ColumnType, View } from './doc-types';
import { createFtsShadow, ftsColumns, ftsTableName } from './fts';
import { dedupe, physicalName, quoteIdent, viewLabel } from './names';
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
  | { op: 'row_add'; rowId?: string; cells?: Record<string, CellValue>; afterRowId?: string | null }
  | { op: 'row_update'; rowId: string; cells: Record<string, CellValue> }
  | { op: 'row_delete'; rowId: string }
  | { op: 'cell_set'; rowId: string; columnId: string; value: CellValue }
  | { op: 'column_add'; column: Omit<Column, 'id'> & { id?: string }; afterColumnId?: string | null }
  | { op: 'column_update'; columnId: string; patch: Partial<Omit<Column, 'id'>> }
  | { op: 'column_delete'; columnId: string }
  | { op: 'aggregate_set'; columnId: string; kind: AggregateKind }
  | { op: 'view_set'; view: View }
  | { op: 'select_option_add'; columnId: string; label: string };

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

type TabRow = { tab_id: string; name: string; physical_table: string; view_name: string };

const POS_EPSILON = 1e-9;

function firstTab(db: SqliteDb): TabRow {
  const tab = db.prepare(`SELECT tab_id, name, physical_table, view_name FROM _tabs ORDER BY position LIMIT 1`).get() as
    | TabRow
    | undefined;
  if (!tab) throw new Error('tabledb ops: workbook has no tabs');
  return tab;
}

function columnsOf(db: SqliteDb, tabId: string): ColRow[] {
  return db
    .prepare(
      `SELECT tab_id, col_id, physical, name, type, options_json, position FROM _columns WHERE tab_id = ? ORDER BY position`,
    )
    .all(tabId) as unknown as ColRow[];
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
  const wanted = new Set(ftsColumns(cols.map((c) => ({ id: c.col_id, name: c.name, type: c.type }))).map((c) => c.id));
  const physicals = cols.filter((c) => wanted.has(c.col_id)).map((c) => c.physical);
  if (physicals.length === 0) return;
  createFtsShadow(db, tab.physical_table, physicals);
  const colList = physicals.join(', ');
  db.exec(`INSERT INTO ${fts}(rowid, ${colList}) SELECT rowid, ${colList} FROM ${tab.physical_table}`);
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

function posForInsert(db: SqliteDb, physicalTable: string, afterRowId?: string | null): number {
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

function applyOne(db: SqliteDb, tab: TabRow, op: TableOp, coerce: CoerceFn): string | null {
  const cols = columnsOf(db, tab.tab_id);
  const byId = new Map(cols.map((c) => [c.col_id, c]));
  const table = tab.physical_table;

  const setCells = (rowId: string, cells: Record<string, CellValue>, merge: boolean): void => {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [colId, raw] of Object.entries(cells)) {
      const col = byId.get(colId);
      if (!col || col.type === 'formula') continue;
      const v = storeCell(coerce(raw, col.type), col.type);
      sets.push(`${col.physical} = ?`);
      values.push(v);
    }
    if (sets.length === 0 && merge) return;
    db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE _rid = ?`).run(...values, rowId);
  };

  switch (op.op) {
    case 'row_add': {
      const rowId = op.rowId ?? randomUUID();
      const pos = posForInsert(db, table, op.afterRowId);
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
        db.prepare(`UPDATE _columns SET position = position + 1 WHERE tab_id = ? AND position > ?`).run(
          tab.tab_id,
          anchor.position,
        );
      }
      db.prepare(
        `INSERT INTO _columns (tab_id, col_id, physical, name, type, format_json, options_json, formula_src, width, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
      if (op.column.type !== 'formula') {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${physical} ${sqlTypeFor(op.column.type)}`);
      }
      rebuildView(db, tab);
      return colId;
    }
    case 'column_update': {
      const col = byId.get(op.columnId);
      if (!col) return null; // mirror updateColumn's silent no-op on unknown id
      const patch = op.patch;
      const nextType = (patch.type ?? col.type) as ColumnType;
      db.prepare(
        `UPDATE _columns SET name = ?, type = ?, format_json = ?, options_json = ?, formula_src = ?, width = ?
         WHERE tab_id = ? AND col_id = ?`,
      ).run(
        patch.name ?? col.name,
        nextType,
        patch.format !== undefined ? JSON.stringify(patch.format) : (db
          .prepare(`SELECT format_json FROM _columns WHERE tab_id = ? AND col_id = ?`)
          .get(tab.tab_id, op.columnId)?.format_json as string | null) ?? null,
        patch.options !== undefined ? JSON.stringify(patch.options) : col.options_json,
        patch.formula !== undefined ? patch.formula : (db
          .prepare(`SELECT formula_src FROM _columns WHERE tab_id = ? AND col_id = ?`)
          .get(tab.tab_id, op.columnId)?.formula_src as string | null) ?? null,
        patch.width !== undefined ? patch.width : (db
          .prepare(`SELECT width FROM _columns WHERE tab_id = ? AND col_id = ?`)
          .get(tab.tab_id, op.columnId)?.width as number | null) ?? null,
        tab.tab_id,
        op.columnId,
      );
      // Type change: re-coerce through the SAME coerce fn the doc path uses,
      // FROM THE DOC-SHAPED VALUE (loadCell first) — coercing the raw SQL
      // storage form diverged (checkbox stored 0/1 retyped to text became
      // '1' instead of 'true'; multiselect JSON became '["a","b"]' instead
      // of 'a,b' — audit finding 3). SQLite is dynamically typed, so no DDL;
      // values rewrite in place.
      if (patch.type && patch.type !== col.type && col.type !== 'formula' && patch.type !== 'formula') {
        const rows = db.prepare(`SELECT _rid, ${col.physical} AS v FROM ${table} WHERE ${col.physical} IS NOT NULL`).all();
        const upd = db.prepare(`UPDATE ${table} SET ${col.physical} = ? WHERE _rid = ?`);
        for (const r of rows) {
          const docValue = loadCell(r.v, col.type);
          upd.run(storeCell(coerce(docValue, nextType), nextType), String(r._rid));
        }
      }
      if (patch.name && patch.name !== col.name) rebuildView(db, tab);
      return null;
    }
    case 'column_delete': {
      const col = byId.get(op.columnId);
      if (!col) return null;
      db.prepare(`DELETE FROM _columns WHERE tab_id = ? AND col_id = ?`).run(tab.tab_id, op.columnId);
      db.prepare(`DELETE FROM _aggregates WHERE tab_id = ? AND col_id = ?`).run(tab.tab_id, op.columnId);
      if (col.type !== 'formula') {
        // The display view references the column — drop it BEFORE the column
        // (SQLite refuses to drop a column a view depends on), then rebuild.
        db.exec(`DROP VIEW IF EXISTS ${quoteIdent(tab.view_name)}`);
        db.exec(`ALTER TABLE ${table} DROP COLUMN ${col.physical}`);
      }
      rebuildView(db, tab);
      return null;
    }
    case 'aggregate_set': {
      db.prepare(`DELETE FROM _aggregates WHERE tab_id = ? AND col_id = ?`).run(tab.tab_id, op.columnId);
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
        db.prepare(`UPDATE _views SET name = ?, spec_json = ? WHERE view_id = ?`).run(op.view.name, spec, viewId);
      } else {
        const posRow = db.prepare(`SELECT count(*) AS n FROM _views WHERE tab_id = ?`).get(tab.tab_id);
        db.prepare(`INSERT INTO _views (view_id, tab_id, name, spec_json, position) VALUES (?, ?, ?, ?, ?)`).run(
          viewId,
          tab.tab_id,
          op.view.name,
          spec,
          Number(posRow?.n ?? 0),
        );
      }
      return viewId;
    }
    case 'select_option_add': {
      const col = byId.get(op.columnId);
      if (!col) return null;
      const trimmed = op.label.trim();
      if (!trimmed) return null;
      const options = (col.options_json ? (JSON.parse(col.options_json) as { id: string; label: string }[]) : []) ?? [];
      if (options.some((o) => o.label.toLowerCase() === trimmed.toLowerCase())) return null;
      const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
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

/** Apply an op batch atomically to a workbook file. The caller holds the
 *  registry lock; this owns the sqlite transaction. */
export function applyOpsToFile(absPath: string, ops: TableOp[], coerce: CoerceFn): ApplyResult {
  if (ops.length === 0) return { applied: 0, createdIds: [] };
  const db = openTableFile(absPath);
  try {
    const tab = firstTab(db);
    const createdIds: (string | null)[] = [];
    db.exec('BEGIN');
    try {
      for (const op of ops) createdIds.push(applyOne(db, tab, op, coerce));
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
