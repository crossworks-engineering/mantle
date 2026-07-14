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
import { searchChunks, searchNodes } from '@mantle/search';
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
  /** Whether we hold a token to call THEM with (false = pairing half-done). */
  hasOutboundToken: boolean;
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
    hasOutboundToken: !!p.outboundTokenEnc,
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
  /**
   * The token THEY issued US (we seal + replay it when calling them).
   * Optional: first-time pairing is a two-token dance and ours has to be
   * mintable first — without theirs the peer is created status='pending'
   * (inbound works, outbound disabled) until `setOutboundToken` supplies it.
   */
  outboundToken?: string;
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
  const outbound = input.outboundToken?.trim() || null;

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
  const sealed = outbound ? seal(outbound, peerId) : null;
  const inboundToken = mintInboundToken();

  const [row] = await db
    .insert(mantlePeers)
    .values({
      id: peerId,
      ownerId,
      nodeId: node.id,
      displayName,
      baseUrl,
      outboundTokenEnc: sealed?.ciphertext ?? null,
      outboundTokenVersion: sealed?.keyVersion ?? 1,
      inboundTokenHash: hashToken(inboundToken),
      status: outbound ? 'active' : 'pending',
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

/**
 * Decrypt the peer's outbound token so we can call their API. Owner-scoped.
 * Null when the peer doesn't exist OR the pairing is still pending (no token
 * stored yet) — callers surface the friendly "awaiting their token" error.
 */
export async function getOutboundToken(ownerId: string, id: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(mantlePeers)
    .where(and(eq(mantlePeers.id, id), eq(mantlePeers.ownerId, ownerId)))
    .limit(1);
  if (!row?.outboundTokenEnc) return null;
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

/**
 * Store the peer's outbound token (completing a pending pairing, or the peer
 * rotated theirs). A 'pending' peer flips to 'active'; revoked stays revoked.
 */
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
    .set({
      outboundTokenEnc: ciphertext,
      outboundTokenVersion: keyVersion,
      status: sql`case when ${mantlePeers.status} = 'pending' then 'active' else ${mantlePeers.status} end`,
      updatedAt: new Date(),
    })
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
    .set({
      enabled,
      // Re-enabling restores 'pending' (not 'active') while the outbound token
      // is still missing, so the "paste their token" affordance comes back.
      status: enabled
        ? sql`case when ${mantlePeers.outboundTokenEnc} is null then 'pending' else 'active' end`
        : 'revoked',
      updatedAt: new Date(),
    })
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
 * matching enabled peer, constant-time confirms, bumps last_seen_at, and
 * returns the peer. Null = no match / disabled / revoked. 'pending' peers DO
 * verify — during first-time pairing the other side gets our inbound token
 * before we have theirs, and their calls must work while we wait (what they
 * can read is still governed entirely by peer_shares). The returned `ownerId`
 * is the answering owner whose data the peer may (scoped) read.
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
        inArray(mantlePeers.status, ['active', 'pending']),
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
  /** Free-text — ranked semantically when `queryEmbedding` is present, else FTS. Empty = list everything granted. */
  query?: string;
  /** Restrict to these node types. */
  types?: string[];
  limit?: number;
  /**
   * Embedding of `query` in the ANSWERING owner's vector space. Computed
   * server-side by the federation route (`embed(peer.ownerId, query)`) — the
   * wire request carries text only, so the protocol is unchanged. When present,
   * ranking is the same hybrid vector+FTS pipeline local search uses; when
   * absent (no query, or embedder down), ranking degrades to FTS.
   */
  queryEmbedding?: number[];
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
 * The peer's active grant set — the node ids it is allowed to see, plus the
 * granting owner. The scoping source for every federation read; searches
 * filter to a strict subset of it.
 */
export async function activePeerGrantNodeIds(
  peerId: string,
): Promise<{ ownerId: string | null; nodeIds: string[] }> {
  const rows = await db
    .select({ ownerId: peerShares.ownerId, nodeId: peerShares.nodeId })
    .from(peerShares)
    .where(and(eq(peerShares.peerId, peerId), isNull(peerShares.revokedAt)));
  return { ownerId: rows[0]?.ownerId ?? null, nodeIds: rows.map((r) => r.nodeId) };
}

const toPeerHit = (r: {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  tags: string[] | null;
  createdAt: Date;
}): PeerQueryHit => ({
  id: r.id,
  type: r.type,
  title: r.title,
  summary: r.summary,
  tags: r.tags ?? [],
  createdAt: r.createdAt.toISOString(),
});

/**
 * The federation read surface: nodes the peer is allowed to see (active
 * peer_shares) intersected with its query filters. This is the ONLY path a
 * peer's data ever travels — there is no unscoped variant: with a query the
 * grant set is passed to `searchNodes` as a hard id-allowlist, without one we
 * list the grants recency-first. Bumping the peer's last_contacted/seen
 * accounting is done by the caller (the API route, which also opens the trace).
 */
export async function queryForPeer(peerId: string, opts: PeerQueryOpts = {}): Promise<PeerQueryHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);

  // ── Ranked path: search WITHIN the grant set (hybrid when embedded, FTS else).
  if (opts.query?.trim()) {
    const { ownerId, nodeIds } = await activePeerGrantNodeIds(peerId);
    if (!ownerId || nodeIds.length === 0) return [];
    const found = await searchNodes({
      ownerId,
      q: opts.query.trim(),
      queryEmbedding: opts.queryEmbedding,
      ids: nodeIds,
      types: opts.types?.length ? opts.types : undefined,
      limit,
    });
    return found.map((n) =>
      toPeerHit({
        id: n.id,
        type: n.type,
        title: n.title,
        summary: typeof (n.data as Record<string, unknown> | null)?.summary === 'string'
          ? ((n.data as Record<string, unknown>).summary as string)
          : null,
        tags: n.tags,
        createdAt: n.createdAt,
      }),
    );
  }

  // ── List path (no query): everything granted, recency-first. Unchanged.
  const conds = [eq(peerShares.peerId, peerId), isNull(peerShares.revokedAt)];
  if (opts.types && opts.types.length > 0) {
    conds.push(inArray(sql`${nodes.type}::text`, opts.types));
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
  return rows.map(toPeerHit);
}

// ── Scoped chunk search (passages within the grant set) ──────────────────────

export type PeerChunkHit = {
  nodeId: string;
  nodeTitle: string;
  nodeType: string;
  ordinal: number;
  headingPath: string | null;
  text: string;
  distance: number;
};

/**
 * Passage-level federation read: vector search over `content_chunks` strictly
 * limited to the peer's granted nodes. Pure vector (no FTS fallback) — the
 * caller must supply an embedding; without one there is nothing to rank by.
 * Same no-unscoped-variant rule as `queryForPeer`.
 */
export async function searchChunksForPeer(
  peerId: string,
  embedding: number[],
  limit = 10,
): Promise<PeerChunkHit[]> {
  const capped = Math.min(Math.max(limit, 1), 50);
  const { ownerId, nodeIds } = await activePeerGrantNodeIds(peerId);
  if (!ownerId || nodeIds.length === 0) return [];
  return searchChunks({ ownerId, embedding, nodeIds, limit: capped });
}

export type PeerNodeDetail = {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  tags: string[];
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

/**
 * Fetch one node's full content for a peer — **only** if it has an active
 * grant. Returns null when ungranted (indistinguishable from not-found, so a
 * peer can't probe for the existence of nodes it wasn't given). The data bag is
 * returned verbatim so the peer gets the body/content it was granted; secrets
 * are never node-data anyway, and ungranted nodes never reach here.
 */
export async function getNodeForPeer(
  peerId: string,
  nodeId: string,
): Promise<PeerNodeDetail | null> {
  const [row] = await db
    .select({
      id: nodes.id,
      type: nodes.type,
      title: nodes.title,
      tags: nodes.tags,
      data: nodes.data,
      createdAt: nodes.createdAt,
      updatedAt: nodes.updatedAt,
    })
    .from(peerShares)
    .innerJoin(nodes, eq(nodes.id, peerShares.nodeId))
    .where(
      and(
        eq(peerShares.peerId, peerId),
        eq(peerShares.nodeId, nodeId),
        isNull(peerShares.revokedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  const data = (row.data ?? {}) as Record<string, unknown>;
  const summary = typeof data.summary === 'string' ? data.summary : null;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    summary,
    tags: row.tags ?? [],
    data,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Mark that we just successfully called this peer. */
export async function markPeerContacted(ownerId: string, id: string): Promise<void> {
  await db
    .update(mantlePeers)
    .set({ lastContactedAt: new Date() })
    .where(and(eq(mantlePeers.id, id), eq(mantlePeers.ownerId, ownerId)));
}
