/**
 * Table builtins — let an agent build and operate typed database grids. A
 * table stores its grid as a structured `TableDoc` (`tables.data`), so these
 * wrap the `@mantle/content` table CRUD + the pure model ops. The addressing
 * primitive is the stable `row.id` / `column.id`: "update row X", "total
 * column Y", "set the status cell of row Z" all map straight onto an id — the
 * grid analog of the `page_block_*` tools.
 *
 * Safety mirrors Pages: every structural edit writes to `draft_data` ONLY (via
 * saveTableDraft); the published grid + its brain index are untouched until the
 * operator commits (`table_commit`, or the Commit button at /tables/<id>). So a
 * misbehaving transform can never silently overwrite the live table.
 */

import type { BuiltinToolDef } from './types';
import {
  table_create,
  table_from_file,
  table_from_text,
  table_update,
  table_delete,
  table_commit,
} from './tables/workbook';
import {
  table_list,
  table_get,
  table_schema,
  table_sql,
  table_rows_list,
  table_row_get,
} from './tables/read';
import { table_query, table_aggregate } from './tables/query';
import {
  table_row_add,
  table_rows_add,
  table_rows_upsert,
  table_row_update,
  table_row_delete,
  table_cell_set,
} from './tables/rows';
import {
  table_column_add,
  table_column_update,
  table_column_delete,
  table_set_aggregate,
  table_set_view,
} from './tables/columns';
import { table_tab_add, table_tab_rename, table_tab_delete } from './tables/tabs';

export const TABLE_TOOLS: BuiltinToolDef[] = [
  table_create,
  table_from_file,
  table_from_text,
  table_update,
  table_delete,
  table_commit,
  table_list,
  table_get,
  table_schema,
  table_sql,
  table_rows_list,
  table_row_get,
  table_query,
  table_aggregate,
  table_row_add,
  table_rows_add,
  table_rows_upsert,
  table_row_update,
  table_row_delete,
  table_cell_set,
  table_column_add,
  table_column_update,
  table_column_delete,
  table_tab_add,
  table_tab_rename,
  table_tab_delete,
  table_set_aggregate,
  table_set_view,
];

export const TABLE_TOOL_SLUGS: string[] = TABLE_TOOLS.map((t) => t.slug);
