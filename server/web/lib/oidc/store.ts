/**
 * The rows of company sign-in (migration 0349, docs/oidc-sign-in.md): the
 * links (issuer plus subject to a login, never an email) and each login's
 * state (the outside mark, the dismissed offer). Every write here runs at
 * the full-route spot oidc-link (docs/runtime-role.md): a link is a way in,
 * so the narrow login only reads these tables. A link is removed only by
 * an unlink (removeLink), never as a side effect of a session end.
 *
 * Called only while company sign-in is on: with the mode off no route or
 * gate reaches here (rules.ts, the routes), so the tables stay unread.
 */
import {
  and,
  authUsers,
  db,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  oidcHandoffCodes,
  oidcLoginState,
  oidcModeState,
  oidcSigninLinks,
  onFullSystemRoute,
  sql,
  type OidcHandoffIdentity,
  type OidcHandoffPurpose,
} from '@mantle/db';
import { isLoginRole } from '@mantle/client-types/role-names';
import { loginIsAdmin } from '@/lib/auth/admin-seat';

/** What the company sign-in flow needs of a login row. */
export type OidcLoginRow = Readonly<{
  id: string;
  email: string;
  sessionEpoch: number;
  isOwner: boolean;
  /** Not disabled, has an email, and a role that signs in. */
  usable: boolean;
}>;

/** The login row, or null when there is none. */
export async function oidcLoginRow(loginId: string): Promise<OidcLoginRow | null> {
  const [row] = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      sessionEpoch: authUsers.sessionEpoch,
      isOwner: authUsers.isOwner,
      role: authUsers.role,
      disabledAt: authUsers.disabledAt,
    })
    .from(authUsers)
    .where(eq(authUsers.id, loginId))
    .limit(1);
  if (!row) return null;
  const role: string = row.role;
  return {
    id: row.id,
    email: row.email,
    sessionEpoch: row.sessionEpoch,
    isOwner: row.isOwner,
    usable: !!row.email && !row.disabledAt && isLoginRole(role),
  };
}

/** Whether the login has a password to fall back on (asked only before
 *  the login removes its own link). */
export async function loginHasPassword(loginId: string): Promise<boolean> {
  const [row] = await db
    .select({ has: sql<boolean>`(${authUsers.passwordHash} <> '')` })
    .from(authUsers)
    .where(eq(authUsers.id, loginId))
    .limit(1);
  return row?.has === true;
}

/** Every write of these tables, at the one full-route spot (a link, the
 *  outside mark and a one-time code are ways in: the narrow role may not
 *  write them). */
function oidcWrite<T>(fn: () => PromiseLike<T>): Promise<T> {
  return onFullSystemRoute('oidc-link', fn);
}

/** What the required-mode rule asks of a login, in one statement: the
 *  original account, linked to `issuer`, marked outside, an Admin user. */
export async function oidcRuleFacts(
  loginId: string,
  issuer: string,
): Promise<{ owner: boolean; linked: boolean; outside: boolean; admin: boolean } | null> {
  // Joins, not correlated subqueries: a column in a raw subquery would bind
  // to the subquery's own table (both have an id).
  const [row] = await db
    .select({
      owner: authUsers.isOwner,
      linkId: oidcSigninLinks.id,
      outside: oidcLoginState.outside,
      admin: loginIsAdmin(authUsers.id),
    })
    .from(authUsers)
    .leftJoin(
      oidcSigninLinks,
      and(eq(oidcSigninLinks.loginId, authUsers.id), eq(oidcSigninLinks.issuer, issuer)),
    )
    .leftJoin(oidcLoginState, eq(oidcLoginState.loginId, authUsers.id))
    .where(eq(authUsers.id, loginId))
    .limit(1);
  if (!row) return null;
  return {
    owner: row.owner === true,
    linked: row.linkId !== null,
    outside: row.outside === true,
    admin: row.admin === true,
  };
}

/** The login a provider account is linked to, with the link's id. */
export async function linkForSubject(
  issuer: string,
  subject: string,
): Promise<{ id: string; loginId: string } | null> {
  const [row] = await db
    .select({ id: oidcSigninLinks.id, loginId: oidcSigninLinks.loginId })
    .from(oidcSigninLinks)
    .where(and(eq(oidcSigninLinks.issuer, issuer), eq(oidcSigninLinks.subject, subject)))
    .limit(1);
  return row ?? null;
}

/**
 * The login a company sign-in signs in as, read with its session epoch
 * under the login row's share lock: the link is read again once the row is
 * locked. What makes a racing unlink safe is its order: it removes the
 * link before it bumps the epoch, so a sign-in that read the link before
 * the removal mints a cookie at the old epoch, which the bump ends.
 */
export async function signInTarget(
  issuer: string,
  subject: string,
): Promise<{ linkId: string; row: OidcLoginRow } | null> {
  const first = await linkForSubject(issuer, subject);
  if (!first) return null;
  return oidcWrite(() =>
    db.transaction(async (tx) => {
      const [u] = await tx
        .select({
          id: authUsers.id,
          email: authUsers.email,
          sessionEpoch: authUsers.sessionEpoch,
          isOwner: authUsers.isOwner,
          role: authUsers.role,
          disabledAt: authUsers.disabledAt,
        })
        .from(authUsers)
        .where(eq(authUsers.id, first.loginId))
        .for('share');
      if (!u) return null;
      const [link] = await tx
        .select({ id: oidcSigninLinks.id })
        .from(oidcSigninLinks)
        .where(
          and(
            eq(oidcSigninLinks.issuer, issuer),
            eq(oidcSigninLinks.subject, subject),
            eq(oidcSigninLinks.loginId, u.id),
          ),
        )
        .limit(1);
      if (!link) return null;
      const role: string = u.role;
      return {
        linkId: link.id,
        row: {
          id: u.id,
          email: u.email,
          sessionEpoch: u.sessionEpoch,
          isOwner: u.isOwner,
          usable: !!u.email && !u.disabledAt && isLoginRole(role),
        },
      };
    }),
  );
}

/** Whether `loginId` holds a link to `issuer`. */
export async function loginLinked(loginId: string, issuer: string): Promise<boolean> {
  const [row] = await db
    .select({ id: oidcSigninLinks.id })
    .from(oidcSigninLinks)
    .where(and(eq(oidcSigninLinks.loginId, loginId), eq(oidcSigninLinks.issuer, issuer)))
    .limit(1);
  return !!row;
}

/** A login's company sign-in state (no row: not outside, nothing
 *  dismissed). */
export async function loginOidcState(
  loginId: string,
): Promise<{ outside: boolean; offerDismissedUntil: Date | null }> {
  const [row] = await db
    .select({
      outside: oidcLoginState.outside,
      offerDismissedUntil: oidcLoginState.offerDismissedUntil,
    })
    .from(oidcLoginState)
    .where(eq(oidcLoginState.loginId, loginId))
    .limit(1);
  return { outside: row?.outside ?? false, offerDismissedUntil: row?.offerDismissedUntil ?? null };
}

/** The Postgres unique-violation code, and the constraint it names. */
function uniqueViolation(err: unknown): string | null {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === 'object'; i++) {
    const o = e as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
    if (o.code === '23505') {
      const name = o.constraint_name ?? o.constraint;
      return typeof name === 'string' ? name : '';
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** What a link write answered: made (or already this login's), the
 *  account is another login's, or the login already holds another account
 *  of this provider. */
export type LinkResult = 'linked' | 'taken' | 'has-other' | 'expired';

/**
 * Link `identity` to `loginId`. Idempotent for the same pair; never moves
 * an account from one login to another, and never replaces a login's link
 * (unlink first). `epoch`: the login's session epoch when the link
 * started. The login row is read FOR SHARE in the insert's transaction, so a
 * session end (which bumps the epoch under the row's lock) is either seen
 * here ('expired', nothing linked) or waits for this link: a flow started
 * before a password change, a disable or a sign out everywhere links
 * nothing.
 */
export async function createLink(
  loginId: string,
  epoch: number,
  identity: Readonly<{ issuer: string; subject: string; tid: string | null; oid: string | null }>,
): Promise<LinkResult> {
  const existing = await linkForSubject(identity.issuer, identity.subject);
  if (existing) return existing.loginId === loginId ? 'linked' : 'taken';
  if (await loginLinked(loginId, identity.issuer)) return 'has-other';
  try {
    return await oidcWrite(() =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .select({ epoch: authUsers.sessionEpoch, disabledAt: authUsers.disabledAt })
          .from(authUsers)
          .where(eq(authUsers.id, loginId))
          .for('share');
        if (!row || row.disabledAt || row.epoch !== epoch) return 'expired' as const;
        await tx.insert(oidcSigninLinks).values({
          loginId,
          issuer: identity.issuer,
          subject: identity.subject,
          tid: identity.tid,
          oid: identity.oid,
        });
        return 'linked' as const;
      }),
    );
  } catch (err) {
    // A race with another link of the same account or login: the unique
    // indexes decide, never a second row.
    const name = uniqueViolation(err);
    if (name === null) throw err;
    return name === 'oidc_signin_links_login_issuer_key' ? 'has-other' : 'taken';
  }
}

/** How long a spent or lapsed one-time code stays before a later issue
 *  clears it, milliseconds. */
const SPENT_CODE_KEEP_MS = 60 * 60 * 1000;

/** Keep one one-time code (handoff.ts), and clear the old ones. */
export async function issueHandoffCode(row: {
  codeHash: string;
  purpose: OidcHandoffPurpose;
  loginId: string;
  epoch: number;
  challenge: string;
  identity?: OidcHandoffIdentity;
  held?: boolean;
  expiresAt: Date;
}): Promise<void> {
  await oidcWrite(async () => {
    await db
      .delete(oidcHandoffCodes)
      .where(lt(oidcHandoffCodes.expiresAt, new Date(Date.now() - SPENT_CODE_KEEP_MS)));
    await db.insert(oidcHandoffCodes).values(row);
  });
}

/** A spent one-time code. */
export type SpentHandoffCode = Readonly<{
  purpose: OidcHandoffPurpose;
  loginId: string;
  epoch: number;
  challenge: string;
  identity: OidcHandoffIdentity | null;
  held: boolean;
}>;

/**
 * Spend a one-time code, for one of `purposes`: one statement, so a code works
 * once however many requests race. The caller compares the verifier after
 * this, so a wrong guess burns the code. `login`: the login that may spend it
 * (a fresh sign-in, spent by its own session), else anyone holding the code
 * and its verifier.
 */
export async function spendHandoffCode(
  codeHash: string,
  purposes: readonly OidcHandoffPurpose[],
  login?: { loginId: string; epoch: number },
): Promise<SpentHandoffCode | null> {
  const [row] = await oidcWrite(() =>
    db
      .update(oidcHandoffCodes)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(oidcHandoffCodes.codeHash, codeHash),
          inArray(oidcHandoffCodes.purpose, [...purposes]),
          isNull(oidcHandoffCodes.usedAt),
          gt(oidcHandoffCodes.expiresAt, sql`now()`),
          ...(login
            ? [eq(oidcHandoffCodes.loginId, login.loginId), eq(oidcHandoffCodes.epoch, login.epoch)]
            : []),
        ),
      )
      .returning({
        purpose: oidcHandoffCodes.purpose,
        loginId: oidcHandoffCodes.loginId,
        epoch: oidcHandoffCodes.epoch,
        challenge: oidcHandoffCodes.challenge,
        identity: oidcHandoffCodes.identity,
        held: oidcHandoffCodes.held,
      }),
  );
  return row ?? null;
}

/** Stamp a link's last use (a sign-in). */
export async function touchLink(linkId: string): Promise<void> {
  await oidcWrite(() =>
    db
      .update(oidcSigninLinks)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(oidcSigninLinks.id, linkId)),
  );
}

/** Remove `loginId`'s link to `issuer`; whether there was one. */
export async function removeLink(loginId: string, issuer: string): Promise<boolean> {
  const rows = await oidcWrite(() =>
    db
      .delete(oidcSigninLinks)
      .where(and(eq(oidcSigninLinks.loginId, loginId), eq(oidcSigninLinks.issuer, issuer)))
      .returning({ id: oidcSigninLinks.id }),
  );
  return rows.length > 0;
}

/** Mark a login an outside person (keeps a password in required mode), or
 *  clear the mark. */
export async function setOutside(loginId: string, outside: boolean): Promise<void> {
  await oidcWrite(() =>
    db
      .insert(oidcLoginState)
      .values({ loginId, outside })
      .onConflictDoUpdate({
        target: oidcLoginState.loginId,
        set: { outside, updatedAt: sql`now()` },
      }),
  );
}

/** Hide the link offer from `loginId` until `until`. */
export async function dismissOffer(loginId: string, until: Date): Promise<void> {
  await oidcWrite(() =>
    db
      .insert(oidcLoginState)
      .values({ loginId, offerDismissedUntil: until })
      .onConflictDoUpdate({
        target: oidcLoginState.loginId,
        set: { offerDismissedUntil: until, updatedAt: sql`now()` },
      }),
  );
}

/** One login in the admin's company sign-in list. */
export type OidcLoginSummary = Readonly<{
  loginId: string;
  email: string;
  displayName: string | null;
  /** The original account: keeps its password in every mode. */
  owner: boolean;
  /** An Admin user now (an outside mark is not honoured for one). */
  admin: boolean;
  outside: boolean;
  linked: boolean;
  linkedAt: string | null;
  lastUsedAt: string | null;
}>;

/** The mode the last boot with company sign-in on applied, or null (never
 *  on before). */
export async function appliedMode(): Promise<string | null> {
  const [row] = await db.select({ mode: oidcModeState.mode }).from(oidcModeState).limit(1);
  return row?.mode ?? null;
}

/** Record the mode this boot applied. */
export async function recordAppliedMode(mode: 'optional' | 'required'): Promise<void> {
  await oidcWrite(() =>
    db
      .insert(oidcModeState)
      .values({ id: true, mode })
      .onConflictDoUpdate({ target: oidcModeState.id, set: { mode, changedAt: sql`now()` } }),
  );
}

/** Whether `loginId` is an Admin user now (a user of the Admin workspace:
 *  membership decides, mantle_login_is_admin). */
export async function loginIsAdminUser(loginId: string): Promise<boolean> {
  const [row] = await db
    .select({ admin: loginIsAdmin(loginId) })
    .from(authUsers)
    .where(eq(authUsers.id, loginId))
    .limit(1);
  return row?.admin === true;
}

/** Every active login (not disabled, a role that signs in) with its link
 *  to `issuer` and its outside mark, the original account first. */
export async function activeLoginsWithLinks(issuer: string): Promise<OidcLoginSummary[]> {
  const rows = await db
    .select({
      loginId: authUsers.id,
      email: authUsers.email,
      displayName: authUsers.displayName,
      owner: authUsers.isOwner,
      role: authUsers.role,
      admin: loginIsAdmin(authUsers.id),
      outside: oidcLoginState.outside,
      linkedAt: oidcSigninLinks.createdAt,
      lastUsedAt: oidcSigninLinks.lastUsedAt,
    })
    .from(authUsers)
    .leftJoin(
      oidcSigninLinks,
      and(eq(oidcSigninLinks.loginId, authUsers.id), eq(oidcSigninLinks.issuer, issuer)),
    )
    .leftJoin(oidcLoginState, eq(oidcLoginState.loginId, authUsers.id))
    .where(isNull(authUsers.disabledAt))
    .orderBy(sql`${authUsers.isOwner} desc`, authUsers.email);
  return rows
    .filter((r) => isLoginRole(r.role as string))
    .map((r) => ({
      loginId: r.loginId,
      email: r.email,
      displayName: r.displayName ?? null,
      owner: r.owner,
      admin: r.admin === true,
      outside: r.outside ?? false,
      linked: r.linkedAt !== null,
      linkedAt: r.linkedAt ? r.linkedAt.toISOString() : null,
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    }));
}
