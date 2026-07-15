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
  | 'formula';

export type CellValue = string | number | boolean | string[] | null;

export type SelectOption = { id: string; label: string; color?: string };

export type ColumnFormat = { currency?: string; decimals?: number };

export type Column = {
  id: string;
  name: string;
  type: ColumnType;
  format?: ColumnFormat;
  options?: SelectOption[];
  formula?: string;
  width?: number;
};

export type Row = { id: string; cells: Record<string, CellValue> };

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

export type Filter = { colId: string; op: FilterOp; value?: CellValue };

export type View = { id: string; name: string; sort?: SortSpec[]; filters?: Filter[] };

export type AggregateKind = 'none' | 'sum' | 'avg' | 'count' | 'min' | 'max' | 'empty' | 'filled';

export type TableDocLike = {
  columns: Column[];
  rows: Row[];
  aggregates?: Record<string, AggregateKind>;
  views?: View[];
};
