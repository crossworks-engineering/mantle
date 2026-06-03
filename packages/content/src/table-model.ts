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

/** Isomorphic UUID — Web Crypto is available on `globalThis` in modern Node
 *  (18.17+) and every browser, so this module stays a browser-safe leaf the
 *  client grid can import directly (no `node:crypto`, no DB). */
function randomUUID(): string {
  return globalThis.crypto.randomUUID();
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
  | 'formula';

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
};

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
      const v = coerceCell(values[i] ?? null, col.type);
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
    if (col.id in cells) coerced[col.id] = coerceCell(cells[col.id], col.type);
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
      const v = coerceCell(value, col.type);
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
  if (patch.type && patch.type !== current.type) {
    rows = doc.rows.map((r) => {
      if (!(columnId in r.cells)) return r;
      const v = coerceCell(r.cells[columnId], next.type);
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

/** Upsert a saved view by id (or append a new one). */
export function setView(doc: TableDoc, view: View): TableDoc {
  const views = [...(doc.views ?? [])];
  const at = views.findIndex((v) => v.id === view.id);
  if (at >= 0) views[at] = view;
  else views.push({ ...view, id: view.id || randomUUID() });
  return { ...doc, views };
}
