/**
 * Re-export of the shared tools-registry CRUD. The implementation moved
 * to @mantle/tools (packages/tools/src/crud.ts) so the Toolsmith agent
 * builtins and the MCP server can use the same code paths as the web
 * routes. Kept as a module so existing `@/lib/tools` imports stand.
 */

export {
  listToolsForOwner,
  getToolById,
  createTool,
  updateTool,
  deleteTool,
  type ToolSummary,
  type CreateToolInput,
  type UpdateToolInput,
} from '@mantle/tools';
