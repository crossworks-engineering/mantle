/**
 * Email sign-in codes for client logins (client logins, Phase C2b; plan
 * section 4). A client types their email on the sign-in page; the route
 * answers the same way for every email and queues the request; the
 * email-sync worker calls `createClientEmailCode` and, when it says send,
 * mails the code from the brain's sign-in sender. The client types the code
 * in the SAME browser, and `redeemClientEmailCode` trades it for a session.
 *
 * Properties the routes and the worker rely on:
 *  - a code is 8 digits, lives {@link CLIENT_CODE_TTL_MS} (10 minutes), is
 *    single use and allows {@link CLIENT_CODE_MAX_ATTEMPTS} wrong tries,
 *    counted in the database;
 *  - it is tied to the browser's request id (the request cookie): only
 *    SHA-256(request id, code) is stored, and the redeem looks the row up by
 *    that request id, so a forwarded code alone opens nothing;
 *  - no new code while an unexpired one is open for the same email and
 *    address; send caps per email plus address, per email, and brain-wide
 *    per day (then nothing is sent, and the admin screen says so). There is
 *    NO brain-wide failure lockout: failures are limited per email plus
 *    address by the verify route;
 *  - every failure to redeem is the same `null`.
 *
 * The rows live in client_signin_codes (0188, 0191) with kind 'email'.
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { and, count, eq, gt, isNull, sql, type SQL } from 'drizzle-orm';
import { authUsers, clientSigninCodes, db, resolveSingleOwnerId } from '@mantle/db';

/** How long an emailed code lives. */
export const CLIENT_CODE_TTL_MS = 10 * 60 * 1000;
/** Wrong tries a code allows before it is dead. */
export const CLIENT_CODE_MAX_ATTEMPTS = 5;
/** Codes the brain sends in any 24 hours, for all clients together: the
 *  last guard against a flood through many addresses. */
export const CLIENT_CODE_DAILY_CAP = 200;
/** Codes one email gets from one address in 24 hours. */
export const CLIENT_CODE_PER_EMAIL_IP_DAILY = 5;
/** Codes one email gets in an hour, from all addresses together (no mail
 *  bombing a client through many addresses). */
export const CLIENT_CODE_PER_EMAIL_HOURLY = 10;
/** A queued request older than this is dropped: its browser's request
 *  cookie is gone or nearly so. */
export const CLIENT_CODE_REQUEST_MAX_AGE_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const ADDRESS_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SHA-256 hex of a code bound to its request: what `code_hash` stores. */
export function hashClientCode(requestId: string, code: string): string {
  return createHash('sha256').update(`${requestId.toLowerCase()}:${code}`, 'utf8').digest('hex');
}

/** A fresh 8-digit code, every value equally likely. */
export function generateClientCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, '0');
}

/** One queued request, as the sign-in route enqueues it. */
export type ClientCodeRequest = {
  email: string;
  /** The request cookie's id. */
  requestId: string;
  ip: string;
  /** ISO time the route answered. */
  requestedAt: string;
};

export type ClientCodeSkipReason =
  | 'invalid'
  | 'stale'
  | 'not-a-client'
  | 'duplicate'
  | 'code-open'
  | 'cap-email-ip'
  | 'cap-email'
  | 'cap-brain';

export type ClientCodeDecision =
  | {
      kind: 'send';
      codeId: string;
      /** The PLAINTEXT code, for the mail only. */
      code: string;
      loginId: string;
      /** The login's email, as stored (the mail goes here). */
      email: string;
      displayName: string | null;
      expiresAt: Date;
    }
  | { kind: 'skip'; reason: ClientCodeSkipReason };

const skip = (reason: ClientCodeSkipReason): ClientCodeDecision => ({ kind: 'skip', reason });

/**
 * Decide on one queued request and, when a code should go out, store it.
 * Runs in the worker, never in the request. One transaction, serialized per
 * login (an advisory lock), so two requests at once cannot both pass the
 * "no open code" check. The caller mails `code` and, when the mail fails,
 * calls `revokeClientEmailCode`.
 */
export async function createClientEmailCode(
  req: ClientCodeRequest,
  now = new Date(),
): Promise<ClientCodeDecision> {
  const email = req.email.trim().toLowerCase();
  const requestedAt = new Date(req.requestedAt);
  if (!ADDRESS_RE.test(email) || !UUID_RE.test(req.requestId) || Number.isNaN(+requestedAt)) {
    return skip('invalid');
  }
  if (now.getTime() - requestedAt.getTime() > CLIENT_CODE_REQUEST_MAX_AGE_MS) return skip('stale');
  const ip = req.ip.slice(0, 100);

  return db.transaction(async (tx) => {
    const [login] = await tx
      .select({
        id: authUsers.id,
        email: authUsers.email,
        displayName: authUsers.displayName,
        role: authUsers.role,
        disabledAt: authUsers.disabledAt,
      })
      .from(authUsers)
      .where(sql`lower(${authUsers.email}) = ${email}`)
      .limit(1);
    if (!login || login.role !== 'client' || login.disabledAt !== null) {
      return skip('not-a-client');
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`client-code:${login.id}`}))`);

    const counted = async (where: SQL | undefined) =>
      (await tx.select({ n: count() }).from(clientSigninCodes).where(where))[0]?.n ?? 0;
    const since = (ms: number) => gt(clientSigninCodes.createdAt, new Date(now.getTime() - ms));
    const ofLogin = and(
      eq(clientSigninCodes.loginId, login.id),
      eq(clientSigninCodes.kind, 'email'),
    );
    const fromHere = and(ofLogin, eq(clientSigninCodes.requestIp, ip));

    // A retried job: this request already has its code.
    if (await counted(and(ofLogin, eq(clientSigninCodes.requestId, req.requestId)))) {
      return skip('duplicate');
    }
    const open = and(
      fromHere,
      isNull(clientSigninCodes.usedAt),
      isNull(clientSigninCodes.revokedAt),
      gt(clientSigninCodes.expiresAt, now),
      sql`${clientSigninCodes.attempts} < ${CLIENT_CODE_MAX_ATTEMPTS}`,
    );
    if (await counted(open)) return skip('code-open');
    if ((await counted(and(fromHere, since(DAY_MS)))) >= CLIENT_CODE_PER_EMAIL_IP_DAILY) {
      return skip('cap-email-ip');
    }
    if ((await counted(and(ofLogin, since(HOUR_MS)))) >= CLIENT_CODE_PER_EMAIL_HOURLY) {
      return skip('cap-email');
    }
    const brain = and(eq(clientSigninCodes.kind, 'email'), since(DAY_MS));
    if ((await counted(brain)) >= CLIENT_CODE_DAILY_CAP) return skip('cap-brain');

    const ownerId = (await resolveSingleOwnerId()) ?? login.id;
    const code = generateClientCode();
    const expiresAt = new Date(now.getTime() + CLIENT_CODE_TTL_MS);
    const [row] = await tx
      .insert(clientSigninCodes)
      .values({
        ownerId,
        loginId: login.id,
        kind: 'email',
        codeHash: hashClientCode(req.requestId, code),
        requestId: req.requestId,
        requestIp: ip,
        expiresAt,
        createdAt: now,
      })
      .returning({ id: clientSigninCodes.id });
    return {
      kind: 'send',
      codeId: row!.id,
      code,
      loginId: login.id,
      email: login.email,
      displayName: login.displayName,
      expiresAt,
    };
  });
}

/** The mail did not go out: the code must not stay open (it would block a
 *  new one for 10 minutes). It still counts toward the caps. */
export async function revokeClientEmailCode(codeId: string, now = new Date()): Promise<void> {
  await db
    .update(clientSigninCodes)
    .set({ revokedAt: now })
    .where(and(eq(clientSigninCodes.id, codeId), eq(clientSigninCodes.kind, 'email')));
}

/** Codes the brain created in the last 24 hours (the daily cap's count). */
export async function clientCodesSentLast24h(now = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(clientSigninCodes)
    .where(
      and(
        eq(clientSigninCodes.kind, 'email'),
        gt(clientSigninCodes.createdAt, new Date(now.getTime() - DAY_MS)),
      ),
    );
  return row?.n ?? 0;
}

export type RedeemedClientEmailCode = {
  loginId: string;
  email: string;
  codeId: string;
  /** The login's session epoch now: the cookie is minted with it. */
  sessionEpoch: number;
};

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/**
 * Trade a code for a session, in ONE transaction: the open code of THIS
 * browser's request (locked), for an active client login whose email
 * matches. A wrong code or a wrong email costs a try; the fifth wrong try
 * kills the code. `null` for every failure.
 */
export async function redeemClientEmailCode(
  input: { requestId: string; email: string; code: string },
  now = new Date(),
): Promise<RedeemedClientEmailCode | null> {
  const email = input.email.trim().toLowerCase();
  const code = input.code.replace(/\s+/g, '');
  if (!UUID_RE.test(input.requestId) || !email || !/^\d{8}$/.test(code)) return null;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(clientSigninCodes)
      .where(
        and(
          eq(clientSigninCodes.requestId, input.requestId),
          eq(clientSigninCodes.kind, 'email'),
          isNull(clientSigninCodes.usedAt),
          isNull(clientSigninCodes.revokedAt),
          gt(clientSigninCodes.expiresAt, now),
          sql`${clientSigninCodes.attempts} < ${CLIENT_CODE_MAX_ATTEMPTS}`,
        ),
      )
      .limit(1)
      .for('update');
    if (!row) return null;
    const [login] = await tx
      .select({
        id: authUsers.id,
        email: authUsers.email,
        role: authUsers.role,
        disabledAt: authUsers.disabledAt,
        sessionEpoch: authUsers.sessionEpoch,
      })
      .from(authUsers)
      .where(eq(authUsers.id, row.loginId))
      .limit(1);
    const ok =
      !!login &&
      login.role === 'client' &&
      login.disabledAt === null &&
      login.email.trim().toLowerCase() === email &&
      sameHash(hashClientCode(input.requestId, code), row.codeHash);
    if (!ok) {
      await tx
        .update(clientSigninCodes)
        .set({ attempts: sql`${clientSigninCodes.attempts} + 1` })
        .where(eq(clientSigninCodes.id, row.id));
      return null;
    }
    await tx.update(clientSigninCodes).set({ usedAt: now }).where(eq(clientSigninCodes.id, row.id));
    await tx.update(authUsers).set({ lastLoginAt: now }).where(eq(authUsers.id, login.id));
    return {
      loginId: login.id,
      email: login.email,
      codeId: row.id,
      sessionEpoch: login.sessionEpoch,
    };
  });
}
