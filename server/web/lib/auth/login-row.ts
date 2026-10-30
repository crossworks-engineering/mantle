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
import { passwordPolicyMin } from '@mantle/config';
import { loginIsAdmin } from './admin-seat';

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
  /** auth.users.must_change_password (0347): the box password policy holds
   *  the login to the change-password step while the rule is in force
   *  (password-hold.ts). */
  mustChangePassword: boolean;
  /** auth.users.password_checked_min (0347): read with the flag. */
  passwordCheckedMin: number | null;
  /** A user of the brain's live Admin workspace now, the login enabled
   *  (mantle_login_is_admin, 0304), read with the row: the
   *  second half of an Admin login (session.ts adminLogin). */
  adminMember: boolean;
};

/** Runs unscoped: every caller finds a credential's login before the
 *  request enters a scope (the session cookie, a device or asset token,
 *  the render cookie, an API key, a frame ticket's re-check). A viewer
 *  role reads no auth.users row and may not EXECUTE mantle_login_is_admin,
 *  so inside a scope this select is refused (42501) and throws: it never
 *  answers a guess. */
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
      // The box password rule's columns (0347), read only while a rule is
      // set: a box with none reads the row as before.
      ...passwordRuleColumns(),
      // Membership of Admin with the same read: the bound id, as the
      // scope columns take it.
      adminMember: loginIsAdmin(id),
      // The login's workspaces with the same read: the
      // request's scope, so the guard looks nothing up twice.
      ...loginScopeColumns(id, authUsers.disabledAt),
    })
    .from(authUsers)
    .where(eq(authUsers.id, id))
    .limit(1);
  if (!row) return null;
  const { scopeWs, scopeModWs, adminMember, ...login } = row;
  seedLoginScope(login.id, scopeWs ?? [], scopeModWs ?? []);
  return {
    ...login,
    mustChangePassword: login.mustChangePassword === true,
    passwordCheckedMin: login.passwordCheckedMin ?? null,
    adminMember: adminMember === true,
  };
}

/**
 * The box password rule's columns of auth.users (0347:
 * must_change_password, password_checked_min), to spread into a select of
 * the login row: only while MANTLE_POLICY_PASSWORD_MIN sets a rule. With
 * none, nothing: the select is the one from before the policy (and runs on
 * a database a migration behind).
 */
export function passwordRuleColumns(): {
  mustChangePassword?: typeof authUsers.mustChangePassword;
  passwordCheckedMin?: typeof authUsers.passwordCheckedMin;
} {
  return passwordPolicyMin() === null
    ? {}
    : {
        mustChangePassword: authUsers.mustChangePassword,
        passwordCheckedMin: authUsers.passwordCheckedMin,
      };
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
