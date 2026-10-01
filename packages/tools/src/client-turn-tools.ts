/**
 * Every tool a CLIENT's chat turn may call (client logins C5 audit, L3),
 * whatever the client agent's tool groups hold: the client tools (the items
 * shared with clients, read as the portal shows them; the client's own
 * items; filing a request), and `read_result` for a result too large to
 * send whole.
 *
 * Tool groups are config: an admin can add a tool to `client-read` by hand,
 * and an agent can bundle a recipe into a group. A brain-wide read tool
 * (page_get, search_chunks, node_read) at client level still returns what
 * the portal never shows a client: a page's raw doc (the labels of team and
 * admin items it mentions), summaries and chunks written from text above
 * client level. So the client turn intersects its tools with this list in
 * code (run-team-turn.ts), and nothing a group says widens it. The boot
 * reconcile also converges `client-read` back to the manifest.
 *
 * Adding a tool here is a security decision: it must read at client level
 * and show only what the client portal shows.
 */
export const CLIENT_TURN_TOOL_SLUGS: readonly string[] = [
  'client_shared_list',
  'client_shared_search',
  'client_shared_open',
  'my_items_list',
  'my_item_open',
  'client_request_create',
  'read_result',
];
