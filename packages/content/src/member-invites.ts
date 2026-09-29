/**
 * Member invites (member logins, Phase 6). An admin invites a person; the
 * person opens the invite link, sets a password, and becomes a MEMBER login.
 * The table is `member_invites` (migration 0174), modelled on pairing_codes.
 *
 * Properties the routes rely on:
 *  - the code is {@link MEMBER_INVITE_CODE_LENGTH} characters from a
 *    look-alike-free alphabet (about 92 bits), stored only as its SHA-256
 *    (`hashInviteCode`), shown to the admin once;
 *  - it lives {@link MEMBER_INVITE_TTL_MS} (72 hours) and is single use: the
 *    redeem locks the row and sets `redeemed_at` in the transaction that
 *    creates the login;
 *  - only an invite code redeems. An old 8-char team code worked in its
 *    place once until team codes were retired (migration 0178); it is now
 *    just another wrong code;
 *  - every failure to preview or redeem is the same `null`, so a caller
 *    cannot tell a wrong code from a used, revoked or expired one.
 *
 * Callers on the public routes MUST rate-limit before calling in.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { authUsers, db, memberInvites, nodeComments, nodes, teamAccessLog } from '@mantle/db';
import type { MemberInviteRow, MemberInviteState } from '@mantle/client-types';
import { getContact } from './contacts';

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

/** Mixed-case alphanumerics minus the look-alikes (0/O/o, 1/l/I) so a code
 *  read over the phone or retyped from paper survives the trip. 54 chars.
 *  The retired team codes used the same alphabet. */
export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/** Bytes at or above this are rejected: the largest multiple of the alphabet
 *  size below 256 (54 x 4 = 216). The team-code helper this came from used
 *  224 (it counted 56 characters), which made the first 8 characters of the
 *  alphabet a quarter likelier than the rest. */
const ACCEPT_BELOW = 256 - (256 % INVITE_CODE_ALPHABET.length);

export function generateInviteCode(): string {
  const out: string[] = [];
  while (out.length < MEMBER_INVITE_CODE_LENGTH) {
    // Rejection sampling: only accept bytes below the largest multiple of the
    // alphabet size so every character is equally likely.
    const bytes = randomBytes(MEMBER_INVITE_CODE_LENGTH * 2);
    for (const b of bytes) {
      if (b >= ACCEPT_BELOW) continue;
      out.push(INVITE_CODE_ALPHABET[b % INVITE_CODE_ALPHABET.length]!);
      if (out.length === MEMBER_INVITE_CODE_LENGTH) break;
    }
  }
  return out.join('');
}

/** SHA-256 hex of a code: what `member_invites.code_hash` stores. The same
 *  hash the team codes used, so invites made before 0178 still redeem. */
export function hashInviteCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** The client-app path the admin shares. The code is the only secret in it,
 *  so it rides in the FRAGMENT, never sent to a server (no access log, no
 *  Referer; client logins audit B12). The invite page still reads `?code=`
 *  (links shared before). */
export function inviteLinkPath(code: string): string {
  return `/invite#code=${encodeURIComponent(code)}`;
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
        codeHash: hashInviteCode(code),
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

/**
 * The open, unexpired invite a presented code names, by its hash. Only an
 * invite code's length is looked up: a code of any other length (an old
 * 8-char team code among them) is a miss before any query. `lock` takes the
 * invite row FOR UPDATE (the redeem).
 */
async function findRedeemable(
  exec: Exec,
  code: string,
  now: Date,
  lock: boolean,
): Promise<typeof memberInvites.$inferSelect | null> {
  const trimmed = code.trim();
  if (trimmed.length !== MEMBER_INVITE_CODE_LENGTH) return null;
  const q = exec
    .select()
    .from(memberInvites)
    .where(
      and(
        eq(memberInvites.codeHash, hashInviteCode(trimmed)),
        isNull(memberInvites.redeemedAt),
        isNull(memberInvites.revokedAt),
        gt(memberInvites.expiresAt, now),
      ),
    )
    .limit(1);
  const [row] = lock ? await q.for('update') : await q;
  return row ?? null;
}

/** For the public invite page: who a redeemable code is for. `null` for any
 *  code that cannot be redeemed; the caller must not say why. */
export async function previewMemberInvite(
  code: string,
  now = new Date(),
): Promise<{ ownerId: string; email: string; displayName: string | null } | null> {
  const found = await findRedeemable(db, code, now, false);
  if (!found) return null;
  const { ownerId, email, displayName } = found;
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
  /** Always 'invite' since team codes were retired (0178); kept in the audit
   *  detail and the access log so old and new rows read alike. */
  via: 'invite';
};

/**
 * Link a contact's old team portal history to the member login it became:
 * its `team_access_log` rows and its member `node_comments` that name no
 * login yet. Migration 0175 ran the same backfill once for every contact
 * with a member login; the redeem runs it for the contact it redeems.
 * Portal chat rows (`team_messages`) are deliberately NOT linked: a member's
 * live thread is read by login, and old portal turns must not enter it; the
 * admin views read them through the login's contact.
 */
export async function linkContactHistoryToLogin(
  exec: Exec,
  contactId: string,
  loginId: string,
): Promise<{ accessRows: number; comments: number }> {
  const access = await exec
    .update(teamAccessLog)
    .set({ loginId })
    .where(and(eq(teamAccessLog.contactId, contactId), isNull(teamAccessLog.loginId)))
    .returning({ id: teamAccessLog.id });
  const comments = await exec
    .update(nodeComments)
    .set({ loginId })
    .where(
      and(
        eq(nodeComments.contactId, contactId),
        eq(nodeComments.authorKind, 'member'),
        isNull(nodeComments.loginId),
      ),
    )
    .returning({ id: nodeComments.id });
  return { accessRows: access.length, comments: comments.length };
}

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
 * Trade an invite code for a MEMBER login, in ONE transaction: lock the
 * invite, create the login (role member, the invite's contact and name),
 * link the contact's history, mark the invite redeemed, and write the team
 * access log. `null` for any failure (unknown, used, revoked or expired
 * code; an old team code; a wrong email; a login that took the email or the
 * contact meanwhile); nothing is written then.
 */
export async function redeemMemberInvite(
  input: RedeemMemberInviteInput,
  now = new Date(),
): Promise<RedeemedMemberInvite | null> {
  try {
    return await db.transaction(async (tx) => {
      const invite = await findRedeemable(tx, input.code, now, true);
      if (!invite) return null;
      const via = 'invite' as const;
      const wanted = input.email?.trim().toLowerCase();
      if (wanted && wanted !== invite.email) return null;
      if (await loginWithEmail(invite.email, tx)) return null;
      if (invite.contactId && (await loginOnContact(invite.contactId, tx))) return null;

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

      // The contact's portal history now belongs to the login (0175 did the
      // same for contacts redeemed before it).
      if (invite.contactId) await linkContactHistoryToLogin(tx, invite.contactId, loginId);

      await tx.insert(teamAccessLog).values({
        ownerId: invite.ownerId,
        contactId: invite.contactId,
        loginId,
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
