/**
 * Federation peers — data + crypto layer. A peer is another sovereign
 * single-user Mantle we exchange SCOPED data with (see docs/federation.md).
 *
 * Two rows per peer: a browsable `nodes` row (type='mantle_peer') and a
 * `mantle_peers` sidecar holding the sealed credentials — the same split as
 * telegram_accounts. Access a peer gets is governed entirely by grants:
 * per-node rows in `peer_shares` plus standing per-category rows in
 * `peer_share_scopes` (a category grant covers every node of that type,
 * including nodes created later — resolved at query time, never materialized).
 * `queryForPeer` returns the intersection of (what the peer asked) ∩ (active
 * grants), so a peer can never read a node that wasn't explicitly shared
 * per node or per category.
 */

/**
 * Split out of the 787-line peers.ts on 2026-09-02 (audit, tier 3) into
 * peers/{registry,grants,query}.ts — the three sections the file already
 * marked with its own banner comments. Dependency order is one-way:
 * registry standalone, grants standalone, query <- grants.
 *
 * Curated, not `export *`: `@mantle/content/peers` is a public package
 * sub-path. The split forced `toTypeShareRow` and `toPeerHit` (row mappers)
 * to become cross-module exports; neither is API. The list below is UNCHANGED
 * from the single file it replaces; `peers-exports.test.ts` pins it.
 */

export { hashToken, mintInboundToken, tokenMatchesHash, PEER_TOKEN_PREFIX } from '../peers-crypto';

export {
  PEERS_ROOT_LABEL,
  createPeer,
  listPeers,
  getPeer,
  getOutboundToken,
  rotateInboundToken,
  setOutboundToken,
  setPeerEnabled,
  deletePeer,
  verifyInboundToken,
  markPeerContacted,
  type PeerRow,
  type CreatePeerInput,
} from './registry';

export {
  grantPeerShare,
  revokePeerShare,
  listPeerShares,
  PEER_SHAREABLE_TYPES,
  isPeerShareableType,
  grantPeerTypeShare,
  revokePeerTypeShare,
  listPeerTypeShares,
  peerShareableTypeCounts,
  type PeerShareRow,
  type PeerShareableType,
  type PeerTypeShareRow,
} from './grants';

export {
  activePeerGrantNodeIds,
  queryForPeer,
  searchChunksForPeer,
  getNodeForPeer,
  type PeerQueryOpts,
  type PeerQueryHit,
  type PeerChunkHit,
  type PeerNodeDetail,
} from './query';
