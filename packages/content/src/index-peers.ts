/**
 * @mantle/content · peers
 *
 * Federation — peer registration and the client that queries them.
 *
 * Split out of the 962-line index.ts on 2026-09-02 (audit, tier 3). The
 * export lists are UNCHANGED — this package's public surface is exactly what
 * it was. What changed is that adding one export now touches one small file
 * instead of the single barrel that saw 102 commits in 90 days, so two
 * sessions adding a DTO no longer collide. Curation is deliberate here: the
 * alternative, `export *`, would publish every module's internals (tuning
 * constants like EMBED_TEXT_PER_FILE, helpers like renderIdentityBlock) as
 * API nobody chose to promise.
 */

export {
  PEERS_ROOT_LABEL,
  PEER_TOKEN_PREFIX,
  createPeer,
  listPeers,
  getPeer,
  getOutboundToken,
  rotateInboundToken,
  setOutboundToken,
  setPeerEnabled,
  deletePeer,
  verifyInboundToken,
  grantPeerShare,
  revokePeerShare,
  listPeerShares,
  grantPeerTypeShare,
  revokePeerTypeShare,
  listPeerTypeShares,
  peerShareableTypeCounts,
  isPeerShareableType,
  PEER_SHAREABLE_TYPES,
  queryForPeer,
  searchChunksForPeer,
  activePeerGrantNodeIds,
  getNodeForPeer,
  markPeerContacted,
  hashToken,
  mintInboundToken,
  tokenMatchesHash,
  type PeerRow,
  type CreatePeerInput,
  type PeerShareRow,
  type PeerTypeShareRow,
  type PeerShareableType,
  type PeerQueryOpts,
  type PeerQueryHit,
  type PeerChunkHit,
  type PeerNodeDetail,
} from './peers';

export {
  queryPeer,
  getPeerNode,
  searchPeerChunks,
  type PeerClientResult,
  type PeerQueryResult,
  type PeerChunkSearchResult,
} from './peers-client';
