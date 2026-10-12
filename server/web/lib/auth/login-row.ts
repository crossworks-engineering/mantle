/**
 * The one read of a login row per request (cookie or bearer). Its own module
 * so tests can stand in a login (the auth sweep's member pass mocks it), and so
 * every path reads the same columns: the role is taken from this row on every
 * request, never from a token.
 */
import { eq } from 'drizzle-orm';
import {
  authUsers,
  db,
  isWriteRefused,
  loginScopeColumns,
  mobileTokens,
  seedLoginScope,
  type LoginRole,
} from '@mantle/db';

export type LoginRow = {
  id: string;
  email: string;
  isOwner: boolean;
  displayName: string | null;
  role: LoginRole;
  contactId: string | null;
  disabledAt: Date | null;
  /** auth.users.session_epoch (0181): every cookie and asset token signed
   *  with an older one is dead. */
  sessionEpoch: number;
};

export async function loadLoginRow(id: string): Promise<LoginRow | null> {
  const [row] = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      isOwner: authUsers.isOwner,
      displayName: authUsers.displayName,
      role: authUsers.role,
      contactId: authUsers.contactId,
      disabledAt: authUsers.disabledAt,
      sessionEpoch: authUsers.sessionEpoch,
      // The login's workspaces with the same read (W6a fix round 1): the
      // request's scope, so the guard looks nothing up twice.
      ...loginScopeColumns(id, authUsers.disabledAt),
    })
    .from(authUsers)
    .where(eq(authUsers.id, id))
    .limit(1);
  if (!row) return null;
  const { scopeWs, scopeModWs, ...login } = row;
  seedLoginScope(login.id, scopeWs ?? [], scopeModWs ?? []);
  return login;
}

/** The anchor (is_owner) login's id: the brain every login belongs to. */
export async function loadAnchorId(): Promise<string | null> {
  const [row] = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.isOwner, true))
    .limit(1);
  return row?.id ?? null;
}

/** A device token's row (mobile_tokens): what makes a bearer revocable. Read
 *  here, with the login row, so the role sweeps can stand a token in. */
export type BearerTokenRow = {
  userId: string;
  revokedAt: Date | null;
  expiresAt: Date;
  /** The row a refresh replaced this one with (reuse detection). */
  rotatedTo: string | null;
};

export async function loadBearerToken(jti: string): Promise<BearerTokenRow | null> {
  const [row] = await db
    .select({
      userId: mobileTokens.userId,
      revokedAt: mobileTokens.revokedAt,
      expiresAt: mobileTokens.expiresAt,
      rotatedTo: mobileTokens.rotatedTo,
    })
    .from(mobileTokens)
    .where(eq(mobileTokens.id, jti))
    .limit(1);
  return row ?? null;
}

/** Stamp a device token as used now (the Devices card's "last used"). Best
 *  effort on a brain that refuses writes (a read-only database): the stamp
 *  is a convenience, and a bearer request must not fail on it. */
export async function touchBearerToken(jti: string): Promise<void> {
  try {
    await db.update(mobileTokens).set({ lastUsedAt: new Date() }).where(eq(mobileTokens.id, jti));
  } catch (err) {
    if (!isWriteRefused(err)) throw err;
  }
}
