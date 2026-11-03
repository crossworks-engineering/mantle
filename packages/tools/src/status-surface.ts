/**
 * The surface of a status-only linked brain (a peer whose access scope is
 * `status`, docs/federation.md "Status links"): the tools it lists and calls,
 * and nothing else. A leaf module, so the gate's narrowers (gate-narrowers.ts)
 * and the MCP surface (@mantle/mcp-core) read the one list without loading
 * the tools themselves.
 */

/** The tools a status-only peer lists and calls: this box's numbers. */
export const STATUS_PEER_TOOL_SLUGS: ReadonlySet<string> = new Set([
  'box_status',
  'brain_capacity',
]);

/** The refusal of any other tool for a status-only peer. */
export const STATUS_ONLY_ERROR =
  "This linked brain reads this box's status only (box_status, brain_capacity).";
