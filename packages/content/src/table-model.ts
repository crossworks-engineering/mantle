/**
 * The TableDoc model — the typed grid that is a table's source of truth, plus
 * the pure operations the API, tools, and UI all share. No DB, no IO: every
 * function takes a doc and returns a new doc (or a derived value), so the whole
 * model is unit-testable and safe to run inside a tool handler.
 *
 * This is the Tables analog of block-ids.ts / block-edit.ts for Pages, but the
 * addressing primitive is native: every column and row carries a stable id, so
 * "update row X" / "add a total to column Y" map straight onto `row.id` /
 * `column.id` — no tree walking.
 *
 *   columns[]   typed column definitions (id, name, type, format, options, …)
 *   rows[]      { id, cells: { [columnId]: CellValue } }
 *   aggregates  { [columnId]: 'sum' | 'avg' | … }  — footer totals
 *   views[]     saved sort + filter configurations
 *
 * Formula evaluation lives in table-formula.ts; this module calls into it via
 * `resolveCell` so callers always see computed values for formula columns.
 */
import { evalFormula } from './table-formula';

/** Isomorphic UUID — no `node:crypto`, no DB, so this module stays a
 *  browser-safe leaf the client grid can import directly. `randomUUID`
 *  itself only exists in secure contexts (HTTPS/localhost); on a plain-HTTP
 *  install (bare-IP, no-domain mode) it's absent, so fall back to a v4 built
 *  from `getRandomValues`, which is available everywhere. */
function randomUUID(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
}

export type ColumnType =
  | 'text'
  | 'number'
  | 'currency'
  | 'percent'
  | 'date'
  | 'datetime'
  | 'checkbox'
  | 'select'
  | 'multiselect'
  | 'url'
  | 'formula'
  | 'reference';

export const COLUMN_TYPES: readonly ColumnType[] = [
  'text',
  'number',
  'currency',
  'percent',
  'date',
  'datetime',
  'checkbox',
  'select',
  'multiselect',
  'url',
  'formula',
  'reference',
];

/** Aggregations available for a column's footer total. */
export type AggregateKind = 'none' | 'sum' | 'avg' | 'count' | 'min' | 'max' | 'empty' | 'filled';

export const AGGREGATE_KINDS: readonly AggregateKind[] = [
  'none',
  'sum',
  'avg',
  'count',
  'min',
  'max',
  'empty',
  'filled',
];

export type SelectOption = { id: string; label: string; color?: string };

export type ColumnFormat = {
  /** ISO 4217 code for currency columns (e.g. 'USD', 'ZAR'). */
  currency?: string;
  /** Fixed decimal places for number/currency/percent rendering. */
  decimals?: number;
};

/** Cross-tab reference target for type='reference' (v2.1 P4): the column
 *  offers VALUES from another tab's column, Excel data-validation style — a
 *  convenience picker (values copied as plain text/boolean at pick time, no
 *  joins, no live-follow; v2.2), same workbook only. */
export type ColumnRef = { tabId: string; columnId: string };

/** How a linked (type='reference') column behaves + stores (v2.2):
 *  select→one value (text), multi→several (deferred), checkbox→a real boolean
 *  whose label is borrowed from the source. Undefined = 'select' (the v0.136.0
 *  single-text reference — forward-compatible). Mirrors tabledb's RefMode. */
export type RefMode = 'select' | 'multi' | 'checkbox';

export type Column = {
  id: string;
  name: string;
  type: ColumnType;
  format?: ColumnFormat;
  /** Options for select / multiselect columns. */
  options?: SelectOption[];
  /** Expression for formula columns, e.g. "{Qty} * {Price}". */
  formula?: string;
  /** Persisted pixel width (UI only). */
  width?: number;
  /** Source column for reference (linked) columns. */
  ref?: ColumnRef;
  /** Behavior/storage mode for linked columns. */
  refMode?: RefMode;
};

/** The base type a column STORES / COERCES as — a linked column follows its
 *  refMode (select→text, multi→multiselect, checkbox→checkbox); everything
 *  else is itself. Callers coercing a cell use this, not the raw `type`. */
export function storageType(col: Pick<Column, 'type' | 'refMode'>): ColumnType {
  if (col.type !== 'reference') return col.type;
  return col.refMode === 'multi' ? 'multiselect' : col.refMode === 'checkbox' ? 'checkbox' : 'select';
}

/** A single cell's stored value. Formula cells are never stored — they're
 *  derived on read via `resolveCell`. */
export type CellValue = string | number | boolean | string[] | null;

export type Row = {
  id: string;
  cells: Record<string, CellValue>;
};

export type SortSpec = { colId: string; dir: 'asc' | 'desc' };

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'empty'
  | 'notEmpty';

export const FILTER_OPS: readonly FilterOp[] = [
  'eq',
  'neq',
  'contains',
  'gt',
  'lt',
  'gte',
  'lte',
  'empty',
  'notEmpty',
];

export type Filter = { colId: string; op: FilterOp; value?: CellValue };

export type View = {
  id: string;
  name: string;
  sort?: SortSpec[];
  filters?: Filter[];
};

export type TableDoc = {
  columns: Column[];
  rows: Row[];
  aggregates?: Record<string, AggregateKind>;
  views?: View[];
};

/** One tab of a multi-tab workbook (v2.1): a TableDoc plus its tab identity.
 *  Mirrors tabledb's WorkbookTabDoc structurally (one-way dep, same tripwire
 *  as TableDoc/TableDocLike). */
export type WorkbookTab = TableDoc & { id?: string; name: string };

/** Multi-tab write shape for import + tab-aware whole-doc writes. */
export type WorkbookDoc = { tabs: WorkbookTab[] };

/** Normalize a workbook input: each tab's doc through ensureTableDoc, names
 *  trimmed and defaulted ('Sheet1', 'Sheet2', …). Never returns zero tabs. */
export function ensureWorkbookDoc(input: WorkbookDoc): WorkbookDoc {
  const tabs = (Array.isArray(input.tabs) ? input.tabs : []).map((t, i) => ({
    ...ensureTableDoc(t),
    ...(t.id ? { id: t.id } : {}),
    name: (typeof t.name === 'string' && t.name.trim()) || `Sheet${i + 1}`,
  }));
  return { tabs: tabs.length > 0 ? tabs : [{ ...emptyTableDoc(), name: 'Sheet1' }] };
}

// ---------------------------------------------------------------------------
// Construction + id stability
// ---------------------------------------------------------------------------

/** A fresh blank grid: two text columns, three empty rows. */
export function emptyTableDoc(): TableDoc {
  const columns: Column[] = [
    { id: randomUUID(), name: 'Name', type: 'text' },
    { id: randomUUID(), name: 'Notes', type: 'text' },
  ];
  const rows: Row[] = [0, 1, 2].map(() => ({ id: randomUUID(), cells: {} }));
  return { columns, rows, aggregates: {}, views: [] };
}

/** Structural grid input (e.g. from a parsed spreadsheet) — column names +
 *  coarse types and row values aligned to the columns. `type` is a plain string
 *  so lower-level producers (like @mantle/files) needn't depend on this module;
 *  unknown types fall back to 'text'. */
export type GridInput = {
  columns: { name: string; type?: string }[];
  rows: (string | number | boolean | null)[][];
};

/** Build a TableDoc from a structural grid (the import path). Assigns stable
 *  ids and coerces every cell to its column type. */
export function tableDocFromGrid(input: GridInput): TableDoc {
  const columns: Column[] = input.columns.map((c) => ({
    id: randomUUID(),
    name: c.name?.trim() || 'Column',
    type: COLUMN_TYPES.includes(c.type as ColumnType) ? (c.type as ColumnType) : 'text',
  }));
  const rows: Row[] = input.rows.map((values) => {
    const cells: Record<string, CellValue> = {};
    columns.forEach((col, i) => {
      const v = coerceCell(values[i] ?? null, storageType(col));
      if (v !== null) cells[col.id] = v;
    });
    return { id: randomUUID(), cells };
  });
  return { columns, rows, aggregates: {}, views: [] };
}

/** Coerce an unknown/partial value into a well-formed TableDoc. Tolerant of
 *  legacy / hand-authored shapes — missing arrays become empty, every column
 *  and row gets a stable id, and cells are pruned to known columns. Returns the
 *  SAME reference when nothing changed (so callers can cheaply detect a no-op,
 *  mirroring `ensureBlockIds`). */
export function ensureTableDoc(input: unknown): TableDoc {
  const doc = (input ?? {}) as Partial<TableDoc>;
  const rawColumns = Array.isArray(doc.columns) ? doc.columns : [];
  const rawRows = Array.isArray(doc.rows) ? doc.rows : [];

  let changed = !Array.isArray(doc.columns) || !Array.isArray(doc.rows);

  const columns: Column[] = rawColumns.map((c) => {
    const col = (c ?? {}) as Partial<Column>;
    const id = typeof col.id === 'string' && col.id ? col.id : (changed = true, randomUUID());
    const type = COLUMN_TYPES.includes(col.type as ColumnType)
      ? (col.type as ColumnType)
      : (changed = true, 'text');
    const out: Column = { id, name: typeof col.name === 'string' ? col.name : 'Column', type };
    if (col.format && typeof col.format === 'object') out.format = col.format;
    if (Array.isArray(col.options)) out.options = col.options;
    if (typeof col.formula === 'string') out.formula = col.formula;
    if (typeof col.width === 'number') out.width = col.width;
    if (col.ref && typeof col.ref === 'object' && typeof col.ref.tabId === 'string' && typeof col.ref.columnId === 'string') {
      out.ref = { tabId: col.ref.tabId, columnId: col.ref.columnId };
    }
    if (out.type === 'reference' && (col.refMode === 'select' || col.refMode === 'multi' || col.refMode === 'checkbox')) {
      out.refMode = col.refMode;
    }
    return out;
  });

  const colIds = new Set(columns.map((c) => c.id));
  const rows: Row[] = rawRows.map((r) => {
    const row = (r ?? {}) as Partial<Row>;
    const id = typeof row.id === 'string' && row.id ? row.id : (changed = true, randomUUID());
    const rawCells = (row.cells ?? {}) as Record<string, CellValue>;
    const cells: Record<string, CellValue> = {};
    for (const [k, v] of Object.entries(rawCells)) {
      if (colIds.has(k)) cells[k] = v;
      else changed = true; // dropped a cell for a removed column
    }
    return { id, cells };
  });

  if (!changed) return input as TableDoc;
  return {
    columns,
    rows,
    aggregates: (doc.aggregates as Record<string, AggregateKind>) ?? {},
    views: Array.isArray(doc.views) ? (doc.views as View[]) : [],
  };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function findColumn(doc: TableDoc, columnId: string): Column | null {
  return doc.columns.find((c) => c.id === columnId) ?? null;
}

export function findColumnByName(doc: TableDoc, name: string): Column | null {
  const lower = name.trim().toLowerCase();
  return doc.columns.find((c) => c.name.trim().toLowerCase() === lower) ?? null;
}

export function findRow(doc: TableDoc, rowId: string): Row | null {
  return doc.rows.find((r) => r.id === rowId) ?? null;
}

export function rowIndex(doc: TableDoc, rowId: string): number {
  return doc.rows.findIndex((r) => r.id === rowId);
}

// ---------------------------------------------------------------------------
// Cell typing
// ---------------------------------------------------------------------------

/** Coerce a raw value into the storage shape for a column's type. Returns null
 *  for blanks. Pure — no locale formatting (that's the UI / table-to-text). */
export function coerceCell(value: unknown, type: ColumnType): CellValue {
  if (value === null || value === undefined || value === '') return null;
  switch (type) {
    case 'number':
    case 'currency':
    case 'percent': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[, ]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'checkbox':
      if (typeof value === 'boolean') return value;
      return ['true', '1', 'yes', 'y', 'x', '✓'].includes(String(value).trim().toLowerCase());
    case 'multiselect':
      if (Array.isArray(value)) return value.map((v) => String(v));
      return String(value)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    case 'date':
    case 'datetime':
    case 'text':
    case 'url':
    case 'select':
    case 'reference':
    case 'formula':
    default:
      return String(value);
  }
}

/** The value to use in computations / rendering for a (row, column): the stored
 *  cell, or — for formula columns — the evaluated result. */
export function resolveCell(doc: TableDoc, row: Row, col: Column): CellValue {
  if (col.type === 'formula') {
    return evalFormula(col.formula ?? '', doc, row);
  }
  return row.cells[col.id] ?? null;
}

/** Best-effort numeric reading of a resolved cell (for aggregates). */
export function cellNumber(value: CellValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.replace(/[, ]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function cellIsEmpty(value: CellValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// ---------------------------------------------------------------------------
// Row operations (return a NEW doc)
// ---------------------------------------------------------------------------

/** Add a row. `cells` are coerced to their column types. `afterRowId` inserts
 *  after that row; omit to append. */
export function addRow(
  doc: TableDoc,
  cells: Record<string, CellValue> = {},
  afterRowId?: string | null,
): { doc: TableDoc; row: Row } {
  const coerced: Record<string, CellValue> = {};
  for (const col of doc.columns) {
    if (col.type === 'formula') continue;
    if (col.id in cells) coerced[col.id] = coerceCell(cells[col.id], storageType(col));
  }
  const row: Row = { id: randomUUID(), cells: coerced };
  const rows = [...doc.rows];
  const at = afterRowId ? rows.findIndex((r) => r.id === afterRowId) : -1;
  if (at >= 0) rows.splice(at + 1, 0, row);
  else rows.push(row);
  return { doc: { ...doc, rows }, row };
}

/** Patch an existing row's cells (merge — unspecified cells are untouched). */
export function updateRow(
  doc: TableDoc,
  rowId: string,
  cells: Record<string, CellValue>,
): TableDoc {
  const rows = doc.rows.map((r) => {
    if (r.id !== rowId) return r;
    const next = { ...r.cells };
    for (const [colId, value] of Object.entries(cells)) {
      const col = findColumn(doc, colId);
      if (!col || col.type === 'formula') continue;
      const v = coerceCell(value, storageType(col));
      if (v === null) delete next[colId];
      else next[colId] = v;
    }
    return { ...r, cells: next };
  });
  return { ...doc, rows };
}

export function deleteRow(doc: TableDoc, rowId: string): TableDoc {
  return { ...doc, rows: doc.rows.filter((r) => r.id !== rowId) };
}

/** Set a single cell (the surgical "update row X column Y" primitive). */
export function setCell(
  doc: TableDoc,
  rowId: string,
  columnId: string,
  value: CellValue,
): TableDoc {
  return updateRow(doc, rowId, { [columnId]: value });
}

// ---------------------------------------------------------------------------
// Column operations (return a NEW doc)
// ---------------------------------------------------------------------------

export function addColumn(
  doc: TableDoc,
  spec: Omit<Column, 'id'> & { id?: string },
  afterColumnId?: string | null,
): { doc: TableDoc; column: Column } {
  const column: Column = { ...spec, id: spec.id ?? randomUUID() };
  const columns = [...doc.columns];
  const at = afterColumnId ? columns.findIndex((c) => c.id === afterColumnId) : -1;
  if (at >= 0) columns.splice(at + 1, 0, column);
  else columns.push(column);
  return { doc: { ...doc, columns }, column };
}

/** Patch a column definition. When the type changes, existing cells are
 *  re-coerced to the new type so the grid stays well-typed. */
export function updateColumn(
  doc: TableDoc,
  columnId: string,
  patch: Partial<Omit<Column, 'id'>>,
): TableDoc {
  const current = findColumn(doc, columnId);
  if (!current) return doc;
  const next: Column = { ...current, ...patch, id: columnId };
  const columns = doc.columns.map((c) => (c.id === columnId ? next : c));
  let rows = doc.rows;
  // Re-coerce cells when the STORAGE shape changes — a type change OR a linked
  // mode switch (select↔checkbox keeps type='reference' but changes storage).
  // Keyed on storageType so it matches the server's op-path recoerce (v2.2).
  const prevStorage = storageType(current);
  const nextStorage = storageType(next);
  if (prevStorage !== nextStorage) {
    rows = doc.rows.map((r) => {
      if (!(columnId in r.cells)) return r;
      const v = coerceCell(r.cells[columnId], nextStorage);
      const cells = { ...r.cells };
      if (v === null) delete cells[columnId];
      else cells[columnId] = v;
      return { ...r, cells };
    });
  }
  return { ...doc, columns, rows };
}

/** Remove a column and prune its cells + any aggregate / formula references. */
export function deleteColumn(doc: TableDoc, columnId: string): TableDoc {
  const columns = doc.columns.filter((c) => c.id !== columnId);
  const rows = doc.rows.map((r) => {
    if (!(columnId in r.cells)) return r;
    const cells = { ...r.cells };
    delete cells[columnId];
    return { ...r, cells };
  });
  const aggregates = { ...(doc.aggregates ?? {}) };
  delete aggregates[columnId];
  return { ...doc, columns, rows, aggregates };
}

/** Append a select/multiselect option to a column (deduped by label,
 *  case-insensitive). No-op if the label already exists or the column is
 *  missing. Used by the grid's combobox cell when the user creates a value
 *  inline. */
export function addSelectOption(doc: TableDoc, columnId: string, label: string): TableDoc {
  const col = findColumn(doc, columnId);
  if (!col) return doc;
  const trimmed = label.trim();
  if (!trimmed) return doc;
  const options = col.options ?? [];
  if (options.some((o) => o.label.toLowerCase() === trimmed.toLowerCase())) return doc;
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const id = slug && !options.some((o) => o.id === slug) ? slug : randomUUID();
  return updateColumn(doc, columnId, { options: [...options, { id, label: trimmed }] });
}

// ---------------------------------------------------------------------------
// Aggregates (footer totals)
// ---------------------------------------------------------------------------

export function setAggregate(doc: TableDoc, columnId: string, kind: AggregateKind): TableDoc {
  const aggregates = { ...(doc.aggregates ?? {}) };
  if (kind === 'none') delete aggregates[columnId];
  else aggregates[columnId] = kind;
  return { ...doc, aggregates };
}

/** Compute a column's aggregate over the given rows (defaults to all rows).
 *  Numeric kinds ignore non-numeric cells; count/filled/empty count cells. */
export function computeAggregate(
  doc: TableDoc,
  columnId: string,
  kind: AggregateKind,
  rows: Row[] = doc.rows,
): number | null {
  const col = findColumn(doc, columnId);
  if (!col || kind === 'none') return null;
  if (kind === 'count') return rows.length;
  if (kind === 'filled') return rows.filter((r) => !cellIsEmpty(resolveCell(doc, r, col))).length;
  if (kind === 'empty') return rows.filter((r) => cellIsEmpty(resolveCell(doc, r, col))).length;
  const nums = rows
    .map((r) => cellNumber(resolveCell(doc, r, col)))
    .filter((n): n is number => n !== null);
  if (nums.length === 0) return null;
  switch (kind) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min':
      return Math.min(...nums);
    case 'max':
      return Math.max(...nums);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Views (sort + filter) — non-mutating; returns the row slice to render
// ---------------------------------------------------------------------------

function matchesFilter(doc: TableDoc, row: Row, f: Filter): boolean {
  const col = findColumn(doc, f.colId);
  if (!col) return true;
  const value = resolveCell(doc, row, col);
  if (f.op === 'empty') return cellIsEmpty(value);
  if (f.op === 'notEmpty') return !cellIsEmpty(value);
  // Ordered comparisons never hold for an empty cell — it has no magnitude or
  // order (SQL NULL semantics). Without this, `lt 30000` on a blank cell would
  // fall through to the string path below (`'' < '30000'` === true) and wrongly
  // match every empty-valued row. eq/neq/contains keep their string behaviour.
  if (f.op === 'gt' || f.op === 'lt' || f.op === 'gte' || f.op === 'lte') {
    if (cellIsEmpty(value)) return false;
  }
  const target = f.value ?? null;
  const numA = cellNumber(value);
  const numB = cellNumber(target);
  const bothNumeric = numA !== null && numB !== null;
  switch (f.op) {
    case 'eq':
      return String(value ?? '') === String(target ?? '');
    case 'neq':
      return String(value ?? '') !== String(target ?? '');
    case 'contains':
      return String(value ?? '')
        .toLowerCase()
        .includes(String(target ?? '').toLowerCase());
    case 'gt':
      return bothNumeric ? numA > numB : String(value ?? '') > String(target ?? '');
    case 'lt':
      return bothNumeric ? numA < numB : String(value ?? '') < String(target ?? '');
    case 'gte':
      return bothNumeric ? numA >= numB : String(value ?? '') >= String(target ?? '');
    case 'lte':
      return bothNumeric ? numA <= numB : String(value ?? '') <= String(target ?? '');
    default:
      return true;
  }
}

function compareRows(doc: TableDoc, a: Row, b: Row, sort: SortSpec[]): number {
  for (const s of sort) {
    const col = findColumn(doc, s.colId);
    if (!col) continue;
    const va = resolveCell(doc, a, col);
    const vb = resolveCell(doc, b, col);
    const na = cellNumber(va);
    const nb = cellNumber(vb);
    let cmp: number;
    if (na !== null && nb !== null) cmp = na - nb;
    else cmp = String(va ?? '').localeCompare(String(vb ?? ''));
    if (cmp !== 0) return s.dir === 'desc' ? -cmp : cmp;
  }
  return 0;
}

/** Apply a saved view's filters + sort, returning the rows to render. Does not
 *  mutate the doc. Unknown view id → all rows, document order. */
export function applyView(doc: TableDoc, viewId?: string | null): Row[] {
  const view = viewId ? doc.views?.find((v) => v.id === viewId) : null;
  let rows = doc.rows;
  if (view?.filters?.length) {
    rows = rows.filter((r) => view.filters!.every((f) => matchesFilter(doc, r, f)));
  }
  if (view?.sort?.length) {
    rows = [...rows].sort((a, b) => compareRows(doc, a, b, view.sort!));
  }
  return rows;
}

/** An ad-hoc query over the grid — the same filter + sort a saved View carries,
 *  but supplied at call time and never persisted. */
export type RowQuery = {
  filters?: Filter[];
  /** 'all' (default) ANDs the filters; 'any' ORs them. */
  match?: 'all' | 'any';
  sort?: SortSpec[];
};

/** Filter + sort rows by an ad-hoc query, returning the matching rows (no view
 *  saved, doc unchanged). Reuses the exact predicate + comparator that saved
 *  views use, so `table_query` and a saved view agree. Pure. */
export function queryRows(doc: TableDoc, q: RowQuery = {}): Row[] {
  const filters = q.filters ?? [];
  let rows = doc.rows;
  if (filters.length) {
    const any = q.match === 'any';
    rows = rows.filter((r) =>
      any ? filters.some((f) => matchesFilter(doc, r, f)) : filters.every((f) => matchesFilter(doc, r, f)),
    );
  }
  if (q.sort?.length) {
    rows = [...rows].sort((a, b) => compareRows(doc, a, b, q.sort!));
  }
  return rows;
}

/** One group bucket: the group-key cell values (aligned, in order, to the
 *  requested group columns) plus the rows that fell into it. */
export type GroupBucket = { key: CellValue[]; rows: Row[] };

/** Group rows by one or more columns, after an optional filter — the SQL
 *  GROUP BY analog. Buckets keep first-seen order; callers compute per-group
 *  aggregates over `bucket.rows` with `computeAggregate`. Pure. Lets a caller
 *  answer "count of circuits by metallurgy" or "max design pressure per
 *  service" in one pass instead of paging the whole grid and grouping by hand. */
export function groupRows(
  doc: TableDoc,
  opts: { groupColIds: string[]; filters?: Filter[]; match?: 'all' | 'any' },
): GroupBucket[] {
  const cols = opts.groupColIds
    .map((id) => findColumn(doc, id))
    .filter((c): c is Column => c !== null);
  const rows = queryRows(doc, { filters: opts.filters, match: opts.match });
  const order: string[] = [];
  const buckets = new Map<string, GroupBucket>();
  for (const r of rows) {
    const key = cols.map((c) => resolveCell(doc, r, c));
    const k = JSON.stringify(key);
    let bucket = buckets.get(k);
    if (!bucket) {
      bucket = { key, rows: [] };
      buckets.set(k, bucket);
      order.push(k);
    }
    bucket.rows.push(r);
  }
  return order.map((k) => buckets.get(k)!);
}

/** Upsert a saved view by id (or append a new one). */
export function setView(doc: TableDoc, view: View): TableDoc {
  const views = [...(doc.views ?? [])];
  const at = views.findIndex((v) => v.id === view.id);
  if (at >= 0) views[at] = view;
  else views.push({ ...view, id: view.id || randomUUID() });
  return { ...doc, views };
}

// ---------------------------------------------------------------------------
// Doc diff → draft ops (v2.1 P5)
// ---------------------------------------------------------------------------

/** The subset of tabledb's TableOp the differ emits (structurally identical —
 *  same one-way-dep tripwire as TableDoc/TableDocLike). */
/** column_update patch: absent key = keep, explicit `null` = CLEAR. JSON
 *  transport drops undefined keys, so removals MUST travel as null. */
export type TableColumnPatch = {
  name?: string;
  type?: ColumnType;
  format?: ColumnFormat | null;
  options?: Column['options'] | null;
  formula?: string | null;
  width?: number | null;
  ref?: ColumnRef | null;
  refMode?: RefMode | null;
};

export type TableDocOp =
  | { op: 'row_add'; rowId: string; cells?: Record<string, CellValue>; afterRowId?: string | null; atStart?: boolean }
  | { op: 'row_update'; rowId: string; cells: Record<string, CellValue> }
  | { op: 'row_delete'; rowId: string }
  | { op: 'column_add'; column: Column; afterColumnId?: string | null }
  | { op: 'column_update'; columnId: string; patch: TableColumnPatch }
  | { op: 'column_delete'; columnId: string }
  | { op: 'aggregate_set'; columnId: string; kind: AggregateKind }
  | { op: 'view_set'; view: View };

const cellEq = (a: CellValue | undefined, b: CellValue | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Diff two docs into the draft ops that transform `prev` into `next` — the
 * grid's whole-doc onChange becomes an op batch (tab-targetable, scales past
 * the window). Returns NULL when the change isn't expressible as ops (row or
 * column reordering, view deletion) — the caller falls back to a whole-doc
 * save (single-tab tables) or surfaces the limitation.
 */
export function diffTableDocs(prev: TableDoc, next: TableDoc): TableDocOp[] | null {
  const ops: TableDocOp[] = [];

  // ── Columns ──
  const prevCols = new Map(prev.columns.map((c) => [c.id, c]));
  const nextCols = new Map(next.columns.map((c) => [c.id, c]));
  for (const c of prev.columns) if (!nextCols.has(c.id)) ops.push({ op: 'column_delete', columnId: c.id });
  // Reorder detection: surviving columns must keep their relative order.
  const survivingPrev = prev.columns.filter((c) => nextCols.has(c.id)).map((c) => c.id);
  const survivingNext = next.columns.filter((c) => prevCols.has(c.id)).map((c) => c.id);
  if (survivingPrev.join(' ') !== survivingNext.join(' ')) return null;
  next.columns.forEach((c, i) => {
    const old = prevCols.get(c.id);
    if (!old) {
      const afterColumnId = i > 0 ? next.columns[i - 1]!.id : null;
      ops.push({ op: 'column_add', column: c, afterColumnId });
      return;
    }
    // Removals travel as explicit null — `undefined` disappears in JSON and
    // the server would keep the old value (audit: width/format/ref clears
    // were silently lost).
    const patch: TableColumnPatch = {};
    if (old.name !== c.name) patch.name = c.name;
    if (old.type !== c.type) patch.type = c.type;
    if (JSON.stringify(old.format ?? null) !== JSON.stringify(c.format ?? null)) patch.format = c.format ?? null;
    if (JSON.stringify(old.options ?? null) !== JSON.stringify(c.options ?? null)) patch.options = c.options ?? null;
    if ((old.formula ?? '') !== (c.formula ?? '')) patch.formula = c.formula ?? null;
    if ((old.width ?? null) !== (c.width ?? null)) patch.width = c.width ?? null;
    if (JSON.stringify(old.ref ?? null) !== JSON.stringify(c.ref ?? null)) patch.ref = c.ref ?? null;
    if ((old.refMode ?? null) !== (c.refMode ?? null)) patch.refMode = c.refMode ?? null;
    if (Object.keys(patch).length > 0) ops.push({ op: 'column_update', columnId: c.id, patch });
  });

  // ── Rows ──
  const prevRows = new Map(prev.rows.map((r) => [r.id, r]));
  const nextRows = new Map(next.rows.map((r) => [r.id, r]));
  for (const r of prev.rows) if (!nextRows.has(r.id)) ops.push({ op: 'row_delete', rowId: r.id });
  const rowSurvivingPrev = prev.rows.filter((r) => nextRows.has(r.id)).map((r) => r.id);
  const rowSurvivingNext = next.rows.filter((r) => prevRows.has(r.id)).map((r) => r.id);
  if (rowSurvivingPrev.join(' ') !== rowSurvivingNext.join(' ')) return null;
  const colIds = next.columns.filter((c) => c.type !== 'formula').map((c) => c.id);
  next.rows.forEach((r, i) => {
    const old = prevRows.get(r.id);
    if (!old) {
      // Anchor to the IMMEDIATE predecessor in `next` — including another
      // new row: ops apply in batch order, so the predecessor already exists
      // when this op runs. (Anchoring a run to one shared pre-existing row
      // reversed it: the engine midpoint-inserts directly after the anchor,
      // so each op landed BEFORE the previous — audit.) A new FIRST row is an
      // explicit front insert; `afterRowId: null` means append to the engine.
      if (i === 0) ops.push({ op: 'row_add', rowId: r.id, cells: r.cells, atStart: true });
      else ops.push({ op: 'row_add', rowId: r.id, cells: r.cells, afterRowId: next.rows[i - 1]!.id });
      return;
    }
    const changed: Record<string, CellValue> = {};
    for (const colId of colIds) {
      if (!cellEq(old.cells[colId], r.cells[colId])) changed[colId] = r.cells[colId] ?? null;
    }
    if (Object.keys(changed).length > 0) ops.push({ op: 'row_update', rowId: r.id, cells: changed });
  });

  // ── Aggregates ──
  const prevAgg = prev.aggregates ?? {};
  const nextAgg = next.aggregates ?? {};
  for (const colId of new Set([...Object.keys(prevAgg), ...Object.keys(nextAgg)])) {
    if (!nextCols.has(colId)) continue; // column_delete already cleans up
    const a = prevAgg[colId] ?? 'none';
    const b = nextAgg[colId] ?? 'none';
    if (a !== b) ops.push({ op: 'aggregate_set', columnId: colId, kind: b });
  }

  // ── Views (upsert only — deletion and reordering have no op) ──
  const prevViews = new Map((prev.views ?? []).map((v) => [v.id, v]));
  const nextViewIds = new Set((next.views ?? []).map((v) => v.id));
  for (const v of next.views ?? []) {
    const old = prevViews.get(v.id);
    if (!old || JSON.stringify(old) !== JSON.stringify(v)) ops.push({ op: 'view_set', view: v });
  }
  if ((prev.views ?? []).some((v) => !nextViewIds.has(v.id))) return null;
  const viewOrderPrev = (prev.views ?? []).filter((v) => nextViewIds.has(v.id)).map((v) => v.id);
  const viewOrderNext = (next.views ?? []).filter((v) => prevViews.has(v.id)).map((v) => v.id);
  if (viewOrderPrev.join(' ') !== viewOrderNext.join(' ')) return null;

  return ops;
}
