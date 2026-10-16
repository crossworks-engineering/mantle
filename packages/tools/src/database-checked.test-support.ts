/**
 * Tests only. The builtins whose item pre-check went in the pre-check
 * removal (docs/actors.md, "Pre-check deletion"): the database refuses the
 * same write itself, with both checks on, on the write role where the
 * pre-check ran. For each: the argument that names the item (null for one
 * named another way: a Recall map by its slug, a revision), what the write
 * needs of it, and the database's check that refuses it. The structural
 * test (item-write-gate.test.ts) holds each to having no `items` now; the
 * sweeps point each at an item the scope may not change.
 */
export type DatabaseChecked = Readonly<{
  param: string | null;
  need: 'read' | 'edit' | 'manage';
  check: string;
}>;

const WRITE = 'the write check (0278): edit of the item';
const DELETE = 'the delete check (0266): manage of the item';
const MOVE = 'the move check (0245, 0279): manage of the item';
const RECALL = 'the Recall edit checks (0280): edit of the map';
const TABLES = "the write check (0278) at the tables broker's checked statement";
const SNAPSHOTS = 'the node_snapshots edit check (0280)';
const APP_CODE = "the apps edit check (0280, D4): manage of the app's home";
const SUBTREE = 'the write check (0278); a rename, mantle_subtree_rewrite (0282)';

const entry = (param: string | null, need: DatabaseChecked['need'], check: string) =>
  Object.freeze({ param, need, check });

export const DATABASE_CHECKED: ReadonlyMap<string, DatabaseChecked> = new Map([
  ['note_update', entry('id', 'edit', WRITE)],
  ['task_update', entry('id', 'edit', WRITE)],
  ['event_update', entry('id', 'edit', WRITE)],
  ['formula_update', entry('id', 'edit', WRITE)],
  ['contact_update', entry('id', 'edit', WRITE)],
  ['journal_update', entry('id', 'edit', WRITE)],
  ['note_delete', entry('id', 'manage', DELETE)],
  ['task_delete', entry('id', 'manage', DELETE)],
  ['event_delete', entry('id', 'manage', DELETE)],
  ['formula_delete', entry('id', 'manage', DELETE)],
  ['contact_delete', entry('id', 'manage', DELETE)],
  ['journal_delete', entry('id', 'manage', DELETE)],
  ['page_update', entry('id', 'edit', WRITE)],
  ['page_update_draft', entry('id', 'edit', WRITE)],
  ['page_commit', entry('id', 'edit', WRITE)],
  ['page_discard_draft', entry('id', 'edit', WRITE)],
  ['page_replace_from_file', entry('page_id', 'edit', WRITE)],
  ['page_mention', entry('page_id', 'edit', WRITE)],
  ['page_delete', entry('id', 'manage', DELETE)],
  ['page_move', entry('id', 'manage', MOVE)],
  [
    'process_extraction',
    entry('node_id', 'read', 'its precondition reads the item in the scope (row security)'),
  ],
  ['access_set', entry('node_id', 'manage', 'it writes nothing (the levels went)')],
  [
    'node_unshare',
    entry('id', 'edit', "the handler's own rule (closeLink), and link_close (0280)"),
  ],
  [
    'page_unshare',
    entry('id', 'edit', "the handler's own rule (closeLink), and link_close (0280)"),
  ],
  ['tree_folder_update', entry('folder_id', 'edit', SUBTREE)],
  ...(
    [
      'recall_card_put',
      'recall_card_delete',
      'recall_map_update',
      'recall_map_publish',
      'recall_cards_reorder',
      'recall_map_set_slug',
      'recall_card_set_slug',
      'recall_prompt_confirm',
      'recall_revision_restore',
    ] as const
  ).map((slug) => [slug, entry(null, 'edit', RECALL)] as const),
  ['recall_map_delete', entry(null, 'manage', 'the delete check (0266): manage of the map')],
  ...(
    [
      'table_column_add',
      'table_column_update',
      'table_column_delete',
      'table_set_aggregate',
      'table_set_view',
      'table_row_add',
      'table_rows_add',
      'table_rows_upsert',
      'table_row_update',
      'table_row_delete',
      'table_cell_set',
      'table_tab_add',
      'table_tab_rename',
      'table_tab_delete',
    ] as const
  ).map((slug) => [slug, entry('table_id', 'edit', TABLES)] as const),
  ['table_commit', entry('id', 'edit', TABLES)],
  ['table_snapshot_restore', entry('id', 'edit', TABLES)],
  ['table_update', entry('id', 'edit', WRITE)],
  ['table_delete', entry('id', 'manage', DELETE)],
  ['table_snapshot_create', entry('id', 'edit', SNAPSHOTS)],
  ['table_snapshot_delete', entry('id', 'edit', SNAPSHOTS)],
  ['file_rename', entry('file_id', 'edit', WRITE)],
  ['file_set_indexing', entry('file_id', 'edit', WRITE)],
  ['folder_rename', entry('folder_id', 'edit', SUBTREE)],
  ['folder_describe', entry('folder_id', 'edit', WRITE)],
  ['folder_set_indexing', entry('folder_id', 'edit', WRITE)],
  ['file_move', entry('file_id', 'manage', MOVE)],
  ['folder_move', entry('folder_id', 'manage', 'mantle_subtree_rewrite (0282), the move check')],
  ['folder_delete', entry('folder_id', 'manage', 'the delete check (0266), hidden rows (0282)')],
  ...(['app_file_write', 'app_file_delete', 'app_source_set', 'app_tools_set'] as const).map(
    (slug) => [slug, entry('id', 'edit', APP_CODE)] as const,
  ),
  ['app_snapshot_create', entry('id', 'edit', SNAPSHOTS)],
  ['app_snapshot_delete', entry('id', 'edit', SNAPSHOTS)],
]);
