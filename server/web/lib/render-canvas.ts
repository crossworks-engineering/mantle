/**
 * The canvas render, for this process's boot registration and its tests:
 * the module lives in @mantle/tools (canvas-render/sidecar.ts) so every
 * process that runs a tool registers the same one (server/api runs the
 * agent turns, server/mcp the local MCP).
 */
export * from '@mantle/tools/canvas-render';
