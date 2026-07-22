/**
 * Structural doc types — the exact shape of @mantle/content's TableDoc, owned
 * here so the dependency arrow stays one-way (content → tabledb; the engine
 * never imports content). TypeScript's structural typing makes a real TableDoc
 * assignable to these without casts; a shape drift over there fails the
 * content-side typecheck where the two meet (tables.ts), which is the tripwire
 * we want.
 */

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

export type CellValue = string | number | boolean | string[] | null;

export type SelectOption = { id: string; label: string; color?: string };

export type ColumnFormat = { currency?: string; decimals?: number };

/** Cross-tab reference target (type='reference', v2.1 P4): the cell offers /
 *  stores VALUES from another tab's column, Excel data-validation style —
 *  soft integrity (free text allowed, dangling values flagged in the
 *  profile), same workbook only. A CONVENIENCE picker: values are copied as
 *  plain text at pick time and do NOT follow source renames — no joins, no
 *  row-ids (v2.2 decision). */
export type ColumnRef = { tabId: string; columnId: string };

export type Column = {
  id: string;
  name: string;
  type: ColumnType;
  format?: ColumnFormat;
  options?: SelectOption[];
  formula?: string;
  width?: number;
  ref?: ColumnRef;
};

/** The type a column STORES/COERCES as. A linked (reference) column stores as
 *  'select' (TEXT); every other column stores as itself. Callers at the
 *  storage boundary (store/load/coerce/DDL/FTS/pushdown) use THIS, not the raw
 *  `type`, so reference cells round-trip through the proven select path — the
 *  `type==='reference'` "is it linked?" checks elsewhere stay valid. */
export function storageType(col: Pick<Column, 'type'>): ColumnType {
  return col.type === 'reference' ? 'select' : col.type;
}

export type Row = { id: string; cells: Record<string, CellValue> };

export type SortSpec = { colId: string; dir: 'asc' | 'desc' };

export type FilterOp =
  'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'gte' | 'lte' | 'empty' | 'notEmpty';

export type Filter = { colId: string; op: FilterOp; value?: CellValue };

export type View = { id: string; name: string; sort?: SortSpec[]; filters?: Filter[] };

export type AggregateKind = 'none' | 'sum' | 'avg' | 'count' | 'min' | 'max' | 'empty' | 'filled';

export type TableDocLike = {
  columns: Column[];
  rows: Row[];
  aggregates?: Record<string, AggregateKind>;
  views?: View[];
};

/** One tab of a multi-tab workbook doc (v2.1 P1): a TableDocLike plus its tab
 *  identity. `id` is stable across writes when provided; the writer assigns
 *  positional ids ('t1', 't2', …) when absent. */
export type WorkbookTabDoc = TableDocLike & { id?: string; name: string };

/** Multi-tab workbook doc — the generalized write shape. A bare TableDocLike
 *  is accepted everywhere a WorkbookDocLike is (it normalizes to one tab), so
 *  every pre-v2.1 caller keeps working unchanged. */
export type WorkbookDocLike = { tabs: WorkbookTabDoc[] };
