/**
 * Federation peers — data + crypto layer. A peer is another sovereign
 * single-user Mantle we exchange SCOPED data with (see docs/federation.md).
 *
 * Two rows per peer: a browsable `nodes` row (type='mantle_peer') and a
 * `mantle_peers` sidecar holding the sealed credentials — the same split as
 * telegram_accounts. Access a peer gets is governed entirely by `peer_shares`;
 * `queryForPeer` returns the intersection of (what the peer asked) ∩ (active
 * grants), so a peer can never read a node that wasn't explicitly shared.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  db,
  mantlePeers,
  nodes,
  peerShares,
  type MantlePeer,
  type Node,
} from '@mantle/db';
import { open, seal } from '@mantle/crypto';
import { hashToken, mintInboundToken, tokenMatchesHash } from './peers-crypto';

export const PEERS_ROOT_LABEL = 'peers';

export { hashToken, mintInboundToken, tokenMatchesHash, PEER_TOKEN_PREFIX } from './peers-crypto';

/** Secret-free view of a peer for lists / detail / API responses. */
export type PeerRow = {
  id: string;
  nodeId: string;
  displayName: string;
  baseUrl: string;
  status: string;
  enabled: boolean;
  lastContactedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function rowOf(p: MantlePeer): PeerRow {
  return {
    id: p.id,
    nodeId: p.nodeId,
    displayName: p.displayName,
    baseUrl: p.baseUrl,
    status: p.status,
    enabled: p.enabled,
    lastContactedAt: p.lastContactedAt ? p.lastContactedAt.toISOString() : null,
    lastSeenAt: p.lastSeenAt ? p.lastSeenAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

async function ensureRoot(ownerId: string): Promise<void> {
  await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'branch',
      title: 'Peers',
      slug: PEERS_ROOT_LABEL,
      path: PEERS_ROOT_LABEL,
      data: { description: 'Federated Mantle peers. Each exchanges scoped data over the federation API.' },
    })
    .onConflictDoNothing({
      target: [nodes.ownerId, nodes.path],
      where: sql`${nodes.type} = 'branch'`,
    });
}

function normaliseBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, ''); // drop trailing slashes
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('base_url must be an http(s) URL');
  return trimmed;
}

export type CreatePeerInput = {
  displayName: string;
  baseUrl: string;
  /** The token THEY issued US (we seal + replay it when calling them). */
  outboundToken: string;
  description?: string;
};

/**
 * Register a peer. Creates the browsable node + the sealed sidecar, mints a
 * fresh inbound token for the peer to authenticate to us, and returns it in
 * plaintext **exactly once** alongside the secret-free row.
 */
export async function createPeer(
  ownerId: string,
  input: CreatePeerInput,
): Promise<{ peer: PeerRow; inboundToken: string }> {
  const displayName = input.displayName.trim().slice(0, 200) || 'Untitled peer';
  const baseUrl = normaliseBaseUrl(input.baseUrl);
  const outbound = input.outboundToken.trim();
  if (!outbound) throw new Error('outboundToken required');

  await ensureRoot(ownerId);
  const [node] = await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'mantle_peer',
      title: displayName,
      path: PEERS_ROOT_LABEL,
      data: { base_url: baseUrl, description: input.description ?? '' },
    })
    .returning();
  if (!node) throw new Error('createPeer: node insert returned no row');

  // Allocate the peer id up-front so the seal AAD (= row id) is known before
  // we encrypt — same discipline as createApiKey.
  const peerId = crypto.randomUUID();
  const { ciphertext, keyVersion } = seal(outbound, peerId);
  const inboundToken = mintInboundToken();

  const [row] = await db
    .insert(mantlePeers)
    .values({
      id: peerId,
      ownerId,
      nodeId: node.id,
      displayName,
      baseUrl,
      outboundTokenEnc: ciphertext,
      outboundTokenVersion: keyVersion,
      inboundTokenHash: hashToken(inboundToken),
      status: 'active',
      enabled: true,
    })
    .returning();
  if (!row) throw new Error('createPeer: peer insert returned no row');
  return { peer: rowOf(row), inboundToken };
}

export async function listPeers(ownerId: string): Promise<PeerRow[]> {
  const rows = await db
    .select()
    .from(mantlePeers)
    .where(eq(mantlePeers.ownerId, ownerId))
    .orderBy(desc(mantlePeers.createdAt));
  return rows.map(rowOf);
}

export async function getPeer(ownerId: string, id: string): Promise<PeerRow | null> {
  const [row] = await db
    .select()
    .from(mantlePeers)
    .where(and(eq(mantlePeers.id, id), eq(mantlePeers.ownerId, ownerId)))
    .limit(1);
  return row ? rowOf(row) : null;
}

/** Decrypt the peer's outbound token so we can call their API. Owner-scoped. */
export async function getOutboundToken(ownerId: string, id: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(mantlePeers)
    .where(and(eq(mantlePeers.id, id), eq(mantlePeers.ownerId, ownerId)))
    .limit(1);
  if (!row) return null;
  return open(row.outboundTokenEnc, row.id);
}

/** Rotate the inbound token; returns the new plaintext (shown once). */
export async function rotateInboundToken(ownerId: string, id: string): Promise<string | null> {
  const token = mintInboundToken();
  const [row] = await db
    .update(mantlePeers)
    .set({ inboundTokenHash: hashToken(token), updatedAt: new Date() })
    .where(and(eq(mantlePeers.id, id), eq(mantlePeers.ownerId, ownerId)))
    .returning({ id: mantlePeers.id });
  return row ? token : null;
}

/** Replace the stored outbound token (e.g. the peer rotated theirs). */
export async function setOutboundToken(
  ownerId: string,
  id: string,
  outboundToken: string,
): Promise<boolean> {
  const token = outboundToken.trim();
  if (!token) throw new Error('outboundToken required');
  const { ciphertext, keyVersion } = seal(token, id);
  const [row] = await db
    .update(mantlePeers)
    .set({ outboundTokenEnc: ciphertext, outboundTokenVersion: keyVersion, updatedAt: new Date() })
    .where(and(eq(mantlePeers.id, id), eq(mantlePeers.ownerId, ownerId)))
    .returning({ id: mantlePeers.id });
  return !!row;
}

export async function setPeerEnabled(
  ownerId: string,
  id: string,
  enabled: boolean,
): Promise<boolean> {
  const [row] = await db
    .update(mantlePeers)
    .set({ enabled, status: enabled ? 'active' : 'revoked', updatedAt: new Date() })
    .where(and(eq(mantlePeers.id, id), eq(mantlePeers.ownerId, ownerId)))
    .returning({ id: mantlePeers.id });
  return !!row;
}

/** Hard-delete a peer: drops the sidecar + its node (cascades peer_shares). */
export async function deletePeer(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ nodeId: mantlePeers.nodeId })
    .from(mantlePeers)
    .where(and(eq(mantlePeers.id, id), eq(mantlePeers.ownerId, ownerId)))
    .limit(1);
  if (!row) return false;
  await db.delete(mantlePeers).where(eq(mantlePeers.id, id));
  await db.delete(nodes).where(eq(nodes.id, row.nodeId)); // cascades peer_shares
  return true;
}

/**
 * Verify an inbound bearer token. Hashes the presented token, finds the
 * matching enabled+active peer, constant-time confirms, bumps last_seen_at,
 * and returns the peer. Null = no match / disabled / revoked. The returned
 * `ownerId` is the answering owner whose data the peer may (scoped) read.
 */
export async function verifyInboundToken(token: string): Promise<MantlePeer | null> {
  if (!token) return null;
  const [row] = await db
    .select()
    .from(mantlePeers)
    .where(
      and(
        eq(mantlePeers.inboundTokenHash, hashToken(token)),
        eq(mantlePeers.enabled, true),
        eq(mantlePeers.status, 'active'),
      ),
    )
    .limit(1);
  if (!row) return null;
  // Defence-in-depth: confirm in constant time (the unique-hash lookup already
  // matched, but never trust a single equality on an auth path).
  if (!tokenMatchesHash(token, row.inboundTokenHash)) return null;
  await db
    .update(mantlePeers)
    .set({ lastSeenAt: new Date() })
    .where(eq(mantlePeers.id, row.id));
  return row;
}

// ── Grants (peer_shares) ────────────────────────────────────────────────────

export type PeerShareRow = {
  id: string;
  peerId: string;
  nodeId: string;
  nodeType: string;
  title: string;
  createdAt: string;
};

/** Grant a peer read access to one node. Idempotent on the active grant. */
export async function grantPeerShare(
  ownerId: string,
  peerId: string,
  nodeId: string,
): Promise<PeerShareRow | null> {
  // Confirm the peer + node both belong to this owner before granting.
  const [peer] = await db
    .select({ id: mantlePeers.id })
    .from(mantlePeers)
    .where(and(eq(mantlePeers.id, peerId), eq(mantlePeers.ownerId, ownerId)))
    .limit(1);
  if (!peer) return null;
  const [node] = await db
    .select({ id: nodes.id, type: nodes.type, title: nodes.title })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  if (!node) return null;

  const [row] = await db
    .insert(peerShares)
    .values({ ownerId, peerId, nodeId, nodeType: node.type })
    .onConflictDoNothing({
      target: [peerShares.peerId, peerShares.nodeId],
      where: isNull(peerShares.revokedAt),
    })
    .returning();
  // onConflictDoNothing returns nothing when the active grant already exists —
  // fetch it so callers always get the row.
  const existing =
    row ??
    (
      await db
        .select()
        .from(peerShares)
        .where(
          and(
            eq(peerShares.peerId, peerId),
            eq(peerShares.nodeId, nodeId),
            isNull(peerShares.revokedAt),
          ),
        )
        .limit(1)
    )[0];
  if (!existing) return null;
  return {
    id: existing.id,
    peerId: existing.peerId,
    nodeId: existing.nodeId,
    nodeType: existing.nodeType,
    title: node.title,
    createdAt: existing.createdAt.toISOString(),
  };
}

/** Revoke a peer's access to a node (revoke-don't-delete). */
export async function revokePeerShare(
  ownerId: string,
  peerId: string,
  nodeId: string,
): Promise<boolean> {
  const res = await db
    .update(peerShares)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(peerShares.ownerId, ownerId),
        eq(peerShares.peerId, peerId),
        eq(peerShares.nodeId, nodeId),
        isNull(peerShares.revokedAt),
      ),
    )
    .returning({ id: peerShares.id });
  return res.length > 0;
}

/** All active grants for a peer, with the granted node's title + type. */
export async function listPeerShares(ownerId: string, peerId: string): Promise<PeerShareRow[]> {
  const rows = await db
    .select({
      id: peerShares.id,
      peerId: peerShares.peerId,
      nodeId: peerShares.nodeId,
      nodeType: peerShares.nodeType,
      title: nodes.title,
      createdAt: peerShares.createdAt,
    })
    .from(peerShares)
    .innerJoin(nodes, eq(nodes.id, peerShares.nodeId))
    .where(
      and(
        eq(peerShares.ownerId, ownerId),
        eq(peerShares.peerId, peerId),
        isNull(peerShares.revokedAt),
      ),
    )
    .orderBy(desc(peerShares.createdAt));
  return rows.map((r) => ({
    id: r.id,
    peerId: r.peerId,
    nodeId: r.nodeId,
    nodeType: r.nodeType,
    title: r.title,
    createdAt: r.createdAt.toISOString(),
  }));
}

// ── Scoped query (what a peer can actually read) ─────────────────────────────

export type PeerQueryOpts = {
  /** Free-text — matched against title + summary. Empty = list everything granted. */
  query?: string;
  /** Restrict to these node types. */
  types?: string[];
  limit?: number;
};

export type PeerQueryHit = {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  tags: string[];
  createdAt: string;
};

/**
 * The federation read surface: nodes the peer is allowed to see (active
 * peer_shares) intersected with its query filters. This is the ONLY path a
 * peer's data ever travels — there is no unscoped variant. Bumps the peer's
 * last_contacted/seen accounting is done by the caller (the API route, which
 * also opens the trace).
 */
export async function queryForPeer(peerId: string, opts: PeerQueryOpts = {}): Promise<PeerQueryHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const conds = [eq(peerShares.peerId, peerId), isNull(peerShares.revokedAt)];
  if (opts.types && opts.types.length > 0) {
    conds.push(inArray(sql`${nodes.type}::text`, opts.types));
  }
  if (opts.query?.trim()) {
    const q = `%${opts.query.trim()}%`;
    conds.push(sql`(${nodes.title} ilike ${q} or ${nodes.data}->>'summary' ilike ${q})`);
  }
  const rows = await db
    .select({
      id: nodes.id,
      type: nodes.type,
      title: nodes.title,
      summary: sql<string | null>`${nodes.data}->>'summary'`,
      tags: nodes.tags,
      createdAt: nodes.createdAt,
    })
    .from(peerShares)
    .innerJoin(nodes, eq(nodes.id, peerShares.nodeId))
    .where(and(...conds))
    .orderBy(desc(nodes.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    summary: r.summary,
    tags: r.tags ?? [],
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Mark that we just successfully called this peer. */
export async function markPeerContacted(ownerId: string, id: string): Promise<void> {
  await db
    .update(mantlePeers)
    .set({ lastContactedAt: new Date() })
    .where(and(eq(mantlePeers.id, id), eq(mantlePeers.ownerId, ownerId)));
}
