/**
 * The areas an inbound API key can be limited to (migration 0232, plan page
 * 1e62e204), and which area each MCP tool belongs to. A leaf module (no
 * imports): the HTTP gate reads the area list from here too, so the two
 * surfaces share one list.
 *
 * A tool with no area (Recall, agents, peers, settings, the operator
 * tools) is open only to a key with every area (`areas` null). So is
 * every /api/v1 route with no area, except whoami.
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
] as const;
export type KeyArea = (typeof KEY_AREAS)[number];

/** Whole tool families by slug prefix. */
const AREA_PREFIXES: ReadonlyArray<readonly [string, KeyArea]> = [
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
  ['entity_', 'search'],
];

/** Single tools: reads across the brain, and the personal-space drafts a
 *  member or client makes (each in the area of what it makes). */
const AREA_TOOLS: ReadonlyMap<string, KeyArea> = new Map<string, KeyArea>([
  ['search', 'search'],
  ['search_chunks', 'search'],
  ['graph_path', 'search'],
  ['my_page_create', 'pages'],
  ['my_note_create', 'notes'],
  ['my_file_upload', 'files'],
]);

/** The area a tool belongs to, or null (open only to an all-areas key). */
export function toolKeyArea(slug: string): KeyArea | null {
  const exact = AREA_TOOLS.get(slug);
  if (exact) return exact;
  for (const [prefix, area] of AREA_PREFIXES) if (slug.startsWith(prefix)) return area;
  return null;
}

/** Whether a key limited to `areas` (null = all) may have this tool. */
export function keyAreasAllowTool(slug: string, areas: readonly string[] | null): boolean {
  if (areas === null) return true;
  const area = toolKeyArea(slug);
  return area !== null && areas.includes(area);
}
