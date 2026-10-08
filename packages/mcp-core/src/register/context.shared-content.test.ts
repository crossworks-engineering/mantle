/**
 * A caller that cannot confirm never changes the content of an item others
 * can read: what the edit embeds would become readable to them (M2 audit N3).
 * An API key (via 'api') was held to it; a peer acting as the owner (via
 * 'federation') was not (access matrix M3). Both are now; the owner's own MCP
 * connection is not touched by this rule.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuiltinToolDef, OwnerSurfaceVia, ToolHandlerContext } from '@mantle/tools';

const shared = vi.hoisted(() => ({ othersCanRead: vi.fn(async () => true) }));
vi.mock('../shared-item', () => shared);

import { makeRegisterContext } from './context';

const PAGE = '11111111-2222-4333-8444-555555555555';

function pageUpdate() {
  const handler = vi.fn(async (_i: Record<string, unknown>, _c: ToolHandlerContext) => ({
    ok: true as const,
    output: 'updated',
  }));
  const def = {
    slug: 'page_update',
    name: 'page_update',
    description: 'probe',
    inputSchema: { type: 'object', properties: {} },
    handler,
  } as BuiltinToolDef;
  return { def, handler };
}

async function call(via: OwnerSurfaceVia, input: Record<string, unknown>) {
  const { def, handler } = pageUpdate();
  const ctx = makeRegisterContext({} as never, 'owner-1', 'http', via);
  const res = (await ctx.callBuiltin(def, input)) as {
    isError?: boolean;
    content: { text: string }[];
  };
  return { res, handler };
}

describe('content edits on a shared item', () => {
  beforeEach(() => shared.othersCanRead.mockReset().mockResolvedValue(true));

  it('refuses a peer acting as the owner, like a key', async () => {
    for (const via of ['federation', 'api'] as const) {
      const { res, handler } = await call(via, { page_id: PAGE, markdown: 'x' });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(/is shared/);
      expect(handler).not.toHaveBeenCalled();
    }
    expect(shared.othersCanRead).toHaveBeenCalledWith('owner-1', PAGE);
  });

  it('refuses a peer an id that is not a UUID', async () => {
    const { res, handler } = await call('federation', { page_id: 'not-a-uuid' });
    expect(res.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('lets a peer edit an item only the admin can read', async () => {
    shared.othersCanRead.mockResolvedValue(false);
    const { res, handler } = await call('federation', { page_id: ` ${PAGE} ` });
    expect(res.isError).toBeUndefined();
    expect(handler.mock.calls[0]![0].page_id).toBe(PAGE);
  });

  it('leaves the owner MCP connection alone', async () => {
    const { res, handler } = await call('mcp', { page_id: PAGE });
    expect(res.isError).toBeUndefined();
    expect(handler).toHaveBeenCalled();
    expect(shared.othersCanRead).not.toHaveBeenCalled();
  });
});
