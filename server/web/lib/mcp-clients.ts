/**
 * Server helpers for the Settings → MCP "connected clients" view: list the
 * clients that hold a live token, and disconnect one.
 *
 * Single-owner by design (one brain per box), so every token belongs to the one
 * owner; the ownerId scope is belt-and-braces.
 */
import { and, count, eq, gt, isNull, max, min } from 'drizzle-orm';
import { db, oauthAccessTokens, oauthAuthCodes, oauthClients } from '@mantle/db';
import { lockOauthActor } from './oauth-lock';

export type ConnectedClient = {
  id: string;
  clientName: string | null;
  connectedAt: string; // ISO — earliest still-active token
  lastUsedAt: string | null; // ISO
  activeTokens: number;
};

/** Clients with at least one non-revoked, unexpired access token, owned by
 *  `ownerId`. A registered client that never completed consent (no token) is
 *  omitted — it isn't a connection. */
export async function listConnectedClients(ownerId: string): Promise<ConnectedClient[]> {
  const rows = await db
    .select({
      id: oauthClients.id,
      clientName: oauthClients.clientName,
      connectedAt: min(oauthAccessTokens.createdAt),
      lastUsedAt: max(oauthAccessTokens.lastUsedAt),
      activeTokens: count(oauthAccessTokens.id),
    })
    .from(oauthClients)
    .innerJoin(
      oauthAccessTokens,
      and(
        eq(oauthAccessTokens.clientId, oauthClients.id),
        eq(oauthAccessTokens.ownerId, ownerId),
        isNull(oauthAccessTokens.revokedAt),
        gt(oauthAccessTokens.expiresAt, new Date()),
      ),
    )
    .groupBy(oauthClients.id, oauthClients.clientName)
    .orderBy(oauthClients.id);

  return rows.map((r) => ({
    id: r.id,
    clientName: r.clientName,
    connectedAt: (r.connectedAt instanceof Date
      ? r.connectedAt
      : new Date(r.connectedAt!)
    ).toISOString(),
    lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : null,
    activeTokens: Number(r.activeTokens),
  }));
}

/** Disconnect a client: delete its row, which cascades to every token + code it
 *  owns (FK ON DELETE CASCADE) — so the access token dies immediately. Guarded
 *  to only act when the client actually has a token owned by `ownerId`. Returns
 *  whether anything was removed. */
export async function disconnectClient(ownerId: string, clientId: string): Promise<boolean> {
  const [owned] = await db
    .select({ id: oauthAccessTokens.id })
    .from(oauthAccessTokens)
    .where(and(eq(oauthAccessTokens.clientId, clientId), eq(oauthAccessTokens.ownerId, ownerId)))
    .limit(1);
  if (!owned) return false;
  await db.delete(oauthClients).where(eq(oauthClients.id, clientId));
  return true;
}

// ── A member's own clients (team apps Phase 1) ───────────────────────────────

/** The clients ONE login connected: its live grants only, grouped by client.
 *  A member's MCP screen lists these, and nobody else's. */
export async function listLoginClients(
  ownerId: string,
  actorId: string,
): Promise<ConnectedClient[]> {
  const rows = await db
    .select({
      id: oauthClients.id,
      clientName: oauthClients.clientName,
      connectedAt: min(oauthAccessTokens.createdAt),
      lastUsedAt: max(oauthAccessTokens.lastUsedAt),
      activeTokens: count(oauthAccessTokens.id),
    })
    .from(oauthClients)
    .innerJoin(
      oauthAccessTokens,
      and(
        eq(oauthAccessTokens.clientId, oauthClients.id),
        eq(oauthAccessTokens.ownerId, ownerId),
        eq(oauthAccessTokens.actorId, actorId),
        isNull(oauthAccessTokens.revokedAt),
        gt(oauthAccessTokens.expiresAt, new Date()),
      ),
    )
    .groupBy(oauthClients.id, oauthClients.clientName)
    .orderBy(oauthClients.id);
  return rows.map((r) => ({
    id: r.id,
    clientName: r.clientName,
    connectedAt: (r.connectedAt instanceof Date
      ? r.connectedAt
      : new Date(r.connectedAt!)
    ).toISOString(),
    lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : null,
    activeTokens: Number(r.activeTokens),
  }));
}

/**
 * Disconnect ONE login's grants on one client: revoke that login's tokens
 * on it and drop its open codes. The client row stays (another login may
 * use the same registration); only this login's grants end. Under the
 * login's OAuth lock, as every other revoke (a refresh or a code exchange
 * running alongside is refused there or revoked here), and every query on
 * the lock's own transaction: nothing under the lock takes a second
 * connection (API keys audit N1). Returns whether a live grant was there.
 */
export async function disconnectLoginClient(
  ownerId: string,
  actorId: string,
  clientId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockOauthActor(tx, actorId);
    const revoked = await tx
      .update(oauthAccessTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(oauthAccessTokens.clientId, clientId),
          eq(oauthAccessTokens.ownerId, ownerId),
          eq(oauthAccessTokens.actorId, actorId),
          isNull(oauthAccessTokens.revokedAt),
        ),
      )
      .returning({ id: oauthAccessTokens.id });
    await tx
      .delete(oauthAuthCodes)
      .where(and(eq(oauthAuthCodes.clientId, clientId), eq(oauthAuthCodes.actorId, actorId)));
    return revoked.length > 0;
  });
}
