/**
 * Client logins (client logins, Phase C2; plan section 4). A CLIENT login is
 * a person at the brain's one client company. It has no password: an admin
 * makes the login in Team admin > Clients, then issues it a sign-in LINK.
 * The client opens the link, types their email as a check, and gets a
 * 30-day session. Emailed codes follow in C2b (the same table, kind
 * 'email').
 *
 * Properties the routes rely on:
 *  - adding a client and issuing a link are refused until an admin has
 *    acknowledged "What clients see" and nothing went to client since
 *    (`clientReportAcknowledged`), reason `report-not-acknowledged`;
 *  - a login made here always has role client, set explicitly (the column
 *    default is admin), and a password hash nobody knows (the route makes
 *    it), so password sign-in can never open it;
 *  - a link code is an invite code (about 92 bits, `generateInviteCode`),
 *    stored only as its SHA-256, shown to the admin once, 72 hours, one use;
 *    a new link revokes the login's older open ones;
 *  - the redeem locks the row, and succeeds only for an unused, unrevoked,
 *    unexpired link of an active client login whose email matches
 *    (case-insensitive); every failure is the same `null`.
 *
 * Callers on the public route MUST rate-limit before calling in.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { isUniqueViolation, authUsers, clientSigninCodes, db } from '@mantle/db';
import type {
  ClientAdminRefusedReason,
  ClientLoginRow,
  ClientSigninLinkRow,
} from '@mantle/client-types';
import { clientReportAcknowledged } from './client-report';
import { getContact } from './contacts';
import { MEMBER_INVITE_CODE_LENGTH, generateInviteCode, hashInviteCode } from './member-invites';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = Tx | typeof db;

/** How long an admin-issued sign-in link lives. */
export const CLIENT_SIGNIN_LINK_TTL_MS = 72 * 60 * 60 * 1000;
const LIST_LIMIT = 500;

/** A plain address (not a contact's `@domain` wildcard entry). */
const ADDRESS_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** An admin action the admin can fix. The route maps `reason` to a status. */
export class ClientLoginError extends Error {
  constructor(
    readonly reason: ClientAdminRefusedReason,
    message: string,
  ) {
    super(message);
    this.name = 'ClientLoginError';
  }
}

/** The client-app path the admin hands the client. The code is its only
 *  secret, so it rides in the FRAGMENT: a browser never sends a fragment to
 *  any server, so it stays out of access logs and Referer headers (audit
 *  B12). The client page also still reads `?code=` (links issued before). */
export function clientSigninLinkPath(code: string): string {
  return `/client-signin#code=${encodeURIComponent(code)}`;
}

async function requireAcknowledged(ownerId: string): Promise<void> {
  if (!(await clientReportAcknowledged(ownerId))) {
    throw new ClientLoginError(
      'report-not-acknowledged',
      'Check "What clients see" in Team admin first.',
    );
  }
}

function linkRowOf(r: { id: string; createdAt: Date; expiresAt: Date }): ClientSigninLinkRow {
  return {
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  };
}

/** A link that can still be redeemed: unused, unrevoked, unexpired. */
function openLink(now: Date) {
  return and(
    eq(clientSigninCodes.kind, 'admin_link'),
    isNull(clientSigninCodes.usedAt),
    isNull(clientSigninCodes.revokedAt),
    gt(clientSigninCodes.expiresAt, now),
  );
}

/**
 * The brain's client logins, newest first, with each one's open link (never
 * a code) and when a link of it was last used.
 */
export async function listClientLogins(
  ownerId: string,
  now = new Date(),
): Promise<ClientLoginRow[]> {
  const logins = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      displayName: authUsers.displayName,
      contactId: authUsers.contactId,
      disabledAt: authUsers.disabledAt,
      createdAt: authUsers.createdAt,
      lastLoginAt: authUsers.lastLoginAt,
    })
    .from(authUsers)
    .where(eq(authUsers.role, 'client'))
    .orderBy(desc(authUsers.createdAt))
    .limit(LIST_LIMIT);
  if (logins.length === 0) return [];
  const ids = logins.map((l) => l.id);
  const [open, used] = await Promise.all([
    db
      .select({
        loginId: clientSigninCodes.loginId,
        id: clientSigninCodes.id,
        createdAt: clientSigninCodes.createdAt,
        expiresAt: clientSigninCodes.expiresAt,
      })
      .from(clientSigninCodes)
      .where(
        and(
          eq(clientSigninCodes.ownerId, ownerId),
          inArray(clientSigninCodes.loginId, ids),
          openLink(now),
        ),
      )
      .orderBy(desc(clientSigninCodes.createdAt)),
    db
      .select({
        loginId: clientSigninCodes.loginId,
        usedAt: sql<Date>`max(${clientSigninCodes.usedAt})`.mapWith(
          (v: string | Date) => new Date(v),
        ),
      })
      .from(clientSigninCodes)
      .where(
        and(
          eq(clientSigninCodes.ownerId, ownerId),
          inArray(clientSigninCodes.loginId, ids),
          sql`${clientSigninCodes.usedAt} is not null`,
        ),
      )
      .groupBy(clientSigninCodes.loginId),
  ]);
  const openBy = new Map<string, ClientSigninLinkRow>();
  for (const o of open) if (!openBy.has(o.loginId)) openBy.set(o.loginId, linkRowOf(o));
  const usedBy = new Map(used.map((u) => [u.loginId, u.usedAt]));
  return logins.map((l) => ({
    id: l.id,
    email: l.email,
    displayName: l.displayName,
    contactId: l.contactId,
    disabled: l.disabledAt !== null,
    createdAt: l.createdAt.toISOString(),
    lastLoginAt: l.lastLoginAt ? l.lastLoginAt.toISOString() : null,
    openLink: openBy.get(l.id) ?? null,
    lastLinkUsedAt: usedBy.get(l.id)?.toISOString() ?? null,
  }));
}

async function clientRow(loginId: string, now: Date, ownerId: string): Promise<ClientLoginRow> {
  const rows = await listClientLogins(ownerId, now);
  const row = rows.find((r) => r.id === loginId);
  if (!row) throw new ClientLoginError('not-a-client', 'That login is not a client.');
  return row;
}

export type CreateClientLoginInput = {
  contactId?: string;
  email?: string;
  displayName?: string;
  /** A bcrypt hash of a random secret nobody keeps (the route makes it):
   *  password_hash is NOT NULL, and no password may open a client. */
  unusablePasswordHash: string;
  /** The admin login making it. */
  createdBy: string;
};

/**
 * Make a CLIENT login. Refused until "What clients see" is acknowledged.
 * With a contact: it must be a contact of this brain with no login linked;
 * the email and name default to the contact's, and a typed email must be
 * one of the contact's addresses (`email-not-on-contact`). Refused when a
 * login already has the email. The login is made with role client, set here, never the
 * column default.
 */
export async function createClientLogin(
  ownerId: string,
  input: CreateClientLoginInput,
  now = new Date(),
): Promise<ClientLoginRow> {
  await requireAcknowledged(ownerId);
  let email = input.email?.trim().toLowerCase() || null;
  let displayName = input.displayName?.trim() || null;
  if (input.contactId) {
    const contact = await getContact(ownerId, input.contactId);
    if (!contact) throw new ClientLoginError('contact-not-found', 'Contact not found.');
    if (await loginOnContact(contact.id)) {
      throw new ClientLoginError('contact-has-login', 'That contact already has a login.');
    }
    const addresses = contact.emails
      .filter((e) => ADDRESS_RE.test(e))
      .map((e) => e.trim().toLowerCase());
    // A typed email must be one of the contact's own addresses: the mail
    // gates know a client by its contact, so a login under another address
    // would be a stranger to them (client logins audit B26). Refused, never
    // added to the contact behind the admin's back.
    if (email && !addresses.includes(email)) {
      throw new ClientLoginError(
        'email-not-on-contact',
        "That email is not one of the contact's addresses. Add it to the contact first, or leave the email empty.",
      );
    }
    email ??= addresses[0] ?? null;
    displayName ??= contact.title.trim() || null;
  }
  if (!email || !ADDRESS_RE.test(email)) {
    throw new ClientLoginError('no-email', 'Enter an email address for the client.');
  }
  if (await loginWithEmail(email)) {
    throw new ClientLoginError('email-has-login', 'A user with that email already exists.');
  }
  try {
    const loginId = randomUUID();
    await db.insert(authUsers).values({
      id: loginId,
      email,
      passwordHash: input.unusablePasswordHash,
      displayName,
      isOwner: false,
      role: 'client',
      contactId: input.contactId ?? null,
    });
    return await clientRow(loginId, now, ownerId);
  } catch (err) {
    // A login that took the email or the contact meanwhile (unique index).
    if (isUniqueViolation(err)) {
      throw new ClientLoginError('email-has-login', 'A user with that email already exists.');
    }
    throw err;
  }
}

/** The client login `loginId`, when it is an ACTIVE client (not disabled). */
async function activeClient(
  exec: Exec,
  loginId: string,
): Promise<{ id: string; email: string; sessionEpoch: number } | null> {
  const [row] = await exec
    .select({
      id: authUsers.id,
      email: authUsers.email,
      role: authUsers.role,
      disabledAt: authUsers.disabledAt,
      sessionEpoch: authUsers.sessionEpoch,
    })
    .from(authUsers)
    .where(eq(authUsers.id, loginId))
    .limit(1);
  if (!row || row.role !== 'client' || row.disabledAt !== null || !row.email) return null;
  return { id: row.id, email: row.email, sessionEpoch: row.sessionEpoch };
}

/**
 * Issue a sign-in link for an active client login: 72 hours, one use. The
 * login's older open links are revoked in the same transaction. Refused
 * until the report is acknowledged. Returns the PLAINTEXT code, once.
 */
export async function issueClientSigninLink(
  ownerId: string,
  loginId: string,
  createdBy: string,
  now = new Date(),
): Promise<{ link: ClientSigninLinkRow; code: string }> {
  await requireAcknowledged(ownerId);
  const code = generateInviteCode();
  const expiresAt = new Date(now.getTime() + CLIENT_SIGNIN_LINK_TTL_MS);
  const row = await db.transaction(async (tx) => {
    const client = await activeClient(tx, loginId);
    if (!client) {
      throw new ClientLoginError('not-a-client', 'That login is not an active client.');
    }
    await tx
      .update(clientSigninCodes)
      .set({ revokedAt: now })
      .where(
        and(
          eq(clientSigninCodes.loginId, loginId),
          eq(clientSigninCodes.kind, 'admin_link'),
          isNull(clientSigninCodes.usedAt),
          isNull(clientSigninCodes.revokedAt),
        ),
      );
    const [inserted] = await tx
      .insert(clientSigninCodes)
      .values({
        ownerId,
        loginId,
        kind: 'admin_link',
        codeHash: hashInviteCode(code),
        expiresAt,
        createdBy,
        createdAt: now,
      })
      .returning();
    return inserted!;
  });
  return { link: linkRowOf(row), code };
}

/** Revoke the login's open sign-in links. False when it had none. */
export async function revokeClientSigninLink(
  ownerId: string,
  loginId: string,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(clientSigninCodes)
    .set({ revokedAt: now })
    .where(
      and(
        eq(clientSigninCodes.ownerId, ownerId),
        eq(clientSigninCodes.loginId, loginId),
        eq(clientSigninCodes.kind, 'admin_link'),
        isNull(clientSigninCodes.usedAt),
        isNull(clientSigninCodes.revokedAt),
      ),
    )
    .returning({ id: clientSigninCodes.id });
  return rows.length > 0;
}

/**
 * Revoke EVERY open way in the login still holds: its unused sign-in links
 * and its unused emailed codes alike (client logins audit B14). Disabling a
 * login and ending its sessions call this in the same transaction, so a
 * link issued before cannot come back when the login is enabled again, and
 * "End sessions" leaves nothing to sign straight back in with. Returns how
 * many it revoked.
 */
export async function revokeOpenClientSignins(
  exec: Exec,
  loginId: string,
  now = new Date(),
): Promise<number> {
  const rows = await exec
    .update(clientSigninCodes)
    .set({ revokedAt: now })
    .where(
      and(
        eq(clientSigninCodes.loginId, loginId),
        isNull(clientSigninCodes.usedAt),
        isNull(clientSigninCodes.revokedAt),
      ),
    )
    .returning({ id: clientSigninCodes.id });
  return rows.length;
}

export type RedeemedClientSigninLink = {
  loginId: string;
  email: string;
  ownerId: string;
  linkId: string;
  /** The login's session epoch now: the cookie is minted with it. */
  sessionEpoch: number;
};

/**
 * Trade a sign-in link code plus the client's email for a session, in ONE
 * transaction: lock the link, check the login (an active client whose email
 * matches, case-insensitive), mark the link used. `null` for any failure
 * (unknown, used, revoked or expired code; a wrong email; a disabled login,
 * one that is no longer a client); nothing is written then.
 */
export async function redeemClientSigninLink(
  input: { code: string; email: string },
  now = new Date(),
): Promise<RedeemedClientSigninLink | null> {
  const code = input.code.trim();
  const email = input.email.trim().toLowerCase();
  if (code.length !== MEMBER_INVITE_CODE_LENGTH || !email) return null;
  return db.transaction(async (tx) => {
    const [link] = await tx
      .select()
      .from(clientSigninCodes)
      .where(and(eq(clientSigninCodes.codeHash, hashInviteCode(code)), openLink(now)))
      .limit(1)
      .for('update');
    if (!link) return null;
    const client = await activeClient(tx, link.loginId);
    if (!client || client.email.trim().toLowerCase() !== email) return null;
    const marked = await tx
      .update(clientSigninCodes)
      .set({ usedAt: now })
      .where(and(eq(clientSigninCodes.id, link.id), isNull(clientSigninCodes.usedAt)))
      .returning({ id: clientSigninCodes.id });
    if (marked.length === 0) return null;
    await tx.update(authUsers).set({ lastLoginAt: now }).where(eq(authUsers.id, client.id));
    return {
      loginId: client.id,
      email: client.email,
      ownerId: link.ownerId,
      linkId: link.id,
      sessionEpoch: client.sessionEpoch,
    };
  });
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
