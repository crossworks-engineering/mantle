/**
 * The areas an inbound API key can be limited to (migration 0232, plan page
 * 1e62e204). A leaf module (no imports): the HTTP gate reads the area list
 * from here too, so the two surfaces share one list.
 *
 * Which area a tool belongs to is its policy's `keyArea` (A5 step 2:
 * mcp-policy.ts toolKeyArea reads it, for a builtin and a hand-written MCP
 * tool alike). A tool with no area (Recall, agents, peers, settings, the
 * operator tools) is open only to a key with every area (`areas` null). So
 * is every /api/v1 route with no area, except whoami.
 *
 * Areas only narrow (workspaces plan 7.5, contract change 35): a key acts
 * as its login and reads that login's workspaces; its areas and its access
 * then take tools and routes away from that, never add to it.
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

/** Whole tool families by slug prefix: the area of a NAME no policy table
 *  holds (familyKeyArea). Every builtin and hand-written MCP tool declares
 *  its own area on its policy; what is left is a connector's tool (mcp_*,
 *  in no family) or a name that is no tool. Kept until A5 step 4 (owner
 *  decision, step 2 fix round 1): tool-policy-sweep.test.ts reads it to
 *  hold every declared tool of a family to the family's area. */
export const AREA_PREFIXES: ReadonlyArray<readonly [string, KeyArea]> = [
  ['page_', 'pages'],
  ['note_', 'notes'],
  ['task_', 'tasks'],
  ['table_', 'tables'],
  ['file_', 'files'],
  ['folder_', 'files'],
  ['event_', 'calendar'],
  ['contact_', 'contacts'],
  ['journal_', 'journal'],
  ['app_', 'apps'],
  // A member's own mini apps (team apps Phase 3): the authoring area.
  ['my_app_', 'apps'],
  ['entity_', 'search'],
];

/** The area of a name no policy table holds, by its family, or null. A
 *  conversion name (`_from_`) reads one kind and writes another, so it
 *  belongs to NO area (M2 audit F2), as every conversion tool's policy
 *  says. */
export function familyKeyArea(slug: string): KeyArea | null {
  if (slug.includes('_from_')) return null;
  for (const [prefix, area] of AREA_PREFIXES) if (slug.startsWith(prefix)) return area;
  return null;
}

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

/** Whether a key limited to `areas` (null = all) reaches email. Only the
 *  Search area does (docs/guide/07-api/08-api-keys.md), so a key without it
 *  must not reach email through the Files area either: the attachments of
 *  synced mail are file nodes (access matrix M4). */
export function keyAreasReachEmail(areas: readonly string[] | null): boolean {
  return areas === null || areas.includes('search');
}
