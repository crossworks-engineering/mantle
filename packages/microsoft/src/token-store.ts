/**
 * Sealed token storage + the self-refreshing access-token accessor.
 *
 * This is the heart of M0: prove a connected Microsoft account holds a token
 * that refreshes itself. Tokens are sealed with `@mantle/crypto` (AAD = row id,
 * matching `@mantle/api-keys`); only the expiry/scope metadata stays plaintext
 * so a scheduler can decide whether a refresh is due without unsealing.
 *
 * Single-flight: concurrent callers for the same account serialize on a
 * `SELECT … FOR UPDATE` of its row. The first refresher rotates the token and
 * commits; everyone else re-reads inside the lock, sees the fresh token, and
 * returns it — so Azure's refresh-token rotation is never raced (a lost rotation
 * would invalidate the account).
 */
import { and, eq } from 'drizzle-orm';
import { db, msAccounts, type MsAccount } from '@mantle/db';
import { open, seal } from '@mantle/crypto';
import { refreshTokens, type TokenSet } from './oauth';
import { resolveOAuthConfig } from './config-store';

/** Refresh this many ms before the hard expiry — covers clock skew + the
 *  round-trip so a token handed out is still valid by the time it's used. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** Persist a freshly minted token set onto an account row (seal AAD = row id).
 *  Azure rotates the refresh token on every exchange; if the response omitted
 *  one we keep the existing sealed refresh token rather than nulling it. */
function tokenUpdate(rowId: string, t: TokenSet): Record<string, unknown> {
  const set: Record<string, unknown> = {
    accessTokenEnc: seal(t.accessToken, rowId).ciphertext,
    tokenExpiresAt: t.expiresAt,
    scopes: t.scope ? t.scope.split(' ').filter(Boolean) : [],
    updatedAt: new Date(),
  };
  if (t.refreshToken) set.refreshTokenEnc = seal(t.refreshToken, rowId).ciphertext;
  return set;
}

/** Create (or re-connect) an account from the first token set after consent.
 *  Upserts on (userId, upn) so reconnecting the same identity refreshes its
 *  tokens without orphaning content already ingested under its branch. */
export async function upsertAccountFromTokens(args: {
  userId: string;
  upn: string;
  displayName: string | null;
  tenantId: string | null;
  branchPath: string;
  tokens: TokenSet;
}): Promise<MsAccount> {
  const { userId, upn, displayName, tenantId, branchPath, tokens } = args;

  // Two-step so the seal AAD can be the real row id. Insert metadata first
  // (tokens null), then seal against the returned id. The brief window where a
  // row exists without tokens is invisible — `enabled` rows without a token
  // are skipped by getValidAccessToken, and nothing syncs until M1.
  const [row] = await db
    .insert(msAccounts)
    .values({ userId, upn, displayName, tenantId, branchPath, enabled: true })
    .onConflictDoUpdate({
      target: [msAccounts.userId, msAccounts.upn],
      set: { displayName, tenantId, enabled: true, lastSyncError: null, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error('failed to upsert ms_account');

  const [updated] = await db
    .update(msAccounts)
    .set(tokenUpdate(row.id, tokens))
    .where(eq(msAccounts.id, row.id))
    .returning();
  return updated ?? row;
}

/**
 * Return a valid access token for an account, refreshing if it's within the
 * skew window of expiry. Owner-scoped — pass the user id; never trust a
 * client-supplied one.
 *
 * Returns null if the account is missing, disabled, or has no tokens yet.
 */
export async function getValidAccessToken(
  userId: string,
  accountId: string,
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(msAccounts)
    .where(and(eq(msAccounts.id, accountId), eq(msAccounts.userId, userId)))
    .limit(1);
  if (!row || !row.enabled || !row.accessTokenEnc) return null;

  // Fast path: still comfortably valid — hand it back without a transaction.
  if (row.tokenExpiresAt && row.tokenExpiresAt.getTime() - EXPIRY_SKEW_MS > Date.now()) {
    return open(row.accessTokenEnc, row.id);
  }

  // Slow path: refresh under a row lock so concurrent callers don't double-
  // refresh and race Azure's refresh-token rotation.
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(msAccounts)
      .where(eq(msAccounts.id, row.id))
      .for('update');
    if (!locked || !locked.enabled) return null;

    // Someone else refreshed while we waited for the lock.
    if (
      locked.accessTokenEnc &&
      locked.tokenExpiresAt &&
      locked.tokenExpiresAt.getTime() - EXPIRY_SKEW_MS > Date.now()
    ) {
      return open(locked.accessTokenEnc, locked.id);
    }

    if (!locked.refreshTokenEnc) return null; // can't refresh — needs reconnect
    const refreshToken = open(locked.refreshTokenEnc, locked.id);

    const cfg = await resolveOAuthConfig(userId);
    if (!cfg) throw new Error('Microsoft app is not configured — cannot refresh token');

    let fresh: TokenSet;
    try {
      fresh = await refreshTokens(cfg, refreshToken);
    } catch (err) {
      // Record the failure so the UI can prompt a reconnect; rethrow so the
      // caller (and pg-boss, once M1 lands) sees it.
      await tx
        .update(msAccounts)
        .set({
          lastSyncError: `token refresh failed: ${(err as Error).message}`.slice(0, 500),
          updatedAt: new Date(),
        })
        .where(eq(msAccounts.id, locked.id));
      throw err;
    }

    await tx
      .update(msAccounts)
      .set({ ...tokenUpdate(locked.id, fresh), lastSyncError: null })
      .where(eq(msAccounts.id, locked.id));
    return fresh.accessToken;
  });
}

/** Disconnect: drop the row (and, by FK cascade once M1 adds them, its items).
 *  Owner-scoped. Returns true if a row was removed. */
export async function deleteAccount(userId: string, accountId: string): Promise<boolean> {
  const rows = await db
    .delete(msAccounts)
    .where(and(eq(msAccounts.id, accountId), eq(msAccounts.userId, userId)))
    .returning({ id: msAccounts.id });
  return rows.length > 0;
}
