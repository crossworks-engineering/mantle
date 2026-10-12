/**
 * The create tools that make an item of a workspace kind (page, note, draw,
 * table, file, folder, app, formula, task, event, recall map). MCP gives
 * them the `workspace` argument and names where the item landed
 * (@mantle/mcp-core create-home.ts); an assistant turn makes the login's
 * private workspace only for one of them (turn-create-home.ts). A create
 * of an Admin-only kind is not here.
 */
export const CREATE_TOOL_SLUGS: ReadonlySet<string> = new Set([
  'note_create',
  'note_from_file',
  'note_from_page',
  'page_create',
  'page_from_file',
  'page_from_note',
  'page_from_notes',
  'page_from_journal',
  'page_split',
  'page_extract_section',
  'file_create',
  'file_upload',
  'file_copy',
  'folder_create',
  'folder_copy',
  'tree_folder_create',
  'table_create',
  'table_from_file',
  'table_from_text',
  'app_create',
  'app_duplicate',
  'app_import',
  'formula_create',
  'sheet_build',
  'generate_image',
  'task_create',
  'event_create',
  'recall_map_create',
]);
