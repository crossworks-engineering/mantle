import { describe, expect, it, vi } from 'vitest';

const spill = vi.hoisted(() =>
  vi.fn(async () => ({ spilled: true, handle: 'h', bytes: 1, payload: 'x' })),
);
vi.mock('@mantle/tools', async (orig) => ({
  ...(await orig<typeof import('@mantle/tools')>()),
  processToolResultForModel: spill,
}));

import { toolResultPayload } from './execute-call';
import type { TurnGuards } from './guards';

/** Audit S3: a member's private item is never spilled to the tool-result
 *  store (it outlives the turn, and the trace would carry its handle). */
describe('toolResultPayload and private tools', () => {
  const guards = { recordFailure: () => 1, recordResult: () => {} } as unknown as TurnGuards;
  const big = { ok: true as const, output: { text: 'x'.repeat(5_000) } };
  const call = (slug: string) =>
    toolResultPayload({
      outcome: big,
      slug,
      guardSig: slug,
      guards,
      ownerId: 'o',
      handling: { inlineMaxBytes: 1_000 } as Parameters<typeof toolResultPayload>[0]['handling'],
    });

  it('keeps a my-space result inline, whatever its size', async () => {
    const out = await call('my_item_open');
    expect(out).toContain('xxxx');
    expect(spill).not.toHaveBeenCalled();
  });

  it('still spills any other big result', async () => {
    await call('page_get');
    expect(spill).toHaveBeenCalledTimes(1);
  });
});
