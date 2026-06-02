/**
 * Windowed row listing — the agent's "what's in this table?" view. Returns a
 * compact, paged snapshot (column summary once + a slice of rows as id +
 * short per-cell text) so a model can decide WHICH rows to touch, then act on
 * them by id (`table_row_update`, `table_cell_set`, …). The Tables analog of
 * `listBlocks` for Pages.
 *
 * Designed to stay under the inline tool-result cap: a 25-row window of a
 * 6-column table is a few KB. Bigger requests page via offset; the full grid
 * (if genuinely needed) goes through `table_get`, which spills to the
 * read_result store. Pure, no DB.
 */
import { applyView, resolveCell, type ColumnType, type TableDoc } from './table-model';
import { formatCellText } from './table-to-text';

export type RowListColumn = { id: string; name: string; type: ColumnType };

export type RowListEntry = {
  /** Stable row id — the addressing primitive ("update row X"). */
  id: string;
  /** 0-based position in the current view (post-filter/sort). */
  index: number;
  /** Per-column short text, keyed by column id. Empty cells omitted. */
  cells: Record<string, string>;
};

export type RowListResult = {
  columns: RowListColumn[];
  rows: RowListEntry[];
  /** Total rows in the (filtered) view — so the model knows if it paged. */
  total: number;
  offset: number;
  limit: number;
};

export type ListRowsOptions = {
  /** Apply a saved view's filter + sort before windowing. */
  viewId?: string | null;
  offset?: number;
  /** Max rows to return. Default 50. */
  limit?: number;
  /** Restrict the cell snapshot to these column ids (the column summary still
   *  lists every column so the model knows what exists). */
  columnIds?: string[];
  /** Per-cell preview character cap. Default 60. */
  previewChars?: number;
};

function truncate(s: string, max: number): string {
  const flat = s.replace(/\r?\n/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function listRows(doc: TableDoc, opts: ListRowsOptions = {}): RowListResult {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const offset = Math.max(0, opts.offset ?? 0);
  const previewChars = opts.previewChars ?? 60;
  const want = opts.columnIds && opts.columnIds.length > 0 ? new Set(opts.columnIds) : null;

  const columns: RowListColumn[] = doc.columns.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
  }));
  const viewRows = applyView(doc, opts.viewId ?? null);
  const slice = viewRows.slice(offset, offset + limit);

  const rows: RowListEntry[] = slice.map((row, i) => {
    const cells: Record<string, string> = {};
    for (const col of doc.columns) {
      if (want && !want.has(col.id)) continue;
      const text = formatCellText(resolveCell(doc, row, col), col);
      if (text) cells[col.id] = truncate(text, previewChars);
    }
    return { id: row.id, index: offset + i, cells };
  });

  return { columns, rows, total: viewRows.length, offset, limit };
}
