/**
 * Inbound federation auth. Pulls the bearer token off a request and resolves
 * it to the peer it belongs to (or null). The token is a per-peer secret the
 * operator minted via createPeer and handed to that peer; verifyInboundToken
 * hashes it, looks up the enabled+active peer, and bumps last_seen_at.
 *
 * This is the ONLY gate on the federation surface — `/api/federation` bypasses
 * the session-cookie middleware (see auth-constants.ts), so every handler must
 * call this first and 401 on null.
 *
 * Only a `full` peer reads the federation routes (0354): a status-only peer's
 * token reaches the status tools on /api/mcp and nothing here, and an
 * outbound-only peer's token verifies nowhere.
 */
import { peerAccessScopeOf, verifyInboundToken } from '@mantle/content';
import type { MantlePeer } from '@mantle/db';
import { bearerFrom } from './auth/request';

/** Resolve the calling peer from the request's bearer token, or null. */
export async function authenticatePeer(req: Request): Promise<MantlePeer | null> {
  const token = bearerFrom(req);
  if (!token) return null;
  const peer = await verifyInboundToken(token);
  return peer && peerAccessScopeOf(peer.accessScope) === 'full' ? peer : null;
}
