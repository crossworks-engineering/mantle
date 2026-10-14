/**
 * The search group of the hand-written MCP tools: `tree_list` and `search`
 * (the surface's name for the `search_nodes` builtin, run through
 * callBuiltin). Their definitions, policy and bodies are in mcp-defs.ts
 * (A5 step 2); this registers them at the group's place.
 */

import { registerMcpTools } from '../mcp-defs';
import type { McpRegisterContext } from './context';

export function registerSearchTools(ctx: McpRegisterContext): void {
  registerMcpTools(ctx, 'search');
}
