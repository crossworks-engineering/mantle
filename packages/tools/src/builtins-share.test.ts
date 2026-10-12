/**
 * Tests for node_share / node_unshare: the generic, type-agnostic sharing
 * pair: the two tools that decide whether brain content is reachable by
 * someone with no login at all.
 *
 * The DB edges (createShare / getActiveShareForNode / revokeShare and the
 * link checks assertMayLink / checkServeList) are stubbed; the tools' own
 * logic is real. What is worth pinning is the branching, because each branch
 * is a different answer to "who can now read this":
 *
 *  - team links are retired (member logins Phase 6 stage 6): `mode: 'team'`
 *    is refused with what to do instead, and nothing is created;
 *  - an unrecognised `mode` must NOT fall through to public;
 *  - who may link is checked before anything is written (plan 8.1), and a
 *    `serve` list goes through its checks before it is stored;
 *  - unsharing something that was never shared must not call revoke at all;
 *  - a refused share (not owned / not a shareable type) must surface the
 *    store's own corrective rather than a generic failure.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', () => {
  class LinkRefusedError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    createShare: vi.fn(),
    getActiveShareForNode: vi.fn(),
    revokeShare: vi.fn(),
    assertMayLink: vi.fn(),
    checkServeList: vi.fn(),
    LinkRefusedError,
    shareUrlForToken: (token: string) => `https://brain.test/s/${token}`,
    TeamLinkRetiredError: class extends Error {
      constructor() {
        super('Team links are retired: members sign in with their own logins now.');
      }
    },
  };
});

import {
  assertMayLink,
  checkServeList,
  createShare,
  getActiveShareForNode,
  LinkRefusedError,
  revokeShare,
} from '@mantle/content';
import { SHARE_TOOLS } from './builtins-share';
import type { ToolHandlerContext } from './types';

const share = SHARE_TOOLS.find((t) => t.slug === 'node_share')!;
const unshare = SHARE_TOOLS.find((t) => t.slug === 'node_unshare')!;
const ctx: ToolHandlerContext = { ownerId: 'o1' };
const NODE_ID = 'n-1';
const ITEM = { id: NODE_ID, type: 'note', path: null, read: true, edit: true, manage: true };

type Result = Awaited<ReturnType<(typeof share)['handler']>>;

/** Narrow to the failure arm, asserting it IS one: an unexpected success
 *  fails here rather than silently skipping the assertions after it. */
function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createShare).mockResolvedValue({
    id: 's-1',
    token: 'tok',
    mode: 'public',
    served: [],
  } as unknown as Awaited<ReturnType<typeof createShare>>);
  vi.mocked(assertMayLink).mockResolvedValue(ITEM);
  vi.mocked(getActiveShareForNode).mockResolvedValue(null);
  vi.mocked(checkServeList).mockImplementation(async (_o, _l, _i, serve) => [...serve]);
});

describe('node_share', () => {
  it('is confirm-gated: it publishes brain content outward-facing', () => {
    // The gate is the only thing standing between an agent deciding to share
    // and a public URL existing. Pin it here so removing it fails a test.
    expect(share.requiresConfirm).toBe(true);
  });

  it('refuses a blank id WITHOUT creating a share', async () => {
    const res = await share.handler({ id: '   ' }, ctx);
    expect(errorOf(res)).toMatch(/id is required/);
    expect(createShare).not.toHaveBeenCalled();
  });

  it('creates the link as the owner, its list untouched, and returns the store’s mode', async () => {
    for (const input of [{ id: NODE_ID }, { id: NODE_ID, mode: 'public' }]) {
      const res = await share.handler(input, ctx);
      expect(outputOf(res)).toEqual({
        id: NODE_ID,
        url: 'https://brain.test/s/tok',
        mode: 'public',
        served: [],
      });
    }
    expect(assertMayLink).toHaveBeenCalledWith('o1', 'o1', NODE_ID);
    expect(createShare).toHaveBeenCalledTimes(2);
    expect(createShare).toHaveBeenCalledWith('o1', NODE_ID, { serve: undefined });
    expect(checkServeList).not.toHaveBeenCalled();
  });

  it('checks a serve list against what the link already serves, then stores it', async () => {
    vi.mocked(getActiveShareForNode).mockResolvedValue({
      id: 's-1',
      served: ['f-old'],
    } as never);
    await share.handler({ id: NODE_ID, serve: ['f-1', 'f-old'] }, ctx);
    expect(checkServeList).toHaveBeenCalledWith('o1', 'o1', ITEM, ['f-1', 'f-old'], ['f-old']);
    expect(createShare).toHaveBeenCalledWith('o1', NODE_ID, { serve: ['f-1', 'f-old'] });
  });

  it('refuses a serve that is not a list of ids, creating nothing', async () => {
    const res = await share.handler({ id: NODE_ID, serve: 'f-1' }, ctx);
    expect(errorOf(res)).toMatch(/serve must be a list/);
    expect(createShare).not.toHaveBeenCalled();
  });

  it('refuses a caller who may not link, creating nothing; an unreadable item is not found', async () => {
    vi.mocked(assertMayLink).mockRejectedValueOnce(
      new LinkRefusedError(
        403,
        'forbidden',
        'Only someone who may edit this item may open or close its link.',
      ),
    );
    expect(errorOf(await share.handler({ id: NODE_ID }, ctx))).toMatch(/may edit this item/);
    vi.mocked(assertMayLink).mockRejectedValueOnce(
      new LinkRefusedError(404, 'not_found', 'Item not found.'),
    );
    expect(errorOf(await share.handler({ id: NODE_ID }, ctx))).toMatch(/not found/);
    expect(createShare).not.toHaveBeenCalled();
  });

  it('refuses a serve id it may not add, creating nothing', async () => {
    vi.mocked(checkServeList).mockRejectedValueOnce(
      new LinkRefusedError(
        403,
        'forbidden',
        'A link serves only items its item names or embeds that you may edit.',
      ),
    );
    const res = await share.handler({ id: NODE_ID, serve: ['x'] }, ctx);
    expect(errorOf(res)).toMatch(/names or embeds/);
    expect(createShare).not.toHaveBeenCalled();
  });

  it('refuses a team link, saying members use their own logins, and creates nothing', async () => {
    const res = await share.handler({ id: NODE_ID, mode: 'team' }, ctx);
    expect(errorOf(res)).toMatch(/Team links are retired.*own logins/);
    expect(createShare).not.toHaveBeenCalled();
    expect(
      (share.inputSchema as { properties: Record<string, unknown> }).properties.mode,
    ).toMatchObject({ enum: ['public'] });
  });

  it('refuses an unrecognised mode, never reading it as public', async () => {
    const res = await share.handler({ id: NODE_ID, mode: 'everyone' }, ctx);
    expect(errorOf(res)).toMatch(/mode must be 'public'/);
    expect(createShare).not.toHaveBeenCalled();
  });

  it('says nothing about levels', async () => {
    const out = outputOf(await share.handler({ id: NODE_ID }, ctx));
    expect(out).not.toHaveProperty('warning');
    expect(out).not.toHaveProperty('alsoLowered');
  });

  it('surfaces the store’s own corrective when the item is not shareable', async () => {
    vi.mocked(createShare).mockRejectedValue(new Error("type 'email' is not shareable"));
    const res = await share.handler({ id: NODE_ID }, ctx);
    // Verbatim, because the message names the actual reason and the model can
    // act on it; a generic "share failed" cannot be acted on.
    expect(errorOf(res)).toBe("type 'email' is not shareable");
  });
});

describe('the share tools act as the CALLING login (audit 2026-10-12)', () => {
  // A login on MCP is not the brain's owner: who may link an item and what
  // its served list may hold are the caller's rights, never the owner's.
  const mcp: ToolHandlerContext = {
    ownerId: 'o1',
    surface: { kind: 'owner', via: 'mcp', loginId: 'login-2' },
  };

  it('node_share checks the link and the serve list as the caller', async () => {
    await share.handler({ id: NODE_ID, serve: ['f-1'] }, mcp);
    expect(assertMayLink).toHaveBeenCalledWith('o1', 'login-2', NODE_ID);
    expect(checkServeList).toHaveBeenCalledWith('o1', 'login-2', ITEM, ['f-1'], []);
  });

  it('node_unshare checks the link as the caller', async () => {
    vi.mocked(getActiveShareForNode).mockResolvedValue({ id: 's-9' } as never);
    vi.mocked(revokeShare).mockResolvedValue(true);
    await unshare.handler({ id: NODE_ID }, mcp);
    expect(assertMayLink).toHaveBeenCalledWith('o1', 'login-2', NODE_ID);
  });

  it('a member login’s turn links as that member', async () => {
    const team: ToolHandlerContext = {
      ownerId: 'o1',
      surface: { kind: 'team', loginId: 'member-3' },
    };
    await share.handler({ id: NODE_ID }, team);
    expect(assertMayLink).toHaveBeenCalledWith('o1', 'member-3', NODE_ID);
  });

  it('a surface that names no login of its own never links as the owner', async () => {
    for (const surface of [
      { kind: 'team' as const, contactId: 'c-1' },
      { kind: 'contact' as const, contactId: 'c-1', shareId: 's-1' },
    ]) {
      const res = await share.handler({ id: NODE_ID }, { ownerId: 'o1', surface });
      expect(errorOf(res)).toMatch(/signed-in login/);
    }
    expect(assertMayLink).not.toHaveBeenCalled();
    expect(createShare).not.toHaveBeenCalled();
  });
});

describe('node_unshare', () => {
  it('refuses a blank id WITHOUT touching any share', async () => {
    const res = await unshare.handler({ id: '  ' }, ctx);
    expect(errorOf(res)).toMatch(/id is required/);
    expect(getActiveShareForNode).not.toHaveBeenCalled();
    expect(revokeShare).not.toHaveBeenCalled();
  });

  it('is a no-op success when the item was never shared', async () => {
    vi.mocked(getActiveShareForNode).mockResolvedValue(null);
    const res = await unshare.handler({ id: NODE_ID }, ctx);
    expect(outputOf(res)).toEqual({ id: NODE_ID, unshared: false });
    expect(revokeShare).not.toHaveBeenCalled();
  });

  it('revokes the active share by its share id, not the node id, after the link check', async () => {
    vi.mocked(getActiveShareForNode).mockResolvedValue({ id: 's-9' } as unknown as Awaited<
      ReturnType<typeof getActiveShareForNode>
    >);
    vi.mocked(revokeShare).mockResolvedValue(true);

    const res = await unshare.handler({ id: NODE_ID }, ctx);
    // Passing the node id here would revoke nothing while still reporting
    // success: the failure this asserts against.
    expect(assertMayLink).toHaveBeenCalledWith('o1', 'o1', NODE_ID);
    expect(revokeShare).toHaveBeenCalledWith('o1', 's-9');
    expect(outputOf(res)).toEqual({ id: NODE_ID, unshared: true });
  });

  it('reports unshared:false when the store declined to revoke', async () => {
    vi.mocked(getActiveShareForNode).mockResolvedValue({ id: 's-9' } as unknown as Awaited<
      ReturnType<typeof getActiveShareForNode>
    >);
    vi.mocked(revokeShare).mockResolvedValue(false);

    const res = await unshare.handler({ id: NODE_ID }, ctx);
    // Still ok:true (the call worked), but the caller must be able to tell
    // that the link may still be live.
    expect(outputOf(res)).toEqual({ id: NODE_ID, unshared: false });
  });

  it('keeps the link when the caller may not close it', async () => {
    vi.mocked(getActiveShareForNode).mockResolvedValue({ id: 's-9' } as never);
    vi.mocked(assertMayLink).mockRejectedValueOnce(
      new LinkRefusedError(
        403,
        'forbidden',
        'Only someone who may edit this item may open or close its link.',
      ),
    );
    expect(errorOf(await unshare.handler({ id: NODE_ID }, ctx))).toMatch(/may edit this item/);
    expect(revokeShare).not.toHaveBeenCalled();
  });

  it('surfaces a revoke failure rather than reporting success', async () => {
    vi.mocked(getActiveShareForNode).mockRejectedValue(new Error('db down'));
    const res = await unshare.handler({ id: NODE_ID }, ctx);
    expect(errorOf(res)).toBe('db down');
  });
});
