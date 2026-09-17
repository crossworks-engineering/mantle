/**
 * Tests for node_share / node_unshare — the generic, type-agnostic sharing
 * pair. Until now neither had a behavioural test, which is a poor place for
 * that gap: these are the two tools that decide whether brain content is
 * reachable by someone with no login at all.
 *
 * The DB edges (createShare / applyShareMode / getActiveShareForNode /
 * revokeShareTree) are stubbed; the tools' own logic is real. What is worth
 * pinning is the branching, because each branch is a different answer to
 * "who can now read this":
 *
 *  - an unrecognised `mode` must NOT fall through to public;
 *  - unsharing something that was never shared must not call revoke at all;
 *  - a refused share (not owned / not a shareable type) must surface the
 *    store's own corrective rather than a generic failure.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', () => ({
  createShare: vi.fn(),
  applyShareMode: vi.fn(),
  getActiveShareForNode: vi.fn(),
  revokeShareTree: vi.fn(),
  shareUrlForToken: (token: string) => `https://brain.test/s/${token}`,
}));

import {
  createShare,
  applyShareMode,
  getActiveShareForNode,
  revokeShareTree,
} from '@mantle/content';
import { SHARE_TOOLS } from './builtins-share';
import type { ToolHandlerContext } from './types';

const share = SHARE_TOOLS.find((t) => t.slug === 'node_share')!;
const unshare = SHARE_TOOLS.find((t) => t.slug === 'node_unshare')!;
const ctx: ToolHandlerContext = { ownerId: 'o1' };
const NODE_ID = 'n-1';

type Result = Awaited<ReturnType<(typeof share)['handler']>>;

/** Narrow to the failure arm, asserting it IS one — an unexpected success
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
  } as unknown as Awaited<ReturnType<typeof createShare>>);
});

describe('node_share', () => {
  it('is confirm-gated — it publishes brain content outward-facing', () => {
    // The gate is the only thing standing between an agent deciding to share
    // and a public URL existing. Pin it here so removing it fails a test.
    expect(share.requiresConfirm).toBe(true);
  });

  it('refuses a blank id WITHOUT creating a share', async () => {
    const res = await share.handler({ id: '   ' }, ctx);
    expect(errorOf(res)).toMatch(/id is required/);
    expect(createShare).not.toHaveBeenCalled();
  });

  it('creates the link and returns the store’s mode when none is asked for', async () => {
    const res = await share.handler({ id: NODE_ID }, ctx);
    expect(outputOf(res)).toEqual({
      id: NODE_ID,
      url: 'https://brain.test/s/tok',
      mode: 'public',
    });
    // No mode requested means no mode WRITE — an existing team link keeps its
    // setting instead of being quietly reset.
    expect(applyShareMode).not.toHaveBeenCalled();
  });

  it('applies an explicit team mode and reports it', async () => {
    const res = await share.handler({ id: NODE_ID, mode: 'team' }, ctx);
    expect(applyShareMode).toHaveBeenCalledWith('o1', 's-1', 'team');
    expect(outputOf(res).mode).toBe('team');
  });

  it('treats an unrecognised mode as "unspecified", never as public', async () => {
    // The guard is `input.mode === 'team' ? … : input.mode === 'public' ? … :
    // undefined`. A typo like 'everyone' must fall to undefined — which leaves
    // the link's current setting alone — and must NOT be coerced to public,
    // which would silently widen access on an existing team link.
    vi.mocked(createShare).mockResolvedValue({
      id: 's-1',
      token: 'tok',
      mode: 'team',
    } as unknown as Awaited<ReturnType<typeof createShare>>);

    const res = await share.handler({ id: NODE_ID, mode: 'everyone' }, ctx);
    expect(applyShareMode).not.toHaveBeenCalled();
    expect(outputOf(res).mode).toBe('team');
  });

  it('surfaces the store’s own corrective when the item is not shareable', async () => {
    vi.mocked(createShare).mockRejectedValue(new Error("type 'email' is not shareable"));
    const res = await share.handler({ id: NODE_ID }, ctx);
    // Verbatim, because the message names the actual reason and the model can
    // act on it; a generic "share failed" cannot be acted on.
    expect(errorOf(res)).toBe("type 'email' is not shareable");
  });
});

describe('node_unshare', () => {
  it('refuses a blank id WITHOUT touching any share', async () => {
    const res = await unshare.handler({ id: '  ' }, ctx);
    expect(errorOf(res)).toMatch(/id is required/);
    expect(getActiveShareForNode).not.toHaveBeenCalled();
    expect(revokeShareTree).not.toHaveBeenCalled();
  });

  it('is a no-op success when the item was never shared', async () => {
    vi.mocked(getActiveShareForNode).mockResolvedValue(null);
    const res = await unshare.handler({ id: NODE_ID }, ctx);
    expect(outputOf(res)).toEqual({ id: NODE_ID, unshared: false });
    // Nothing to revoke — and revoking "nothing" must not reach the tree
    // walker, which is what would make an unshare of an unshared node
    // expensive (or, on a bad id, wrong).
    expect(revokeShareTree).not.toHaveBeenCalled();
  });

  it('revokes the active share by its share id, not the node id', async () => {
    vi.mocked(getActiveShareForNode).mockResolvedValue({ id: 's-9' } as unknown as Awaited<
      ReturnType<typeof getActiveShareForNode>
    >);
    vi.mocked(revokeShareTree).mockResolvedValue(true);

    const res = await unshare.handler({ id: NODE_ID }, ctx);
    // Passing the node id here would revoke nothing (or the wrong tree) while
    // still reporting success — the failure this asserts against.
    expect(revokeShareTree).toHaveBeenCalledWith('o1', 's-9');
    expect(outputOf(res)).toEqual({ id: NODE_ID, unshared: true });
  });

  it('reports unshared:false when the store declined to revoke', async () => {
    vi.mocked(getActiveShareForNode).mockResolvedValue({ id: 's-9' } as unknown as Awaited<
      ReturnType<typeof getActiveShareForNode>
    >);
    vi.mocked(revokeShareTree).mockResolvedValue(false);

    const res = await unshare.handler({ id: NODE_ID }, ctx);
    // Still ok:true — the call worked — but the caller must be able to tell
    // that the link may still be live.
    expect(outputOf(res)).toEqual({ id: NODE_ID, unshared: false });
  });

  it('surfaces a revoke failure rather than reporting success', async () => {
    vi.mocked(getActiveShareForNode).mockRejectedValue(new Error('db down'));
    const res = await unshare.handler({ id: NODE_ID }, ctx);
    expect(errorOf(res)).toBe('db down');
  });
});
