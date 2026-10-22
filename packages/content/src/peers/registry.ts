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
import { InputError } from '@mantle/std';
import {
  bestEffortWrite,
  db,
  mantlePeers,
  nodes,
  onFullSystemRoute,
  type MantlePeer,
  deleteStructureItems,
  insertStructureItem,
  withDeadlockRetry,
  withNodeInsertHeads,
} from '@mantle/db';
import { open, seal } from '@mantle/crypto';
import { hashToken, mintInboundToken, tokenMatchesHash } from '../peers-crypto';
import { asKindRootRepair } from '../kind-root';

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
  /** The login this peer's token acts as on /api/mcp (0227), in that
   *  login's workspaces; null = a share-only peer. */
  actsAsLoginId: string | null;
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
    // An unbound peer writes nothing, whatever it kept for a rebind (0238).
    writeEnabled: p.actsAsLoginId ? p.writeEnabled : false,
    allowedRiskyTools: p.allowedRiskyTools ?? [],
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** The kind's root folder, made as system(repair:kind-root) (kind-root.ts). */
async function ensureRoot(ownerId: string): Promise<void> {
  await asKindRootRepair(() => ensureRootNow(ownerId));
}

async function ensureRootNow(ownerId: string): Promise<void> {
  await withDeadlockRetry(() =>
    withNodeInsertHeads(ownerId, [{ type: 'branch', path: PEERS_ROOT_LABEL }], (tx) =>
      tx
        .insert(nodes)
        .values({
          ownerId,
          type: 'branch',
          title: 'Peers',
          slug: PEERS_ROOT_LABEL,
          path: PEERS_ROOT_LABEL,
          data: {
            description:
              'Federated Mantle peers. Each exchanges scoped data over the federation API.',
          },
        })
        .onConflictDoNothing({
          target: [nodes.ownerId, nodes.path],
          where: sql`${nodes.type} = 'branch'`,
        }),
    ),
  );
}

function normaliseBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, ''); // drop trailing slashes
  if (!/^https?:\/\//i.test(trimmed)) throw new InputError('base_url must be an http(s) URL');
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
  /** The login registering it (W6b fix round 3, M-1): only a peer the
   *  owner made deletes apps as the owner. */
  createdBy?: string;
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
  // The peer's item, a structure item (packages/db gateway/structure-item.ts):
  // on the peers area's narrow exit, the definer makes it.
  const node = await withDeadlockRetry(() =>
    insertStructureItem('peer-item', {
      ownerId,
      title: displayName,
      path: PEERS_ROOT_LABEL,
      data: { base_url: baseUrl, description: input.description ?? '' },
    }),
  );
  if (!node) throw new Error('createPeer: node insert returned no row');

  // Allocate the peer id up-front so the seal AAD (= row id) is known before
  // we encrypt — same discipline as createApiKey.
  const peerId = crypto.randomUUID();
  const sealed = outbound ? seal(outbound, peerId) : null;
  const inboundToken = mintInboundToken();

  // The peer's row holds its way in (the inbound token's hash, enabled,
  // status): the narrow login may not make one (no INSERT on mantle_peers),
  // so on the connectors area's exit it runs at the full-route spot
  // peer-access, as every write of those columns does (docs/runtime-role.md).
  const [row] = await onFullSystemRoute('peer-access', () =>
    db
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
        createdBy: input.createdBy ?? null,
      })
      .returning(),
  );
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

/** Rotate the inbound token; returns the new plaintext (shown once).
 *  `unlessBoundTo` (a caller that is not the owner, W6b fix round 4, L-4):
 *  only while the peer is not bound to that login, in the same statement;
 *  null and nothing written otherwise. */
export async function rotateInboundToken(
  ownerId: string,
  id: string,
  opts: { unlessBoundTo?: string } = {},
): Promise<string | null> {
  const token = mintInboundToken();
  const [row] = await onFullSystemRoute('peer-access', () =>
    db
      .update(mantlePeers)
      .set({ inboundTokenHash: hashToken(token), updatedAt: new Date() })
      .where(
        and(
          eq(mantlePeers.id, id),
          eq(mantlePeers.ownerId, ownerId),
          opts.unlessBoundTo
            ? sql`${mantlePeers.actsAsLoginId} is distinct from ${opts.unlessBoundTo}::uuid`
            : undefined,
        ),
      )
      .returning({ id: mantlePeers.id }),
  );
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
  if (!token) throw new InputError('outboundToken required');
  const { ciphertext, keyVersion } = seal(token, id);
  // status (pending to active) is part of the way in: peer-access.
  const [row] = await onFullSystemRoute('peer-access', () =>
    db
      .update(mantlePeers)
      .set({
        outboundTokenEnc: ciphertext,
        outboundTokenVersion: keyVersion,
        status: sql`case when ${mantlePeers.status} = 'pending' then 'active' else ${mantlePeers.status} end`,
        updatedAt: new Date(),
      })
      .where(and(eq(mantlePeers.id, id), eq(mantlePeers.ownerId, ownerId)))
      .returning({ id: mantlePeers.id }),
  );
  return !!row;
}

export async function setPeerEnabled(
  ownerId: string,
  id: string,
  enabled: boolean,
): Promise<boolean> {
  const [row] = await onFullSystemRoute('peer-access', () =>
    db
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
      .returning({ id: mantlePeers.id }),
  );
  return !!row;
}

/** What `setPeerAccess` changed: the peer, and the new inbound token when
 *  the owner's binding re-keyed it (plaintext, shown once; null otherwise). */
export type PeerAccessResult = { peer: PeerRow; inboundToken: string | null };

/**
 * What a peer's token may do on /api/mcp (0227, plan page e5b854dd): act as
 * one login (the caller checked it exists and passes its current role), or
 * nobody (`null`: a share-only peer); the write switch; the risky owner tools
 * allowed by name. Only the fields given change, with one rule: binding or
 * rebinding the login starts CLOSED (write off, no risky tools) unless the
 * same call sets them, so a member peer with write on that is switched to
 * the owner does not get owner write by accident. An unbound peer keeps
 * write off whatever is sent. The one exception: binding a peer again to
 * the login a session end unbound it from (0238) restores what it had.
 */
export async function setPeerAccess(
  ownerId: string,
  id: string,
  access: {
    actsAs?: { loginId: string } | null;
    writeEnabled?: boolean;
    allowedRiskyTools?: string[];
    /** The owner binding the peer to itself: recorded as its maker (W6b fix
     *  round 3, M-1). The peer gets a new inbound token in the same
     *  statement, returned once, whenever it moves into the owner's binding
     *  (it was bound to anyone else, or to nobody), and whenever another
     *  login made it or no maker is recorded (before 0267): whoever made or
     *  last rotated it saw the old token, which would otherwise stay an
     *  owner credential in their hands (fix round 4, L-1; fix round 5, M-1).
     *  A peer already bound to the owner and made by it keeps its token. */
    adoptBy?: string;
    /** A caller that is not the owner (fix round 4, L-4): the change lands
     *  only while the peer is not bound to this login (the anchor), checked
     *  in the same statement, so a change the owner alone may make (the
     *  Write switch, risky tools) never lands on a peer the owner bound in
     *  the meantime. Nothing is written otherwise (null). It is not a lock
     *  on the binding itself: an Admin user may still set actsAs to a member
     *  without it, by design (fix round 5). */
    unlessBoundTo?: string;
  },
): Promise<PeerAccessResult | null> {
  const set: Partial<typeof mantlePeers.$inferInsert> = { updatedAt: new Date() };
  const risky = access.allowedRiskyTools ? [...new Set(access.allowedRiskyTools)] : undefined;
  if (access.actsAs !== undefined) {
    set.actsAsLoginId = access.actsAs?.loginId ?? null;
    // Binding it again to the login whose session end unbound it (0238,
    // lib/peer-unbind.ts) restores the Write switch and risky tools it kept;
    // any other binding starts closed, as before.
    const same = access.actsAs
      ? sql`(${mantlePeers.endedActsAsLoginId} = ${access.actsAs.loginId}::uuid)`
      : null;
    set.writeEnabled = !access.actsAs
      ? false
      : (access.writeEnabled ??
        (sql`(case when ${same} then ${mantlePeers.writeEnabled} else false end)` as unknown as boolean));
    set.allowedRiskyTools = !access.actsAs
      ? []
      : (risky ??
        (sql`(case when ${same} then ${mantlePeers.allowedRiskyTools} else '{}'::text[] end)` as unknown as string[]));
    set.endedActsAsLoginId = null;
  } else {
    if (access.writeEnabled !== undefined) {
      // Never on for a peer bound to nobody.
      set.writeEnabled =
        sql`(${access.writeEnabled} and ${mantlePeers.actsAsLoginId} is not null)` as unknown as boolean;
    }
    if (risky !== undefined) set.allowedRiskyTools = risky;
  }
  let minted: { token: string; hash: string } | null = null;
  if (access.adoptBy) {
    const token = mintInboundToken();
    minted = { token, hash: hashToken(token) };
    // SET reads the row as it was: re-key when it moves into the owner's
    // binding (another Admin user may have rotated it while it was bound
    // elsewhere and seen the token, fix round 5, M-1), or when someone else
    // made it.
    set.inboundTokenHash =
      sql`(case when ${mantlePeers.actsAsLoginId} is distinct from ${access.adoptBy}::uuid
                  or ${mantlePeers.createdBy} is distinct from ${access.adoptBy}::uuid
                then ${minted.hash} else ${mantlePeers.inboundTokenHash} end)` as unknown as string;
    set.createdBy = access.adoptBy;
  }
  // Who the peer acts as, its Write switch, risky tools and token: peer-access.
  const [row] = await onFullSystemRoute('peer-access', () =>
    db
      .update(mantlePeers)
      .set(set)
      .where(
        and(
          eq(mantlePeers.id, id),
          eq(mantlePeers.ownerId, ownerId),
          access.unlessBoundTo
            ? sql`${mantlePeers.actsAsLoginId} is distinct from ${access.unlessBoundTo}::uuid`
            : undefined,
        ),
      )
      .returning(),
  );
  if (!row) return null;
  const rekeyed = !!minted && row.inboundTokenHash === minted.hash;
  return { peer: rowOf(row), inboundToken: rekeyed ? minted!.token : null };
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
  await withDeadlockRetry(() => deleteStructureItems('peer-item', ownerId, [row.nodeId]));
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

/** Mark that we just successfully called this peer. A note for the peers
 *  screen, as verifyInboundToken's last-seen stamp: on a database that
 *  refuses the write (a read tool's read-only actor, a reader role) it is
 *  skipped, never a failed peer call (A5 step 3a low round). */
export async function markPeerContacted(ownerId: string, id: string): Promise<void> {
  await bestEffortWrite("a peer's last-contact stamp", () =>
    db
      .update(mantlePeers)
      .set({ lastContactedAt: new Date() })
      .where(and(eq(mantlePeers.id, id), eq(mantlePeers.ownerId, ownerId))),
  );
}
