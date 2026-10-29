/**
 * @mantle/content · peers
 *
 * Federation — peer registration and the client that queries them.
 *
 * One of the package index's export lists, split by area so adding one
 * export touches one small file and two sessions adding a DTO do not
 * collide. Curation is deliberate here: the
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
  setPeerAccess,
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
  type PeerAccessResult,
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
  peerCallTarget,
  searchPeerChunks,
  type PeerClientResult,
  type PeerQueryResult,
  type PeerChunkSearchResult,
} from './peers-client';
