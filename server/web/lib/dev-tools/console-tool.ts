/**
 * The API Console's run of a tool (POST /api/dev-tools/execute-tool): as the
 * signed-in login's own MCP call of it, never as the area's system actor.
 * The caller is the one /api/mcp makes for an Admin user's OAuth
 * connection (mcp-core prepareCallerTools, mcpGateCaller): the login's
 * actor, its own scope (the union of its workspaces) entered for the call,
 * its Admin step read now, the row security of the login write pool. So the
 * console reads and writes what that login's own MCP client would: another
 * login's per-login item is not found, as it is there.
 */
import { mcpGateCaller, prepareCallerTools } from '@mantle/mcp-core';
import { dispatchTool, mcpToolCaller, type ToolHandlerResult } from '@mantle/tools';
import type { Tool } from '@mantle/db';

/** Run `tool` for the console's caller: `brainId` the anchor, `loginId` the
 *  signed-in login (an Admin user: the route is the Settings area's). */
export async function runConsoleTool(
  who: { brainId: string; loginId: string },
  tool: Tool,
  input: Record<string, unknown>,
): Promise<ToolHandlerResult> {
  const prepared = await prepareCallerTools({
    role: 'admin',
    anchorId: who.brainId,
    loginId: who.loginId,
    via: 'oauth',
    write: true,
  });
  return dispatchTool(tool, input, {
    ownerId: who.brainId,
    surface: { kind: 'owner', via: 'mcp', loginId: who.loginId },
    caller: mcpToolCaller(mcpGateCaller(prepared)),
  });
}
