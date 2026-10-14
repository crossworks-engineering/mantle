/**
 * The egress proof table for the federation client (A10 part 1,
 * docs/egress.md): a peer's base URL is one the owner configured, and a
 * linked brain on a private or tailnet address is legitimate. Same seven
 * cells as packages/tools/src/egress-proof.test.ts, on the fake network of
 * @mantle/std/egress-test-net; the peer rows are stubbed, the client is the
 * real one.
 *
 * Recorded on the sources before the move (__snapshots__/peers-egress-proof.before.json).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const peer = vi.hoisted(() => ({ baseUrl: '' }));
vi.mock('./peers', () => ({
  listPeers: async () => [
    {
      id: 'p1',
      displayName: 'Linked brain',
      baseUrl: peer.baseUrl,
      enabled: true,
      status: 'active',
    },
  ],
  getOutboundToken: async () => 'peer-token-SECRET',
  markPeerContacted: async () => {},
}));
vi.mock(
  'node:dns/promises',
  async () => (await import('@mantle/std/egress-test-net')).testNetDnsModule,
);

import { runEgressRow } from '@mantle/std/egress-test-net';
import { queryPeer } from './peers-client';

afterEach(() => vi.unstubAllGlobals());

describe('egress proof table: the federation client', () => {
  it('answers each cell as recorded', { timeout: 120_000 }, async () => {
    const row = await runEgressRow(
      JSON.stringify({ nodes: [{ id: 'n1' }], count: 1 }),
      'application/json',
      async (base) => {
        peer.baseUrl = base;
        const r = await queryPeer('owner', 'p1', { query: 'x' });
        return r.ok ? `ok, ${r.data.count} nodes` : `error: ${r.error.slice(0, 160)}`;
      },
      {
        stubFetch: (f) => vi.stubGlobal('fetch', f),
        timers: {
          useFakeTimers: () => vi.useFakeTimers(),
          useRealTimers: () => vi.useRealTimers(),
          advanceTimersByTimeAsync: (ms) => vi.advanceTimersByTimeAsync(ms),
        },
      },
    );
    await expect(
      JSON.stringify({ 'federation client (peer_query)': row }, null, 1) + '\n',
    ).toMatchFileSnapshot('./__snapshots__/peers-egress-proof.before.json');
  });
});
