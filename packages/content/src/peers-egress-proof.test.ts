/**
 * The egress proof table for the federation client (A10 part 1,
 * docs/egress.md): a peer's base URL is one the owner configured, and a
 * linked brain on a private or tailnet address is legitimate. Same seven
 * cells as packages/tools/src/egress-proof.test.ts, on the fake network of
 * @mantle/std/egress-test-net; the peer rows are stubbed, the client is the
 * real one.
 *
 * Record, move, compare: recorded on the sources before the move
 * (__snapshots__/peers-egress-proof.before.json, never rewritten); after the
 * move it must equal that but for the NAMED changes below
 * (__snapshots__/peers-egress-proof.after.json). A peer on a private IP or a
 * name resolving to loopback answers as before (allowLan).
 */
import { readFileSync } from 'node:fs';
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

import {
  runEgressRow,
  withNamedChanges,
  type EgressTable,
  type NamedChanges,
} from '@mantle/std/egress-test-net';
import { queryPeer } from './peers-client';

afterEach(() => vi.unstubAllGlobals());

const ROW = 'federation client (peer_query)';

/** The named changes: a redirect into link-local space (the metadata
 *  address) is refused, and a reply over the 32 MB cap is not read (before,
 *  the whole body was read and the parse failure read as "no nodes"). */
const NAMED: NamedChanges = {
  [ROW]: {
    'redirect to 169.254.169.254': {
      answer:
        'error: Could not reach Linked brain (https://meta-redirect.test): refusing to fetch a private/internal address (169.254.169.254)',
      reached: ['meta-redirect.test'],
    },
    'oversized body': {
      answer:
        'error: Could not reach Linked brain (https://huge.test): response body is over the 33554432-byte cap',
      oversizedRead: 'stopped at 32 MB',
    },
  },
};

describe('egress proof table: the federation client', () => {
  it(
    'answers each cell as before the move, but for the named changes',
    { timeout: 120_000 },
    async () => {
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
      const table: EgressTable = { [ROW]: row };
      const before = JSON.parse(
        readFileSync(
          new URL('./__snapshots__/peers-egress-proof.before.json', import.meta.url),
          'utf8',
        ),
      ) as EgressTable;
      expect(table).toEqual(withNamedChanges(before, NAMED));
      await expect(JSON.stringify(table, null, 1) + '\n').toMatchFileSnapshot(
        './__snapshots__/peers-egress-proof.after.json',
      );
    },
  );
});
