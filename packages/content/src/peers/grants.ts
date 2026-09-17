/**
 * Peers · grants. What a peer is allowed to read, in two forms.
 *
 * Per-node rows in `peer_shares`, and standing per-category rows in
 * `peer_share_scopes`. A category grant deliberately covers every node of that
 * type INCLUDING ones created later, which is why it is resolved at query time
 * and never materialized into per-node rows: materializing it would freeze the
 * grant at the moment it was made.
 *
 * Revocation is revoke-don't-delete throughout — a grant's history is part of
 * the audit trail, so rows are stamped, not removed.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, mantlePeers, nodes, peerShares, peerShareScopes } from '@mantle/db';

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

/**
 * The node types a peer may be granted BY CATEGORY. Server-enforced allowlist:
 * never secrets or mantle_peer, and — deliberately — never email or journal
 * (the owner's private corpus; even the team responder gates those behind
 * teamPrivateReads). Cherry-picking an individual email/journal node via
 * peer_shares stays possible; subscribing a peer to all of them does not.
 */
export const PEER_SHAREABLE_TYPES = [
  'page',
  'note',
  'file',
  'contact',
  'table',
  'draw',
  'event',
  'task',
] as const;

export type PeerShareableType = (typeof PEER_SHAREABLE_TYPES)[number];

export function isPeerShareableType(t: string): t is PeerShareableType {
  return (PEER_SHAREABLE_TYPES as readonly string[]).includes(t);
}

export type PeerTypeShareRow = {
  id: string;
  peerId: string;
  nodeType: string;
  createdAt: string;
};

export const toTypeShareRow = (r: {
  id: string;
  peerId: string;
  nodeType: string;
  createdAt: Date;
}): PeerTypeShareRow => ({
  id: r.id,
  peerId: r.peerId,
  nodeType: r.nodeType,
  createdAt: r.createdAt.toISOString(),
});

/**
 * Grant a peer read access to a whole category — a STANDING subscription: every
 * node of this type, including nodes created later, becomes readable by the
 * peer. Idempotent on the active grant. Rejects types outside
 * PEER_SHAREABLE_TYPES (throws — the API maps it to a 400).
 */
export async function grantPeerTypeShare(
  ownerId: string,
  peerId: string,
  nodeType: string,
): Promise<PeerTypeShareRow | null> {
  if (!isPeerShareableType(nodeType)) {
    throw new Error(`type "${nodeType}" cannot be category-shared`);
  }
  const [peer] = await db
    .select({ id: mantlePeers.id })
    .from(mantlePeers)
    .where(and(eq(mantlePeers.id, peerId), eq(mantlePeers.ownerId, ownerId)))
    .limit(1);
  if (!peer) return null;

  const [row] = await db
    .insert(peerShareScopes)
    .values({ ownerId, peerId, nodeType })
    .onConflictDoNothing({
      target: [peerShareScopes.peerId, peerShareScopes.nodeType],
      where: isNull(peerShareScopes.revokedAt),
    })
    .returning();
  const existing =
    row ??
    (
      await db
        .select()
        .from(peerShareScopes)
        .where(
          and(
            eq(peerShareScopes.peerId, peerId),
            eq(peerShareScopes.nodeType, nodeType),
            isNull(peerShareScopes.revokedAt),
          ),
        )
        .limit(1)
    )[0];
  return existing ? toTypeShareRow(existing) : null;
}

/** Revoke a peer's category grant (revoke-don't-delete). */
export async function revokePeerTypeShare(
  ownerId: string,
  peerId: string,
  nodeType: string,
): Promise<boolean> {
  const res = await db
    .update(peerShareScopes)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(peerShareScopes.ownerId, ownerId),
        eq(peerShareScopes.peerId, peerId),
        eq(peerShareScopes.nodeType, nodeType as PeerShareableType),
        isNull(peerShareScopes.revokedAt),
      ),
    )
    .returning({ id: peerShareScopes.id });
  return res.length > 0;
}

/** All active category grants for a peer. */
export async function listPeerTypeShares(
  ownerId: string,
  peerId: string,
): Promise<PeerTypeShareRow[]> {
  const rows = await db
    .select()
    .from(peerShareScopes)
    .where(
      and(
        eq(peerShareScopes.ownerId, ownerId),
        eq(peerShareScopes.peerId, peerId),
        isNull(peerShareScopes.revokedAt),
      ),
    )
    .orderBy(desc(peerShareScopes.createdAt));
  return rows.map(toTypeShareRow);
}

/**
 * How many nodes each shareable category currently holds for this owner — the
 * counts shown beside the category toggles ("Pages · 12"). One grouped query.
 */
export async function peerShareableTypeCounts(
  ownerId: string,
): Promise<Record<PeerShareableType, number>> {
  const rows = await db
    .select({ type: nodes.type, count: sql<number>`count(*)::int` })
    .from(nodes)
    .where(
      and(eq(nodes.ownerId, ownerId), inArray(sql`${nodes.type}::text`, [...PEER_SHAREABLE_TYPES])),
    )
    .groupBy(nodes.type);
  const counts = Object.fromEntries(PEER_SHAREABLE_TYPES.map((t) => [t, 0])) as Record<
    PeerShareableType,
    number
  >;
  for (const r of rows) {
    if (isPeerShareableType(r.type)) counts[r.type] = r.count;
  }
  return counts;
}
