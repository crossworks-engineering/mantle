/**
 * The deferred selection's core (deferred.ts): which granted tools a turn
 * sends in full, in a fixed order. It never adds, removes or narrows a
 * grant, so it decides no access: on its own file so the architecture
 * count of tool policy lists (eslint-rules/arch-counts.mjs toolPolicySwept)
 * leaves exactly this list out, and any list deferred.ts holds is counted.
 */

/** Granted tools that are always sent in full: the tools that carry most
 *  turns on the fleet (a 20-tool core covered 54 to 86% of turns). A tool is
 *  core only if the agent is granted it; the list never adds a grant. The
 *  core is sent in THIS list's order (search and read first), not the grant's:
 *  on the bench a grant that put `calculate` first drew `calculate` calls.
 *  A fixed order is also byte-stable, which the prompt cache needs. */
export const CORE_TOOL_SLUGS: readonly string[] = [
  'search_chunks',
  'search_nodes',
  'read_section',
  'read_result',
  'node_read',
  'page_get',
  'page_list',
  'page_blocks_list',
  'page_block_get',
  'page_block_update',
  'invoke_agent',
  'file_read',
  'file_list',
  'table_list',
  'table_schema',
  'table_sql',
  'event_list',
  'note_get',
  'note_create',
  'calculate',
  // A style or relationship calibration ("keep replies shorter") does not read
  // as a task, so the model never searches for it: keep it in full.
  'update_persona',
];
