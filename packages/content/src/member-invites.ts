/**
 * Member invites (member logins, Phase 6). An admin invites a person; the
 * person opens the invite link, sets a password, and becomes a MEMBER login.
 * The table is `member_invites` (migration 0174), modelled on pairing_codes.
 *
 * Properties the routes rely on:
 *  - the code is {@link MEMBER_INVITE_CODE_LENGTH} characters from the team
 *    token alphabet (about 93 bits), stored only as its hash (the team token
 *    hash), shown to the admin once;
 *  - it lives {@link MEMBER_INVITE_TTL_MS} (72 hours) and is single use: the
 *    redeem locks the row and sets `redeemed_at` in the transaction that
 *    creates the login;
 *  - an old 8-char team code works in place of the invite code, but only
 *    while its contact has an open invite, and only once: the redeem deletes
 *    the contact's `contact_team_tokens` row (Jason, 2026-09-28);
 *  - every failure to preview or redeem is the same `null`, so a caller
 *    cannot tell a wrong code from a used, revoked or expired one.
 *
 * Callers on the public routes MUST rate-limit before calling in.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull, or, sql, type SQL } from 'drizzle-orm';
import { authUsers, contactTeamTokens, db, memberInvites, nodes, teamAccessLog } from '@mantle/db';
import type { MemberInviteRow, MemberInviteState } from '@mantle/client-types';
import { getContact } from './contacts';
import { generateAlphabetCode, hashTeamToken, verifyTeamToken } from './team-tokens';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = Tx | typeof db;

export const MEMBER_INVITE_CODE_LENGTH = 16;
export const MEMBER_INVITE_TTL_MS = 72 * 60 * 60 * 1000;
const LIST_LIMIT = 200;

/** A plain address (not a contact's `@domain` wildcard entry). */
const ADDRESS_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type MemberInviteErrorReason =
  'contact-not-found' | 'contact-has-login' | 'no-email' | 'email-has-login';

/** A create the admin can fix. The route maps `reason` to a status. */
export class MemberInviteError extends Error {
  constructor(
    readonly reason: MemberInviteErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'MemberInviteError';
  }
}

export function generateInviteCode(): string {
  return generateAlphabetCode(MEMBER_INVITE_CODE_LENGTH);
}

/** The client-app path the admin shares. The code is the only secret in it. */
export function inviteLinkPath(code: string): string {
  return `/invite?code=${encodeURIComponent(code)}`;
}

function stateOf(r: { redeemedAt: Date | null; expiresAt: Date }, now: Date): MemberInviteState {
  if (r.redeemedAt) return 'redeemed';
  return r.expiresAt.getTime() <= now.getTime() ? 'expired' : 'open';
}

type InviteFields = {
  id: string;
  contactId: string | null;
  email: string;
  displayName: string | null;
  createdAt: Date;
  expiresAt: Date;
  redeemedAt: Date | null;
  redeemedLoginId: string | null;
  createdBy: string | null;
};

function rowOf(r: InviteFields, contactName: string | null, now: Date): MemberInviteRow {
  return {
    id: r.id,
    contactId: r.contactId,
    contactName,
    email: r.email,
    displayName: r.displayName,
    state: stateOf(r, now),
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    redeemedAt: r.redeemedAt ? r.redeemedAt.toISOString() : null,
    redeemedLoginId: r.redeemedLoginId,
    createdBy: r.createdBy,
  };
}

async function loginWithEmail(email: string, exec: Exec = db): Promise<boolean> {
  const [row] = await exec
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(sql`lower(${authUsers.email}) = ${email}`)
    .limit(1);
  return !!row;
}

async function loginOnContact(contactId: string, exec: Exec = db): Promise<boolean> {
  const [row] = await exec
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.contactId, contactId))
    .limit(1);
  return !!row;
}

export type CreateMemberInviteInput = {
  contactId?: string;
  email?: string;
  displayName?: string;
  /** The admin login making it. */
  createdBy: string;
};

/**
 * Mint an invite. With a contact: it must be a contact of this brain with no
 * login linked; the email and name default to the contact's. Refused when a
 * login already has the email. Any open invite for the same contact or email
 * is revoked in the same transaction, so a new invite replaces the old one
 * (an expired invite still holds the one-open-per-contact slot). Returns the
 * PLAINTEXT code, once.
 */
export async function createMemberInvite(
  ownerId: string,
  input: CreateMemberInviteInput,
  now = new Date(),
): Promise<{ invite: MemberInviteRow; code: string }> {
  let email = input.email?.trim().toLowerCase() || null;
  let displayName = input.displayName?.trim() || null;
  let contactName: string | null = null;
  if (input.contactId) {
    const contact = await getContact(ownerId, input.contactId);
    if (!contact) throw new MemberInviteError('contact-not-found', 'Contact not found.');
    if (await loginOnContact(contact.id)) {
      throw new MemberInviteError('contact-has-login', 'That contact already has a login.');
    }
    contactName = contact.title;
    email ??= contact.emails.find((e) => ADDRESS_RE.test(e))?.toLowerCase() ?? null;
    displayName ??= contact.title.trim() || null;
  }
  if (!email || !ADDRESS_RE.test(email)) {
    throw new MemberInviteError('no-email', 'Enter an email address for the invite.');
  }
  if (await loginWithEmail(email)) {
    throw new MemberInviteError('email-has-login', 'A user with that email already exists.');
  }

  const code = generateInviteCode();
  const expiresAt = new Date(now.getTime() + MEMBER_INVITE_TTL_MS);
  const row = await db.transaction(async (tx) => {
    const sameTarget = input.contactId
      ? or(eq(memberInvites.contactId, input.contactId), eq(memberInvites.email, email))
      : eq(memberInvites.email, email);
    await tx
      .update(memberInvites)
      .set({ revokedAt: now })
      .where(
        and(
          eq(memberInvites.ownerId, ownerId),
          isNull(memberInvites.redeemedAt),
          isNull(memberInvites.revokedAt),
          sameTarget,
        ),
      );
    const [inserted] = await tx
      .insert(memberInvites)
      .values({
        ownerId,
        contactId: input.contactId ?? null,
        email,
        displayName,
        codeHash: hashTeamToken(code),
        createdBy: input.createdBy,
        createdAt: now,
        expiresAt,
      })
      .returning();
    return inserted!;
  });
  return { invite: rowOf(row, contactName, now), code };
}

/** The brain's invites, newest first, without codes. Revoked ones (including
 *  those a newer invite replaced) are left out. */
export async function listMemberInvites(
  ownerId: string,
  now = new Date(),
): Promise<MemberInviteRow[]> {
  const rows = await db
    .select({
      id: memberInvites.id,
      contactId: memberInvites.contactId,
      email: memberInvites.email,
      displayName: memberInvites.displayName,
      createdAt: memberInvites.createdAt,
      expiresAt: memberInvites.expiresAt,
      redeemedAt: memberInvites.redeemedAt,
      redeemedLoginId: memberInvites.redeemedLoginId,
      createdBy: memberInvites.createdBy,
      contactName: nodes.title,
    })
    .from(memberInvites)
    .leftJoin(nodes, eq(nodes.id, memberInvites.contactId))
    .where(and(eq(memberInvites.ownerId, ownerId), isNull(memberInvites.revokedAt)))
    .orderBy(desc(memberInvites.createdAt))
    .limit(LIST_LIMIT);
  return rows.map(({ contactName, ...r }) => rowOf(r, contactName ?? null, now));
}

/** Revoke an invite that has not been redeemed. False when there is no such
 *  invite in this brain (or it is already redeemed or revoked). */
export async function revokeMemberInvite(
  ownerId: string,
  id: string,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(memberInvites)
    .set({ revokedAt: now })
    .where(
      and(
        eq(memberInvites.id, id),
        eq(memberInvites.ownerId, ownerId),
        isNull(memberInvites.redeemedAt),
        isNull(memberInvites.revokedAt),
      ),
    )
    .returning({ id: memberInvites.id });
  return rows.length > 0;
}

type Redeemable = {
  invite: typeof memberInvites.$inferSelect;
  via: 'invite' | 'team-code';
};

/**
 * The open, unexpired invite a presented code names: an invite code by its
 * hash, else a team code (verifyTeamToken) whose contact has an open invite.
 * `lock` takes the invite row FOR UPDATE (the redeem).
 */
async function findRedeemable(
  exec: Exec,
  code: string,
  now: Date,
  lock: boolean,
): Promise<Redeemable | null> {
  const trimmed = code.trim();
  if (trimmed.length < 6 || trimmed.length > 64) return null;
  const pick = async (match: SQL | undefined) => {
    const where = and(
      match,
      isNull(memberInvites.redeemedAt),
      isNull(memberInvites.revokedAt),
      gt(memberInvites.expiresAt, now),
    );
    const q = exec.select().from(memberInvites).where(where).limit(1);
    const [row] = lock ? await q.for('update') : await q;
    return row ?? null;
  };

  const byCode = await pick(eq(memberInvites.codeHash, hashTeamToken(trimmed)));
  if (byCode) return { invite: byCode, via: 'invite' };

  const team = await verifyTeamToken(trimmed, exec);
  if (!team) return null;
  const byContact = await pick(
    and(eq(memberInvites.ownerId, team.ownerId), eq(memberInvites.contactId, team.contactId)),
  );
  return byContact ? { invite: byContact, via: 'team-code' } : null;
}

/** For the public invite page: who a redeemable code is for. `null` for any
 *  code that cannot be redeemed; the caller must not say why. */
export async function previewMemberInvite(
  code: string,
  now = new Date(),
): Promise<{ ownerId: string; email: string; displayName: string | null } | null> {
  const found = await findRedeemable(db, code, now, false);
  if (!found) return null;
  const { ownerId, email, displayName } = found.invite;
  return { ownerId, email, displayName };
}

export type RedeemMemberInviteInput = {
  code: string;
  /** Already hashed by the caller (bcrypt, as the users route does). */
  passwordHash: string;
  /** When given, must be the invite's email (case-insensitive). The login is
   *  always created with the invite's email, never one the caller picks. */
  email?: string;
};

export type RedeemedMemberInvite = {
  loginId: string;
  email: string;
  ownerId: string;
  contactId: string | null;
  inviteId: string;
  via: 'invite' | 'team-code';
};

/** Thrown inside the redeem transaction to roll it back as a plain failure. */
class RedeemAbort extends Error {}

function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 3 && e && typeof e === 'object'; i += 1) {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Trade a code for a MEMBER login, in ONE transaction: lock the invite,
 * delete the contact's team code, create the login (role member, the
 * invite's contact and name), mark the invite redeemed, and write the team
 * access log. `null` for any failure (unknown, used, revoked or expired
 * code; a team code with no open invite; a wrong email; a login that took
 * the email or the contact meanwhile); nothing is written then.
 */
export async function redeemMemberInvite(
  input: RedeemMemberInviteInput,
  now = new Date(),
): Promise<RedeemedMemberInvite | null> {
  try {
    return await db.transaction(async (tx) => {
      const found = await findRedeemable(tx, input.code, now, true);
      if (!found) return null;
      const { invite, via } = found;
      const wanted = input.email?.trim().toLowerCase();
      if (wanted && wanted !== invite.email) return null;
      if (await loginWithEmail(invite.email, tx)) return null;
      if (invite.contactId && (await loginOnContact(invite.contactId, tx))) return null;

      // Redeeming deletes the contact's old team code: the person is a login
      // now. On the team-code path the row must still be there, so a code
      // revoked a moment ago does not redeem.
      if (invite.contactId) {
        const deleted = await tx
          .delete(contactTeamTokens)
          .where(
            and(
              eq(contactTeamTokens.ownerId, invite.ownerId),
              eq(contactTeamTokens.contactId, invite.contactId),
            ),
          )
          .returning({ id: contactTeamTokens.id });
        if (via === 'team-code' && deleted.length === 0) throw new RedeemAbort();
      }

      const loginId = randomUUID();
      await tx.insert(authUsers).values({
        id: loginId,
        email: invite.email,
        passwordHash: input.passwordHash,
        displayName: invite.displayName,
        isOwner: false,
        role: 'member',
        contactId: invite.contactId,
      });

      const marked = await tx
        .update(memberInvites)
        .set({ redeemedAt: now, redeemedLoginId: loginId })
        .where(and(eq(memberInvites.id, invite.id), isNull(memberInvites.redeemedAt)))
        .returning({ id: memberInvites.id });
      if (marked.length === 0) throw new RedeemAbort();

      await tx.insert(teamAccessLog).values({
        ownerId: invite.ownerId,
        contactId: invite.contactId,
        kind: 'auth',
        detail: { event: 'invite_redeemed', via, inviteId: invite.id, loginId },
      });

      return {
        loginId,
        email: invite.email,
        ownerId: invite.ownerId,
        contactId: invite.contactId,
        inviteId: invite.id,
        via,
      };
    });
  } catch (err) {
    // A lost race (the unique email or contact index, or the invite flipped
    // under us) rolls everything back and reads as any other failure.
    if (err instanceof RedeemAbort || isUniqueViolation(err)) return null;
    throw err;
  }
}
