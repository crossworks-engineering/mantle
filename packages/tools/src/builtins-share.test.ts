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
    getPage: vi.fn(),
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

const area = vi.hoisted(() => ({ scope: false, users: false }));
vi.mock('./admin-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./admin-gate')>()),
  callerScope: () => (area.scope ? { kind: 'user', loginId: 'login-2', ws: [], modWs: [] } : null),
  callerHasArea: async (a: string) => a === 'users' && area.users,
}));

import {
  assertMayLink,
  checkServeList,
  createShare,
  getActiveShareForNode,
  getPage,
  LinkRefusedError,
  revokeShare,
} from '@mantle/content';
import { SHARE_TOOLS } from './builtins-share';
import { page_share as pageShare, page_unshare as pageUnshare } from './pages/sharing';
import { childSurface } from './builtins-delegation';
import type { ToolHandlerContext } from './types';

const share = SHARE_TOOLS.find((t) => t.slug === 'node_share')!;
const unshare = SHARE_TOOLS.find((t) => t.slug === 'node_unshare')!;
// The owner's own path that names no login (stdio MCP): the one surface
// that links as the brain owner. A missing surface is not the owner (M2).
const ctx: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'owner', via: 'mcp' } };
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
  vi.mocked(getPage).mockResolvedValue({ id: NODE_ID, title: 'P' } as never);
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

describe('which login a link is opened as (A0 fix round, M1 M2 L5)', () => {
  const refused = /signed-in login/;

  it('a missing surface is not the owner: refused, nothing checked or written', async () => {
    const res = await share.handler({ id: NODE_ID }, { ownerId: 'o1' });
    expect(errorOf(res)).toMatch(refused);
    const off = await unshare.handler({ id: NODE_ID }, { ownerId: 'o1' });
    expect(errorOf(off)).toMatch(refused);
    expect(assertMayLink).not.toHaveBeenCalled();
    expect(getActiveShareForNode).not.toHaveBeenCalled();
    expect(createShare).not.toHaveBeenCalled();
  });

  it('a delegated child links as its parent login, never as the owner', async () => {
    const parent = { kind: 'web' as const, loginId: 'login-7' };
    const surface = childSurface(parent);
    expect(surface).toEqual({ kind: 'owner', via: 'delegate', loginId: 'login-7' });
    await share.handler({ id: NODE_ID }, { ownerId: 'o1', surface });
    expect(assertMayLink).toHaveBeenCalledWith('o1', 'login-7', NODE_ID);
  });

  it("a run's surface links as the run's login; a run with no login as the owner", async () => {
    await share.handler(
      { id: NODE_ID },
      { ownerId: 'o1', surface: { kind: 'owner', via: 'run', loginId: 'login-8' } },
    );
    expect(assertMayLink).toHaveBeenLastCalledWith('o1', 'login-8', NODE_ID);
    await share.handler({ id: NODE_ID }, { ownerId: 'o1', surface: { kind: 'owner', via: 'run' } });
    expect(assertMayLink).toHaveBeenLastCalledWith('o1', 'o1', NODE_ID);
  });

  it('an MCP connection that names no login (a peer bound to an Admin login) is refused', async () => {
    const surface = {
      kind: 'owner' as const,
      via: 'federation' as const,
      mcp: { via: 'peer' as const, write: true, peerId: 'p-1' },
    };
    expect(errorOf(await share.handler({ id: NODE_ID }, { ownerId: 'o1', surface }))).toMatch(
      refused,
    );
    expect(errorOf(await unshare.handler({ id: NODE_ID }, { ownerId: 'o1', surface }))).toMatch(
      refused,
    );
    expect(assertMayLink).not.toHaveBeenCalled();
  });

  it('a chat that names no login is refused, never read as the owner', async () => {
    for (const surface of [
      { kind: 'web' as const },
      { kind: 'telegram' as const, telegramChatId: '1' },
    ]) {
      expect(errorOf(await share.handler({ id: NODE_ID }, { ownerId: 'o1', surface }))).toMatch(
        refused,
      );
    }
    expect(assertMayLink).not.toHaveBeenCalled();
  });

  it('page_share and page_unshare check the link as the caller', async () => {
    const mcp: ToolHandlerContext = {
      ownerId: 'o1',
      surface: { kind: 'owner', via: 'mcp', loginId: 'login-2' },
    };
    await pageShare.handler({ id: NODE_ID }, mcp);
    expect(assertMayLink).toHaveBeenLastCalledWith('o1', 'login-2', NODE_ID);
    vi.mocked(getActiveShareForNode).mockResolvedValue({ id: 's-9' } as never);
    vi.mocked(revokeShare).mockResolvedValue(true);
    await pageUnshare.handler({ id: NODE_ID }, mcp);
    expect(assertMayLink).toHaveBeenLastCalledWith('o1', 'login-2', NODE_ID);
    expect(errorOf(await pageShare.handler({ id: NODE_ID }, { ownerId: 'o1' }))).toMatch(refused);
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

  it('says nothing about a link on an item the caller may not link (L4)', async () => {
    // An item with no link and an item with one answer the same refusal:
    // the rights check runs before the link is looked up.
    vi.mocked(assertMayLink).mockRejectedValue(
      new LinkRefusedError(404, 'not_found', 'Item not found.'),
    );
    for (const active of [null, { id: 's-9' }]) {
      vi.mocked(getActiveShareForNode).mockResolvedValue(active as never);
      expect(errorOf(await unshare.handler({ id: NODE_ID }, ctx))).toMatch(/not found/);
    }
    expect(getActiveShareForNode).not.toHaveBeenCalled();
    expect(revokeShare).not.toHaveBeenCalled();
  });

  it('an Admin user with the users area closes a link it may not edit; nobody else (A0)', async () => {
    vi.mocked(getActiveShareForNode).mockResolvedValue({ id: 's-9' } as never);
    vi.mocked(revokeShare).mockResolvedValue(true);
    vi.mocked(assertMayLink).mockRejectedValue(
      new LinkRefusedError(404, 'not_found', 'Item not found.'),
    );
    const admin: ToolHandlerContext = {
      ownerId: 'o1',
      surface: { kind: 'owner', via: 'mcp', loginId: 'login-2' },
    };
    const member: ToolHandlerContext = {
      ownerId: 'o1',
      surface: { kind: 'team', loginId: 'member-3' },
    };
    try {
      area.scope = true;
      area.users = false;
      expect(errorOf(await unshare.handler({ id: NODE_ID }, admin))).toMatch(/not found/);
      area.users = true;
      expect(errorOf(await unshare.handler({ id: NODE_ID }, member))).toMatch(/not found/);
      expect(revokeShare).not.toHaveBeenCalled();
      expect(outputOf(await unshare.handler({ id: NODE_ID }, admin))).toEqual({
        id: NODE_ID,
        unshared: true,
      });
      // Opening one is not closing: still refused.
      expect(errorOf(await share.handler({ id: NODE_ID }, admin))).toMatch(/not found/);
    } finally {
      area.scope = false;
      area.users = false;
    }
  });

  it('surfaces a revoke failure rather than reporting success', async () => {
    vi.mocked(getActiveShareForNode).mockRejectedValue(new Error('db down'));
    const res = await unshare.handler({ id: NODE_ID }, ctx);
    expect(errorOf(res)).toBe('db down');
  });
});
