import { loadCell } from './cells';
import type { AggregateKind, CellValue, ColumnType, Filter, Row, SortSpec } from './doc-types';
import { openTableFile, type SqliteDb } from './sqlite';

/**
 * Windowed reads over a workbook file (P3): keyset pagination on (_pos, _rid)
 * for the grid's lazy-load, and a PARITY-GATED filter/sort/aggregate compiler
 * for the read tools.
 *
 * Parity gate: table-model's matchesFilter has JS semantics (string compares
 * for eq/neq, numeric-if-both-numeric for ranges, resolveCell for formula
 * columns). We push down only the shapes whose SQL translation is exactly
 * equivalent; compileFilters returns null otherwise and the caller falls back
 * to the materialized-doc path (always possible ≤ MATERIALIZE_MAX; larger
 * tables are new in v2, so the SQL semantics ARE their contract).
 */

type ColMeta = { colId: string; physical: string; type: ColumnType };

function tabMeta(db: SqliteDb): { physicalTable: string; cols: ColMeta[] } {
  const tab = db.prepare(`SELECT tab_id, physical_table FROM _tabs ORDER BY position LIMIT 1`).get();
  if (!tab) throw new Error('tabledb window: workbook has no tabs');
  const cols = db
    .prepare(`SELECT col_id, physical, type FROM _columns WHERE tab_id = ? ORDER BY position`)
    .all(String(tab.tab_id))
    .map((c) => ({ colId: String(c.col_id), physical: String(c.physical), type: String(c.type) as ColumnType }));
  return { physicalTable: String(tab.physical_table), cols };
}

function rowsFrom(raw: Record<string, unknown>[], cols: ColMeta[]): Row[] {
  const stored = cols.filter((c) => c.type !== 'formula');
  return raw.map((r) => {
    const cells: Record<string, CellValue> = {};
    for (const c of stored) {
      const v = loadCell(r[c.physical], c.type);
      if (v !== null) cells[c.colId] = v;
    }
    return { id: String(r._rid), cells };
  });
}

export type RowWindow = {
  rows: Row[];
  /** Pass back as `after` for the next page; null when this was the last. */
  cursor: { pos: number; rid: string } | null;
  total: number;
};

/** Keyset page in _pos order. `after` is the last row of the previous page. */
export function listRowsWindow(
  absPath: string,
  opts: { limit?: number; after?: { pos: number; rid: string } } = {},
): RowWindow {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const db = openTableFile(absPath, { readOnly: true });
  try {
    const { physicalTable, cols } = tabMeta(db);
    const stored = cols.filter((c) => c.type !== 'formula');
    const select = ['_rid', '_pos', ...stored.map((c) => c.physical)].join(', ');
    const raw = opts.after
      ? db
          .prepare(
            `SELECT ${select} FROM ${physicalTable} WHERE (_pos, _rid) > (?, ?) ORDER BY _pos, _rid LIMIT ?`,
          )
          .all(opts.after.pos, opts.after.rid, limit)
      : db.prepare(`SELECT ${select} FROM ${physicalTable} ORDER BY _pos, _rid LIMIT ?`).all(limit);
    const total = Number(db.prepare(`SELECT count(*) AS n FROM ${physicalTable}`).get()?.n ?? 0);
    const last = raw[raw.length - 1];
    return {
      rows: rowsFrom(raw, cols),
      cursor: raw.length === limit && last ? { pos: Number(last._pos), rid: String(last._rid) } : null,
      total,
    };
  } finally {
    db.close();
  }
}

/** Fetch one row by its stable id (the beyond-the-window row_get path). */
export function readRowById(absPath: string, rid: string): Row | null {
  const db = openTableFile(absPath, { readOnly: true });
  try {
    const { physicalTable, cols } = tabMeta(db);
    const stored = cols.filter((c) => c.type !== 'formula');
    const select = ['_rid', ...stored.map((c) => c.physical)].join(', ');
    const raw = db.prepare(`SELECT ${select} FROM ${physicalTable} WHERE _rid = ?`).get(rid);
    if (!raw) return null;
    return rowsFrom([raw], cols)[0] ?? null;
  } finally {
    db.close();
  }
}

// ── Parity-gated filter compiler ─────────────────────────────────────────────

const TEXT_FAMILY = new Set<ColumnType>(['text', 'select', 'url', 'date', 'datetime']);
const NUM_FAMILY = new Set<ColumnType>(['number', 'currency', 'percent']);

type Compiled = { where: string; params: (string | number)[] };

/**
 * Compile the filter DSL to SQL, or return null when any filter falls outside
 * the parity-safe subset:
 *   - eq/neq/contains/empty/notEmpty on text-family columns
 *   - eq/neq on checkbox
 *   - gt/lt/gte/lte on number-family columns with numeric targets, and on
 *     date columns with string targets (ISO-normalized storage sorts right)
 *   - empty/notEmpty on anything stored
 * Formula and multiselect columns never push down.
 */
export function compileFilters(
  filters: Filter[],
  match: 'all' | 'any',
  cols: ColMeta[],
): Compiled | null {
  const byId = new Map(cols.map((c) => [c.colId, c]));
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  for (const f of filters) {
    const col = byId.get(f.colId);
    if (!col) {
      // matchesFilter treats an unknown column as "matches" — same here.
      clauses.push('1 = 1');
      continue;
    }
    if (col.type === 'formula' || col.type === 'multiselect') return null;
    const p = col.physical;
    const isEmpty = `(${p} IS NULL OR CAST(${p} AS TEXT) = '')`;
    switch (f.op) {
      case 'empty':
        clauses.push(isEmpty);
        break;
      case 'notEmpty':
        clauses.push(`NOT ${isEmpty}`);
        break;
      case 'eq':
      case 'neq': {
        // JS: String(value ?? '') === String(target ?? '')
        if (col.type === 'checkbox') {
          const want = f.value === true || f.value === 'true' || f.value === 1 ? 'true' : 'false';
          clauses.push(
            `(CASE WHEN ${p} IS NULL THEN '' WHEN ${p} != 0 THEN 'true' ELSE 'false' END) ${f.op === 'eq' ? '=' : '!='} ?`,
          );
          params.push(want);
          break;
        }
        if (!TEXT_FAMILY.has(col.type) && !NUM_FAMILY.has(col.type)) return null;
        clauses.push(`COALESCE(CAST(${p} AS TEXT), '') ${f.op === 'eq' ? '=' : '!='} ?`);
        params.push(String(f.value ?? ''));
        break;
      }
      case 'contains': {
        if (!TEXT_FAMILY.has(col.type) && !NUM_FAMILY.has(col.type)) return null;
        clauses.push(`instr(lower(COALESCE(CAST(${p} AS TEXT), '')), lower(?)) > 0`);
        params.push(String(f.value ?? ''));
        break;
      }
      case 'gt':
      case 'lt':
      case 'gte':
      case 'lte': {
        const sqlOp = { gt: '>', lt: '<', gte: '>=', lte: '<=' }[f.op];
        const numericTarget =
          typeof f.value === 'number' ||
          (typeof f.value === 'string' && f.value.trim() !== '' && Number.isFinite(Number(f.value.replace(/[, ]/g, ''))));
        if (NUM_FAMILY.has(col.type) && numericTarget) {
          // JS: empty never matches ordered compares; both numeric → numeric.
          clauses.push(`(${p} IS NOT NULL AND ${p} ${sqlOp} ?)`);
          params.push(typeof f.value === 'number' ? f.value : Number(String(f.value).replace(/[, ]/g, '')));
          break;
        }
        if ((col.type === 'date' || col.type === 'datetime') && typeof f.value === 'string' && !numericTarget) {
          // ISO text ordering — matches the JS string compare for non-numeric.
          clauses.push(`(${p} IS NOT NULL AND CAST(${p} AS TEXT) != '' AND CAST(${p} AS TEXT) ${sqlOp} ?)`);
          params.push(f.value);
          break;
        }
        return null;
      }
      default:
        return null;
    }
  }
  if (clauses.length === 0) return { where: '1 = 1', params: [] };
  return { where: clauses.join(match === 'any' ? ' OR ' : ' AND '), params };
}

/** Compile sort specs, or null when any references a formula column (JS
 *  resolveCell semantics) or mixes numeric/string comparison ambiguously. */
export function compileSort(sort: SortSpec[], cols: ColMeta[]): string | null {
  const byId = new Map(cols.map((c) => [c.colId, c]));
  const terms: string[] = [];
  for (const s of sort) {
    const col = byId.get(s.colId);
    if (!col) continue; // compareRows skips unknown columns
    if (col.type === 'formula' || col.type === 'multiselect') return null;
    const dir = s.dir === 'desc' ? 'DESC' : 'ASC';
    if (NUM_FAMILY.has(col.type) || col.type === 'checkbox') {
      terms.push(`${col.physical} ${dir}`);
    } else {
      // JS localeCompare on strings ≈ text ordering; NULLs sort as '' first.
      terms.push(`COALESCE(CAST(${col.physical} AS TEXT), '') ${dir}`);
    }
  }
  terms.push('_pos ASC', '_rid ASC'); // stable tie-break = document order
  return terms.join(', ');
}

export type QueryWindowResult = { rows: Row[]; total: number } | null;

/** Filtered/sorted OFFSET window (tool paging contract). Null = not
 *  parity-safe, caller falls back to the doc path. */
export function queryRowsWindow(
  absPath: string,
  opts: {
    filters?: Filter[];
    match?: 'all' | 'any';
    sort?: SortSpec[];
    offset?: number;
    limit?: number;
  },
): QueryWindowResult {
  const db = openTableFile(absPath, { readOnly: true });
  try {
    const { physicalTable, cols } = tabMeta(db);
    const compiled = compileFilters(opts.filters ?? [], opts.match === 'any' ? 'any' : 'all', cols);
    if (!compiled) return null;
    const orderBy = compileSort(opts.sort ?? [], cols);
    if (orderBy === null) return null;
    const stored = cols.filter((c) => c.type !== 'formula');
    const select = ['_rid', '_pos', ...stored.map((c) => c.physical)].join(', ');
    const limit = Math.max(0, Math.min(opts.limit ?? 200, 1000));
    const offset = Math.max(0, opts.offset ?? 0);
    const raw = db
      .prepare(`SELECT ${select} FROM ${physicalTable} WHERE ${compiled.where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...compiled.params, limit, offset);
    const total = Number(
      db.prepare(`SELECT count(*) AS n FROM ${physicalTable} WHERE ${compiled.where}`).get(...compiled.params)?.n ?? 0,
    );
    return { rows: rowsFrom(raw, cols), total };
  } finally {
    db.close();
  }
}

/** SQL aggregate with the same numeric semantics as computeAggregate (numeric
 *  kinds ignore non-numeric cells; count/filled/empty count rows/cells). Null
 *  = not parity-safe (formula target, or filters didn't compile). */
export function aggregateWindow(
  absPath: string,
  opts: { columnId: string; kind: AggregateKind; filters?: Filter[]; match?: 'all' | 'any' },
): number | null {
  if (opts.kind === 'none') return null;
  const db = openTableFile(absPath, { readOnly: true });
  try {
    const { physicalTable, cols } = tabMeta(db);
    const col = cols.find((c) => c.colId === opts.columnId);
    if (!col || col.type === 'formula') return null;
    const compiled = compileFilters(opts.filters ?? [], opts.match === 'any' ? 'any' : 'all', cols);
    if (!compiled) return null;
    const p = col.physical;
    const isEmpty = `(${p} IS NULL OR CAST(${p} AS TEXT) = '')`;
    let expr: string;
    switch (opts.kind) {
      case 'count':
        expr = 'count(*)';
        break;
      case 'filled':
        expr = `sum(CASE WHEN NOT ${isEmpty} THEN 1 ELSE 0 END)`;
        break;
      case 'empty':
        expr = `sum(CASE WHEN ${isEmpty} THEN 1 ELSE 0 END)`;
        break;
      default: {
        if (!NUM_FAMILY.has(col.type) && col.type !== 'checkbox') return null;
        const fn = { sum: 'sum', avg: 'avg', min: 'min', max: 'max' }[opts.kind];
        expr = `${fn}(${p})`;
        break;
      }
    }
    const row = db
      .prepare(`SELECT ${expr} AS v FROM ${physicalTable} WHERE ${compiled.where}`)
      .get(...compiled.params);
    return row?.v == null ? (opts.kind === 'count' || opts.kind === 'filled' || opts.kind === 'empty' ? 0 : null) : Number(row.v);
  } finally {
    db.close();
  }
}
