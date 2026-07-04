/**
 * Which tools an ANONYMOUS visitor may invoke through a public app share.
 *
 * The /s/<token>/tool-broker runs an app's declared tools under the owner's
 * scope for whoever holds the link. Declaring a tool is the operator's consent
 * to expose its DATA — but consent to read is not consent to let strangers
 * WRITE. This list is the enforcement the old "apps shared publicly must only
 * declare read-only tools" comment never had.
 *
 * Membership rules (deliberately conservative):
 *   - builtin tools only — http/shell/recipe tools NEVER qualify, whatever
 *     they're named: we can't see what an HTTP call mutates on the far side.
 *   - non-mutating only: pure reads of content the operator chose to surface.
 *   - privacy-tier exclusions even though they're reads: contacts, email,
 *     secrets/keys, peers, telegram, pending approvals, oauth — an anonymous
 *     visitor never needs those; a TEAM-mode share (identified + audited)
 *     is the right home for apps that do.
 *   - no outbound fetchers (web_fetch) and no LLM-invoking tools
 *     (summarize_text, generate_image, extract_from_image): cost + SSRF
 *     shaped, not data reads.
 *
 * Team-mode shares don't consult this list — an identified, audited team
 * member may use everything the app declared, writes included.
 *
 * Keep this list boring and auditable: one slug per line, grouped by surface.
 */
export const PUBLIC_READONLY_TOOL_SLUGS: ReadonlySet<string> = new Set([
  // notes
  'note_list',
  'note_get',
  // pages
  'page_list',
  'page_get',
  'page_blocks_list',
  'page_block_get',
  'read_section',
  // tables
  'table_list',
  'table_get',
  'table_query',
  'table_rows_list',
  'table_row_get',
  'table_aggregate',
  // tasks + events + journal
  'task_list',
  'task_get',
  'event_list',
  'event_get',
  'journal_list',
  'journal_get',
  // files + folders (metadata + content reads)
  'file_list',
  'file_get',
  'file_read',
  'folder_list',
  'folder_describe',
  'tree_list',
  // search + entity graph
  'search_nodes',
  'search_chunks',
  'entity_search',
  'entity_facts',
  'entity_mentions',
  'entity_neighbors',
  'graph_path',
]);

import type { Tool } from '@mantle/db';

/** May this resolved tool be dispatched for an anonymous public-share visitor?
 *  Builtin + explicitly listed; everything else (http/shell/recipe, writes,
 *  privacy-tier reads) is denied. */
export function isPublicReadOnlyTool(tool: Pick<Tool, 'slug' | 'handler'>): boolean {
  return tool.handler.kind === 'builtin' && PUBLIC_READONLY_TOOL_SLUGS.has(tool.slug);
}
