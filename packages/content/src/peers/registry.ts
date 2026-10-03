/**
 * Peers · the registry. A peer's two rows and their lifecycle: create, read,
 * enable, delete, and the two token halves.
 *
 * Credentials are sealed in the `mantle_peers` sidecar and never leave it in
 * plaintext except at the two moments a human needs them — `createPeer` and
 * `rotateInboundToken` return the inbound token ONCE, and `getOutboundToken`
 * opens ours only to call out. `PeerRow` is the secret-free view every list,
 * detail and API response uses, which is why it is the return type here and
 * `MantlePeer` is not.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { bestEffortWrite, db, mantlePeers, nodes, type MantlePeer } from '@mantle/db';
import { open, seal } from '@mantle/crypto';
import { hashToken, mintInboundToken, tokenMatchesHash } from '../peers-crypto';

export const PEERS_ROOT_LABEL = 'peers';

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
  /** The login this peer's token acts as on /api/mcp (0227); null = a
   *  share-only peer. */
  actsAsLoginId: string | null;
  actsAsRole: 'admin' | 'member' | 'client' | null;
  /** Whether the peer may call its login's write tools. */
  writeEnabled: boolean;
  /** Risky owner tools allowed for this peer by name. */
  allowedRiskyTools: string[];
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
    actsAsLoginId: p.actsAsLoginId ?? null,
    actsAsRole:
      p.actsAsRole === 'admin' || p.actsAsRole === 'member' || p.actsAsRole === 'client'
        ? p.actsAsRole
        : null,
    writeEnabled: p.writeEnabled,
    allowedRiskyTools: p.allowedRiskyTools ?? [],
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
      data: {
        description: 'Federated Mantle peers. Each exchanges scoped data over the federation API.',
      },
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

/**
 * What a peer's token may do on /api/mcp (0227, plan page e5b854dd): act as
 * one login (the caller checked it exists and passes its current role), or
 * nobody (`null`: a share-only peer); the write switch; the risky owner tools
 * allowed by name. Only the fields given change, with one rule: binding or
 * rebinding the login starts CLOSED (write off, no risky tools) unless the
 * same call sets them, so a member peer with write on that is switched to
 * the owner does not get owner write by accident. An unbound peer keeps
 * write off whatever is sent.
 */
export async function setPeerAccess(
  ownerId: string,
  id: string,
  access: {
    actsAs?: { loginId: string; role: 'admin' | 'member' | 'client' } | null;
    writeEnabled?: boolean;
    allowedRiskyTools?: string[];
  },
): Promise<PeerRow | null> {
  const set: Partial<typeof mantlePeers.$inferInsert> = { updatedAt: new Date() };
  const risky = access.allowedRiskyTools ? [...new Set(access.allowedRiskyTools)] : undefined;
  if (access.actsAs !== undefined) {
    set.actsAsLoginId = access.actsAs?.loginId ?? null;
    set.actsAsRole = access.actsAs?.role ?? null;
    set.writeEnabled = access.actsAs ? (access.writeEnabled ?? false) : false;
    set.allowedRiskyTools = access.actsAs ? (risky ?? []) : [];
  } else {
    if (access.writeEnabled !== undefined) {
      // Never on for a peer bound to nobody.
      set.writeEnabled =
        sql`(${access.writeEnabled} and ${mantlePeers.actsAsLoginId} is not null)` as unknown as boolean;
    }
    if (risky !== undefined) set.allowedRiskyTools = risky;
  }
  const [row] = await db
    .update(mantlePeers)
    .set(set)
    .where(and(eq(mantlePeers.id, id), eq(mantlePeers.ownerId, ownerId)))
    .returning();
  return row ? rowOf(row) : null;
}

/** Hard-delete a peer: drops the sidecar + its node (cascades peer_shares). */
export async function deletePeer(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ nodeId: mantlePeers.nodeId })
    .from(mantlePeers)
    .where(and(eq(mantlePeers.id, id), eq(mantlePeers.ownerId, ownerId)))
    .limit(1);
  if (!row) return false;
  // One statement: mantle_peers and peer_shares both cascade from the node
  // (schema/mantle-peers.ts), so deleting it is the whole operation, atomically.
  await db.delete(nodes).where(eq(nodes.id, row.nodeId));
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
  // The token is verified by now; last-seen is a note for the peers screen.
  // On a database that refuses writes it is skipped, never a failed peer call.
  await bestEffortWrite("a peer's last-seen stamp", () =>
    db.update(mantlePeers).set({ lastSeenAt: new Date() }).where(eq(mantlePeers.id, row.id)),
  );
  return row;
}

/** Mark that we just successfully called this peer. */
export async function markPeerContacted(ownerId: string, id: string): Promise<void> {
  await db
    .update(mantlePeers)
    .set({ lastContactedAt: new Date() })
    .where(and(eq(mantlePeers.id, id), eq(mantlePeers.ownerId, ownerId)));
}
