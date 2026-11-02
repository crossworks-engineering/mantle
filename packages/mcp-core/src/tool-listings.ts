/**
 * The listings an MCP connection may ask for on its URL (`?tools=`): the
 * tool map (map-surface.ts) or every tool. A leaf, so the OAuth resource
 * check (server/web lib/mcp-resource.ts) takes the endpoint with one of
 * them as this box's own without loading the tool surface.
 */
export const MCP_TOOL_LISTINGS = ['map', 'full'] as const;
