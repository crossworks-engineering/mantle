import { describe, expect, it } from 'vitest';
import * as peersApi from './peers';

/**
 * `@mantle/content/peers` is a PUBLIC package sub-path (see package.json
 * `exports`), and it is the federation boundary: everything here decides what
 * another sovereign Mantle is allowed to read from this one.
 *
 * The 2026-09-02 split of the 787-line peers.ts into peers/{registry,grants,
 * query}.ts forced two row mappers — `toTypeShareRow` and `toPeerHit` — to
 * become cross-module exports. Neither is API. `rowOf`, `ensureRoot` and
 * `normaliseBaseUrl` stayed private because only registry.ts uses them; this
 * test asserts that they still are, so a later reshuffle that reaches for one
 * of them across a seam has to widen the barrel deliberately.
 *
 * Runtime values only: `import *` cannot see type-only exports. The nine
 * exported types are pinned by the compiler, via index-peers.ts.
 */
const PUBLIC_VALUE_EXPORTS = [
  'PEERS_ROOT_LABEL',
  'PEER_SHAREABLE_TYPES',
  'PEER_TOKEN_PREFIX',
  'activePeerGrantNodeIds',
  'createPeer',
  'deletePeer',
  'getNodeForPeer',
  'getOutboundToken',
  'getPeer',
  'grantPeerShare',
  'grantPeerTypeShare',
  'hashToken',
  'isPeerShareableType',
  'listPeerShares',
  'listPeerTypeShares',
  'listPeers',
  'markPeerContacted',
  'mintInboundToken',
  'peerShareableTypeCounts',
  'queryForPeer',
  'revokePeerShare',
  'revokePeerTypeShare',
  'rotateInboundToken',
  'searchChunksForPeer',
  'setOutboundToken',
  'setPeerEnabled',
  'tokenMatchesHash',
  'verifyInboundToken',
];

/** Internal to their own seam. None of them is API. */
const MUST_STAY_INTERNAL = [
  'toTypeShareRow',
  'toPeerHit',
  'rowOf',
  'ensureRoot',
  'normaliseBaseUrl',
];

describe('@mantle/content/peers public surface', () => {
  it('exports exactly the pinned list', () => {
    expect(Object.keys(peersApi).sort()).toEqual([...PUBLIC_VALUE_EXPORTS].sort());
  });

  it('does not leak the split helpers', () => {
    for (const name of MUST_STAY_INTERNAL) {
      expect(Object.keys(peersApi)).not.toContain(name);
    }
  });
});
