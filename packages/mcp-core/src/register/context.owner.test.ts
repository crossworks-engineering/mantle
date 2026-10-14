/**
 * The MCP server runs every bridged builtin for the OWNER, and says so
 * (client logins C4, plan section 8). Through dispatch and the one gate
 * since A5 step 4 (ownerOnly refuses anyone but the owner there too); since
 * C4 a missing surface is not the owner, and an MCP call that forgot its
 * surface would be refused by every owner-only tool.
 */
import { describe, expect, it, vi } from 'vitest';

// No database: the brain reads as not on workspaces, so the anchor's call
// runs as is (mcp-scope.ts).
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  brainOnWorkspacesNow: async () => false,
}));

import {
  isOwnerSurface,
  ownerKeysOff,
  registerBuiltin,
  type BuiltinToolDef,
  type ToolHandlerContext,
} from '@mantle/tools';
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
      policy: { effect: 'write', spends: 'none', scope: 'any' },
      ownerOnly: true,
      handler,
    } as BuiltinToolDef;
    registerBuiltin(def);
    const ctx = makeRegisterContext({} as never, 'owner-1', 'http');
    await ctx.callBuiltin(def, {});
    const got = handler.mock.calls[0]![1];
    expect({ ownerId: got.ownerId, surface: got.surface }).toEqual({
      ownerId: 'owner-1',
      surface: { kind: 'owner', via: 'mcp' },
    });
    expect(isOwnerSurface(got.surface)).toBe(true);
    expect(MCP_OWNER_SURFACE).toEqual({ kind: 'owner', via: 'mcp' });
  });

  // W7b fix round 3: a peer bound to an admin login that is not the owner's
  // own peer names no login to the builtins (registerPreparedTools), and its
  // channel, with `ownerKeysOff`, must still reach them.
  it('with no login, the MCP channel still reaches the handler', async () => {
    const handler = vi.fn(async (_i: Record<string, unknown>, _c: ToolHandlerContext) => ({
      ok: true as const,
      output: 'ran',
    }));
    const def = {
      slug: 'probe',
      name: 'probe',
      description: 'probe',
      inputSchema: { type: 'object', properties: {} },
      policy: { effect: 'write', spends: 'none', scope: 'any' },
      handler,
    } as BuiltinToolDef;
    registerBuiltin(def);
    const mcp = { via: 'peer' as const, write: true, peerId: 'peer-1', ownerKeysOff: true };
    const ctx = makeRegisterContext({} as never, 'owner-1', 'http', 'federation', undefined, mcp);
    await ctx.callBuiltin(def, {});
    const got = handler.mock.calls[0]![1];
    expect(got.surface).toEqual({ kind: 'owner', via: 'federation', mcp });
    expect(ownerKeysOff(got)).toBe(true);
    // The same over 'mcp' (no constant shared object is changed).
    const ctx2 = makeRegisterContext({} as never, 'owner-1', 'http', 'mcp', undefined, mcp);
    await ctx2.callBuiltin(def, {});
    expect(handler.mock.calls[1]![1].surface).toEqual({ kind: 'owner', via: 'mcp', mcp });
    expect(MCP_OWNER_SURFACE).toEqual({ kind: 'owner', via: 'mcp' });
  });
});
