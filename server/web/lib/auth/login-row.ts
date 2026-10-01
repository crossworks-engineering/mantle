/**
 * The one read of a login row per request (cookie or bearer). Its own module
 * so tests can stand in a login (the auth sweep's member pass mocks it), and so
 * every path reads the same columns: the role is taken from this row on every
 * request, never from a token.
 */
import { and, eq } from 'drizzle-orm';
import { authUsers, db, mobileTokens, spaces, type LoginRole } from '@mantle/db';

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
    })
    .from(authUsers)
    .where(eq(authUsers.id, id))
    .limit(1);
  return row ?? null;
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

/**
 * The login's personal space (member logins Phase 2): made with the login by
 * a trigger (migration 0165), so this only ever creates one for a row that
 * predates it on a box mid-upgrade.
 */
export async function loadPersonalSpaceId(loginId: string): Promise<string | null> {
  const find = async () =>
    (
      await db
        .select({ id: spaces.id })
        .from(spaces)
        .where(and(eq(spaces.loginId, loginId), eq(spaces.kind, 'personal')))
        .limit(1)
    )[0]?.id ?? null;
  const found = await find();
  if (found) return found;
  await db.insert(spaces).values({ kind: 'personal', loginId }).onConflictDoNothing();
  return find();
}

/** A device token's row (mobile_tokens): what makes a bearer revocable. Read
 *  here, with the login row, so the role sweeps can stand a token in. */
export type BearerTokenRow = { userId: string; revokedAt: Date | null; expiresAt: Date };

export async function loadBearerToken(jti: string): Promise<BearerTokenRow | null> {
  const [row] = await db
    .select({
      userId: mobileTokens.userId,
      revokedAt: mobileTokens.revokedAt,
      expiresAt: mobileTokens.expiresAt,
    })
    .from(mobileTokens)
    .where(eq(mobileTokens.id, jti))
    .limit(1);
  return row ?? null;
}

/** Stamp a device token as used now (the Devices card's "last used"). */
export async function touchBearerToken(jti: string): Promise<void> {
  await db.update(mobileTokens).set({ lastUsedAt: new Date() }).where(eq(mobileTokens.id, jti));
}
