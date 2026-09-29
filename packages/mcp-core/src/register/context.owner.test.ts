/**
 * The MCP server runs every bridged builtin for the OWNER, and says so
 * (client logins C4, plan section 8). It calls `def.handler` directly, not
 * dispatchTool, so the handler's own owner check is what applies here; since
 * C4 a missing surface is not the owner, and an MCP call that forgot its
 * surface would be refused by every owner-only tool.
 */
import { describe, expect, it, vi } from 'vitest';
import { isOwnerSurface, type BuiltinToolDef, type ToolHandlerContext } from '@mantle/tools';
import { makeRegisterContext, MCP_OWNER_SURFACE } from './context';

describe('MCP builtin calls carry the owner surface', () => {
  it('callBuiltin hands the handler owner/mcp', async () => {
    const handler = vi.fn(async (_i: Record<string, unknown>, _c: ToolHandlerContext) => ({
      ok: true as const,
      output: 'ran',
    }));
    const def = {
      slug: 'probe',
      name: 'probe',
      description: 'probe',
      inputSchema: { type: 'object', properties: {} },
      ownerOnly: true,
      handler,
    } as BuiltinToolDef;
    const ctx = makeRegisterContext({} as never, 'owner-1', 'http');
    await ctx.callBuiltin(def, {});
    const got = handler.mock.calls[0]![1];
    expect(got).toEqual({ ownerId: 'owner-1', surface: { kind: 'owner', via: 'mcp' } });
    expect(isOwnerSurface(got.surface)).toBe(true);
    expect(MCP_OWNER_SURFACE).toEqual({ kind: 'owner', via: 'mcp' });
  });
});
