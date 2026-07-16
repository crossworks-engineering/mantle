import { loadCell } from './cells';
import type { AggregateKind, CellValue, ColumnType, Filter, RefMode, Row, SortSpec } from './doc-types';
import { storageType } from './doc-types';
import { openTableFile, type SqliteDb } from './sqlite';

/** The type a ColMeta stores/compares as — a linked column follows its
 *  refMode's base type (v2.2). Pushdown/sort/aggregate branch on THIS so a
 *  linked-checkbox filters as a checkbox, not as text. */
const metaType = (c: { type: ColumnType; refMode?: RefMode }): ColumnType => storageType(c);

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

type ColMeta = { colId: string; physical: string; type: ColumnType; refMode?: RefMode };

function tabMeta(db: SqliteDb, tabId?: string): { physicalTable: string; cols: ColMeta[] } {
  const tab =
    tabId === undefined
      ? db.prepare(`SELECT tab_id, physical_table FROM _tabs ORDER BY position LIMIT 1`).get()
      : db.prepare(`SELECT tab_id, physical_table FROM _tabs WHERE tab_id = ?`).get(tabId);
  if (!tab) {
    throw new Error(
      tabId === undefined ? 'tabledb window: workbook has no tabs' : `tabledb window: no tab '${tabId}' in this workbook`,
    );
  }
  const cols = db
    .prepare(`SELECT col_id, physical, type, ref_mode FROM _columns WHERE tab_id = ? ORDER BY position`)
    .all(String(tab.tab_id))
    .map((c) => ({
      colId: String(c.col_id),
      physical: String(c.physical),
      type: String(c.type) as ColumnType,
      ...(c.ref_mode != null ? { refMode: String(c.ref_mode) as RefMode } : {}),
    }));
  return { physicalTable: String(tab.physical_table), cols };
}

function rowsFrom(raw: Record<string, unknown>[], cols: ColMeta[]): Row[] {
  const stored = cols.filter((c) => c.type !== 'formula');
  return raw.map((r) => {
    const cells: Record<string, CellValue> = {};
    for (const c of stored) {
      const v = loadCell(r[c.physical], metaType(c));
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
  opts: { limit?: number; after?: { pos: number; rid: string }; tabId?: string } = {},
): RowWindow {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const db = openTableFile(absPath, { readOnly: true });
  try {
    const { physicalTable, cols } = tabMeta(db, opts.tabId);
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
export function readRowById(absPath: string, rid: string, opts: { tabId?: string } = {}): Row | null {
  const db = openTableFile(absPath, { readOnly: true });
  try {
    const { physicalTable, cols } = tabMeta(db, opts.tabId);
    const stored = cols.filter((c) => c.type !== 'formula');
    const select = ['_rid', ...stored.map((c) => c.physical)].join(', ');
    const raw = db.prepare(`SELECT ${select} FROM ${physicalTable} WHERE _rid = ?`).get(rid);
    if (!raw) return null;
    return rowsFrom([raw], cols)[0] ?? null;
  } finally {
    db.close();
  }
}

/** Distinct non-empty values of one column, alphabetical — the option list a
 *  reference column's editor offers (typeahead via `prefix`). */
export function distinctColumnValues(
  absPath: string,
  opts: { columnId: string; tabId?: string; limit?: number; prefix?: string },
): string[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const db = openTableFile(absPath, { readOnly: true });
  try {
    const { physicalTable, cols } = tabMeta(db, opts.tabId);
    const col = cols.find((c) => c.colId === opts.columnId);
    if (!col || col.type === 'formula') return [];
    const p = col.physical;
    const where = [`${p} IS NOT NULL`, `CAST(${p} AS TEXT) != ''`];
    const params: (string | number)[] = [];
    if (opts.prefix) {
      where.push(`CAST(${p} AS TEXT) LIKE ? ESCAPE '\\'`);
      params.push(`${opts.prefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
    }
    const raw = db
      .prepare(`SELECT DISTINCT CAST(${p} AS TEXT) AS v FROM ${physicalTable} WHERE ${where.join(' AND ')} ORDER BY 1 LIMIT ?`)
      .all(...params, limit);
    return raw.map((r) => String(r.v));
  } finally {
    db.close();
  }
}

// ── Parity-gated filter compiler ─────────────────────────────────────────────

const TEXT_FAMILY = new Set<ColumnType>(['text', 'select', 'url', 'date', 'datetime', 'reference']);
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
    const st = metaType(col); // storage type — a linked column compares as its base
    if (st === 'formula' || st === 'multiselect') return null;
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
        // JS: String(cell ?? '') === String(target ?? ''). The SQL must NOT
        // compare via CAST(REAL AS TEXT) — SQLite renders 9 as '9.0' where JS
        // renders '9' (audit finding: integer eq matched nothing pushed).
        const t = String(f.value ?? '');
        if (st === 'checkbox') {
          // Cells stringify to 'true'/'false' ('' when empty). Any other
          // target can never equal a cell — mirror that exactly.
          const cellText = `(CASE WHEN ${p} IS NULL THEN '' WHEN ${p} != 0 THEN 'true' ELSE 'false' END)`;
          if (t === 'true' || t === 'false' || t === '') {
            clauses.push(`${cellText} ${f.op === 'eq' ? '=' : '!='} ?`);
            params.push(t);
          } else {
            clauses.push(f.op === 'eq' ? '1 = 0' : '1 = 1');
          }
          break;
        }
        if (NUM_FAMILY.has(st)) {
          // A stored number matches iff its JS canonical string equals the
          // target — i.e. the target IS canonical and the values are equal.
          // Non-canonical targets ('9.0', 'abc') match no cell; '' matches
          // empty cells (String(null ?? '') === '').
          if (t === '') {
            clauses.push(f.op === 'eq' ? isEmpty : `NOT ${isEmpty}`);
          } else {
            const n = Number(t);
            const canonical = Number.isFinite(n) && String(n) === t.trim() && t.trim() === t;
            if (canonical) {
              clauses.push(
                f.op === 'eq' ? `(${p} IS NOT NULL AND ${p} = ?)` : `(${p} IS NULL OR ${p} != ?)`,
              );
              params.push(n);
            } else {
              clauses.push(f.op === 'eq' ? '1 = 0' : '1 = 1');
            }
          }
          break;
        }
        if (!TEXT_FAMILY.has(st)) return null;
        clauses.push(`COALESCE(CAST(${p} AS TEXT), '') ${f.op === 'eq' ? '=' : '!='} ?`);
        params.push(t);
        break;
      }
      case 'contains': {
        // Substring over JS-rendered text; SQLite can't reproduce JS number
        // formatting (9 → '9.0'), so number columns don't push down.
        if (!TEXT_FAMILY.has(st)) return null;
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
        if (NUM_FAMILY.has(st) && numericTarget) {
          // JS: empty never matches ordered compares; both numeric → numeric.
          clauses.push(`(${p} IS NOT NULL AND ${p} ${sqlOp} ?)`);
          params.push(typeof f.value === 'number' ? f.value : Number(String(f.value).replace(/[, ]/g, '')));
          break;
        }
        if ((st === 'date' || st === 'datetime') && typeof f.value === 'string' && !numericTarget) {
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

/** Compile sort specs, or null when parity can't hold. Number/checkbox/date
 *  columns push down; free-text columns DON'T (JS uses localeCompare — case-
 *  insensitive, locale-aware — and numeric-string pairwise compares, neither
 *  of which SQLite's BINARY collation reproduces; audit finding 6). Date
 *  columns are ISO text where string ordering agrees on both sides. */
export function compileSort(sort: SortSpec[], cols: ColMeta[]): string | null {
  const byId = new Map(cols.map((c) => [c.colId, c]));
  const terms: string[] = [];
  for (const s of sort) {
    const col = byId.get(s.colId);
    if (!col) continue; // compareRows skips unknown columns
    const dir = s.dir === 'desc' ? 'DESC' : 'ASC';
    const st = metaType(col);
    if (NUM_FAMILY.has(st) || st === 'checkbox') {
      terms.push(`${col.physical} ${dir}`);
    } else if (st === 'date' || st === 'datetime') {
      terms.push(`COALESCE(CAST(${col.physical} AS TEXT), '') ${dir}`);
    } else {
      return null;
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
    tabId?: string;
  },
): QueryWindowResult {
  const db = openTableFile(absPath, { readOnly: true });
  try {
    const { physicalTable, cols } = tabMeta(db, opts.tabId);
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
  opts: { columnId: string; kind: AggregateKind; filters?: Filter[]; match?: 'all' | 'any'; tabId?: string },
): number | null {
  if (opts.kind === 'none') return null;
  const db = openTableFile(absPath, { readOnly: true });
  try {
    const { physicalTable, cols } = tabMeta(db, opts.tabId);
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
        const st = metaType(col);
        if (!NUM_FAMILY.has(st) && st !== 'checkbox') return null;
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
