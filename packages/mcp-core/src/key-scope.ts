/**
 * The areas an inbound API key may still carry (migration 0232, plan page
 * 1e62e204): accepted and stored, but since workspaces W5b2 a key acts
 * exactly as its login (contract change 25), so no area narrows a key any
 * more (W8 drops the column). A leaf module (no imports): the key routes
 * read the list from here.
 */
export const KEY_AREAS = [
  'search',
  'pages',
  'notes',
  'tasks',
  'tables',
  'files',
  'calendar',
  'contacts',
  'journal',
  'apps',
  // The data of mini apps opened to MCP (team apps Phase 1): the app_data_*
  // tools. The apps area stays the authoring tools.
  'app_data',
] as const;
export type KeyArea = (typeof KEY_AREAS)[number];

/**
 * Tools that change the CONTENT of an existing page or note (M2 audit N3).
 * Content can embed other items (a file, a drawing, another page), and an
 * item embedded in a page others can read becomes readable to them too
 * (migration 0208), with no confirm. A key cannot confirm, so on an item
 * others can read these tools refuse a key (register/context.ts).
 */
export const KEY_SHARED_CONTENT_TOOLS: ReadonlySet<string> = new Set([
  'page_update',
  'page_update_draft',
  'page_commit',
  'page_block_update',
  'page_block_insert_after',
  'page_block_insert_before',
  'page_block_append',
  'page_blocks_apply',
  'page_mention',
  'page_split',
  'page_extract_section',
  'page_replace_from_file',
  'note_update',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The item a content tool names (`page_id`, else `id`), trimmed, and the
 * field it came from; `id: null` when the field is there but is not a
 * UUID (the guard refuses that: a padded or odd id must never slip past
 * the check and then be trimmed by the handler, final audit F1). Null when
 * neither field is given (the tool answers its own error).
 */
export function contentToolTarget(
  input: Record<string, unknown>,
): { field: 'page_id' | 'id'; id: string | null } | null {
  const field = input.page_id !== undefined ? 'page_id' : input.id !== undefined ? 'id' : null;
  if (!field) return null;
  const raw = input[field];
  const id = typeof raw === 'string' ? raw.trim() : '';
  return { field, id: UUID_RE.test(id) ? id : null };
}
