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
 *  - it is tied to the browser's request id (the request cookie): only an
 *    HMAC of (request id, code) is stored, keyed from SESSION_SECRET, so a
 *    copy of the database alone recovers no code; the redeem looks the row
 *    up by that request id, so a forwarded code alone opens nothing;
 *  - no new code while an unexpired one is open for the same email and
 *    address; send caps per email plus address (an hour and a day), per
 *    login a day, and brain-wide a day (then nothing is sent, the skip is
 *    counted, and the admin card says so). A stranger's addresses never
 *    count toward the caps of a client's own address. There is NO
 *    brain-wide failure lockout: failures are limited per email plus
 *    address by the verify route;
 *  - every failure to redeem is the same `null`, after the same work.
 *
 * "Address" here is what the route hands over: an IPv4 address, or the /64
 * of an IPv6 one (server/web/lib/rate-limit.ts `clientIpKey`).
 *
 * The rows live in client_signin_codes (0188, 0191, 0193) with kind 'email';
 * skipped requests in client_signin_code_skips (0193).
 */
import { createHmac, hkdfSync, randomInt, timingSafeEqual } from 'node:crypto';
import {
  and,
  count,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  not,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  authUsers,
  clientSigninCodeSkips,
  clientSigninCodes,
  db,
  resolveSingleOwnerId,
} from '@mantle/db';
import { env } from '@mantle/config';

/** How long an emailed code lives. */
export const CLIENT_CODE_TTL_MS = 10 * 60 * 1000;
/** Wrong tries a code allows before it is dead. */
export const CLIENT_CODE_MAX_ATTEMPTS = 5;
/** Codes the brain sends in any 24 hours, for all clients together: the
 *  last guard against a flood through many addresses. */
export const CLIENT_CODE_DAILY_CAP = 200;
/** Codes one email gets from one address in 24 hours. */
export const CLIENT_CODE_PER_EMAIL_IP_DAILY = 5;
/** Codes one email gets from one address in an hour. Counted per email PLUS
 *  address (plan section 4): a stranger's addresses never use up the hour
 *  of a client's own address. */
export const CLIENT_CODE_PER_EMAIL_IP_HOURLY = 3;
/** Codes one login gets in 24 hours from all addresses together, well below
 *  the brain cap, so strangers aiming at one client cannot use up every
 *  client's codes. An address this login signed in from with a code before
 *  is not held to it (strangers cannot lock a client out of their usual
 *  address); the per email plus address caps still apply there. */
export const CLIENT_CODE_PER_LOGIN_DAILY = 20;
/** @deprecated the hourly cap counts per email plus address now
 *  ({@link CLIENT_CODE_PER_EMAIL_IP_HOURLY}); kept for older importers. */
export const CLIENT_CODE_PER_EMAIL_HOURLY = CLIENT_CODE_PER_EMAIL_IP_HOURLY;
/** A queued request older than this is dropped: its browser's request
 *  cookie is gone or nearly so. */
export const CLIENT_CODE_REQUEST_MAX_AGE_MS = 10 * 60 * 1000;
/** The reaper deletes finished code rows (used, revoked or expired) older
 *  than this, and skip rows too. */
export const CLIENT_CODE_ROW_RETENTION_DAYS = 30;
/** The reaper blanks request_ip on code rows older than this. */
export const CLIENT_CODE_IP_RETENTION_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const ADDRESS_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An id no row has: the no-match branches of the redeem run the same
 *  statements against it. */
const NO_ID = '00000000-0000-0000-0000-000000000000';
/** HKDF label of the code key: fixed, so the same SESSION_SECRET gives the
 *  same key in the web process and the email worker. */
const CODE_KEY_INFO = 'mantle client sign-in code v1';

let codeKeyCache: { secret: string; key: Buffer } | undefined;

/** The HMAC key for emailed codes, derived from SESSION_SECRET (HKDF-SHA256,
 *  fixed label). Throws when SESSION_SECRET is not set: no code is made or
 *  checked without it. Changing the secret only kills the open codes (10
 *  minutes at most). */
function codeKey(): Buffer {
  const secret = env('SESSION_SECRET');
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be set (>=32 chars) to make or check a sign-in code');
  }
  if (codeKeyCache?.secret !== secret) {
    codeKeyCache = {
      secret,
      key: Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), CODE_KEY_INFO, 32)),
    };
  }
  return codeKeyCache.key;
}

/** HMAC-SHA256 hex of a code bound to its request, keyed from SESSION_SECRET:
 *  what `code_hash` stores for an emailed code. */
export function hashClientCode(requestId: string, code: string): string {
  return createHmac('sha256', codeKey())
    .update(`${requestId.toLowerCase()}:${code}`, 'utf8')
    .digest('hex');
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
  /** The caller's address key: IPv4, or an IPv6 /64. */
  ip: string;
  /** ISO time the route answered. */
  requestedAt: string;
};

/** Skips that are a send cap: counted for the admin card. */
export const CLIENT_CODE_CAP_REASONS = [
  'cap-email-ip-hour',
  'cap-email-ip',
  'cap-login',
  'cap-brain',
] as const;
export type ClientCodeCapReason = (typeof CLIENT_CODE_CAP_REASONS)[number];

export type ClientCodeSkipReason =
  'invalid' | 'stale' | 'not-a-client' | 'duplicate' | 'code-open' | ClientCodeCapReason;

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
 * "no open code" check. A cap skip is recorded (the reason only). The
 * caller mails `code` and records the outcome with `markClientEmailCodeSent`
 * or `revokeClientEmailCode`. `opts.ownerId` is the brain anchor, read by
 * the caller before anything is stored; without it it is resolved here.
 */
export async function createClientEmailCode(
  req: ClientCodeRequest,
  now = new Date(),
  opts: { ownerId?: string | null } = {},
): Promise<ClientCodeDecision> {
  const email = req.email.trim().toLowerCase();
  const requestedAt = new Date(req.requestedAt);
  if (!ADDRESS_RE.test(email) || !UUID_RE.test(req.requestId) || Number.isNaN(+requestedAt)) {
    return skip('invalid');
  }
  if (now.getTime() - requestedAt.getTime() > CLIENT_CODE_REQUEST_MAX_AGE_MS) return skip('stale');
  const ip = req.ip.slice(0, 100);
  const ownerId = opts.ownerId !== undefined ? opts.ownerId : await resolveSingleOwnerId();

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
    const stillOpen = and(
      isNull(clientSigninCodes.usedAt),
      isNull(clientSigninCodes.revokedAt),
      gt(clientSigninCodes.expiresAt, now),
      sql`${clientSigninCodes.attempts} < ${CLIENT_CODE_MAX_ATTEMPTS}`,
    );
    const capped = async (reason: ClientCodeCapReason) => {
      await tx.insert(clientSigninCodeSkips).values({ reason, createdAt: now });
      return skip(reason);
    };

    // This browser asked again (the same request id: "Send a new code", a
    // double click, a retried job) while its code is still open: the code
    // already mailed keeps working, and no second mail goes out. Once that
    // code is used, dead or expired, the same browser gets a new one.
    if (await counted(and(ofLogin, eq(clientSigninCodes.requestId, req.requestId), stillOpen))) {
      return skip('duplicate');
    }
    if (await counted(and(fromHere, stillOpen))) return skip('code-open');
    if ((await counted(and(fromHere, since(HOUR_MS)))) >= CLIENT_CODE_PER_EMAIL_IP_HOURLY) {
      return capped('cap-email-ip-hour');
    }
    if ((await counted(and(fromHere, since(DAY_MS)))) >= CLIENT_CODE_PER_EMAIL_IP_DAILY) {
      return capped('cap-email-ip');
    }
    // The per-login day: an address this login signed in from before is
    // its own, and strangers elsewhere must not lock it out of it.
    const knownAddress = await counted(and(fromHere, isNotNull(clientSigninCodes.usedAt)));
    if (
      !knownAddress &&
      (await counted(and(ofLogin, since(DAY_MS)))) >= CLIENT_CODE_PER_LOGIN_DAILY
    ) {
      return capped('cap-login');
    }
    const brain = and(eq(clientSigninCodes.kind, 'email'), since(DAY_MS));
    if ((await counted(brain)) >= CLIENT_CODE_DAILY_CAP) return capped('cap-brain');

    const code = generateClientCode();
    const expiresAt = new Date(now.getTime() + CLIENT_CODE_TTL_MS);
    const [row] = await tx
      .insert(clientSigninCodes)
      .values({
        ownerId: ownerId ?? login.id,
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

/** Short, code-free text of a send failure, for the admin card. */
export function clientCodeFailureReason(reason: string): string {
  const clean = reason.replace(/\d{8}/g, '########').replace(/\s+/g, ' ').trim();
  return (clean || 'unknown error').slice(0, 300);
}

/** The mail did not go out (or anything after the code was stored threw):
 *  the code must not stay open (it would block a new one for 10 minutes).
 *  It still counts toward the caps. `reason` is kept for the admin card. */
export async function revokeClientEmailCode(
  codeId: string,
  now = new Date(),
  reason?: string,
): Promise<void> {
  await db
    .update(clientSigninCodes)
    .set({
      revokedAt: now,
      ...(reason !== undefined ? { sendError: clientCodeFailureReason(reason) } : {}),
    })
    .where(and(eq(clientSigninCodes.id, codeId), eq(clientSigninCodes.kind, 'email')));
}

/** The mail server took the code's mail. */
export async function markClientEmailCodeSent(codeId: string, now = new Date()): Promise<void> {
  await db
    .update(clientSigninCodes)
    .set({ sentAt: now })
    .where(and(eq(clientSigninCodes.id, codeId), eq(clientSigninCodes.kind, 'email')));
}

/** Codes the brain created in the last 24 hours, failed ones too: the daily
 *  cap's count. */
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

/** What became of the code mails of the last 24 hours, for the admin card. */
export type ClientCodeStats = {
  /** Codes stored (the daily cap counts these, failed ones too). */
  created: number;
  /** Codes the mail server took. */
  delivered: number;
  /** Code mails that failed. */
  failed: number;
  /** The newest failure (any age the reaper kept). */
  lastFailure: { at: Date; reason: string } | null;
  /** Requests skipped at a send cap. */
  capSkips: number;
};

export async function clientCodeStats(now = new Date()): Promise<ClientCodeStats> {
  const day = new Date(now.getTime() - DAY_MS);
  const [counts] = await db
    .select({
      created: count(),
      delivered: sql<number>`(count(*) filter (where ${clientSigninCodes.sentAt} is not null))::int`,
      failed: sql<number>`(count(*) filter (where ${clientSigninCodes.sendError} is not null))::int`,
    })
    .from(clientSigninCodes)
    .where(and(eq(clientSigninCodes.kind, 'email'), gt(clientSigninCodes.createdAt, day)));
  const [last] = await db
    .select({
      createdAt: clientSigninCodes.createdAt,
      revokedAt: clientSigninCodes.revokedAt,
      reason: clientSigninCodes.sendError,
    })
    .from(clientSigninCodes)
    .where(and(eq(clientSigninCodes.kind, 'email'), isNotNull(clientSigninCodes.sendError)))
    .orderBy(desc(clientSigninCodes.createdAt))
    .limit(1);
  const [skips] = await db
    .select({ n: count() })
    .from(clientSigninCodeSkips)
    .where(gt(clientSigninCodeSkips.createdAt, day));
  return {
    created: counts?.created ?? 0,
    delivered: Number(counts?.delivered ?? 0),
    failed: Number(counts?.failed ?? 0),
    lastFailure:
      last && last.reason ? { at: last.revokedAt ?? last.createdAt, reason: last.reason } : null,
    capSkips: skips?.n ?? 0,
  };
}

/**
 * The reaper (maintenance sweep `client-codes-reap`, plain SQL, no model):
 * deletes code rows older than {@link CLIENT_CODE_ROW_RETENTION_DAYS} that
 * are finished (used, revoked or expired), except a used sign-in LINK (the
 * admin's "last used" record), blanks `request_ip` on code rows older than
 * {@link CLIENT_CODE_IP_RETENTION_DAYS}, and deletes skip rows past the row
 * retention. `dryRun` counts without writing. Idempotent.
 */
export async function reapClientSigninCodes(
  opts: { now?: Date; dryRun?: boolean } = {},
): Promise<{ deleted: number; ipsCleared: number; skipsDeleted: number }> {
  const now = opts.now ?? new Date();
  const rowCutoff = new Date(now.getTime() - CLIENT_CODE_ROW_RETENTION_DAYS * DAY_MS);
  const ipCutoff = new Date(now.getTime() - CLIENT_CODE_IP_RETENTION_DAYS * DAY_MS);
  const finishedOld = and(
    lt(clientSigninCodes.createdAt, rowCutoff),
    or(
      isNotNull(clientSigninCodes.revokedAt),
      lt(clientSigninCodes.expiresAt, now),
      isNotNull(clientSigninCodes.usedAt),
    ),
    or(eq(clientSigninCodes.kind, 'email'), isNull(clientSigninCodes.usedAt)),
  );
  const ipOld = and(
    lt(clientSigninCodes.createdAt, ipCutoff),
    isNotNull(clientSigninCodes.requestIp),
  );
  const skipsOld = lt(clientSigninCodeSkips.createdAt, rowCutoff);
  if (opts.dryRun) {
    const [a] = await db.select({ n: count() }).from(clientSigninCodes).where(finishedOld);
    // Rows the delete takes are not also counted as blanked.
    const [b] = await db
      .select({ n: count() })
      .from(clientSigninCodes)
      .where(and(ipOld, not(finishedOld!)));
    const [c] = await db.select({ n: count() }).from(clientSigninCodeSkips).where(skipsOld);
    return { deleted: a?.n ?? 0, ipsCleared: b?.n ?? 0, skipsDeleted: c?.n ?? 0 };
  }
  const deleted = await db
    .delete(clientSigninCodes)
    .where(finishedOld)
    .returning({ id: clientSigninCodes.id });
  const cleared = await db
    .update(clientSigninCodes)
    .set({ requestIp: null })
    .where(ipOld)
    .returning({ id: clientSigninCodes.id });
  const skips = await db
    .delete(clientSigninCodeSkips)
    .where(skipsOld)
    .returning({ id: clientSigninCodeSkips.id });
  return { deleted: deleted.length, ipsCleared: cleared.length, skipsDeleted: skips.length };
}

export type RedeemedClientEmailCode = {
  loginId: string;
  email: string;
  codeId: string;
  /** The login's session epoch now: the cookie is minted with it. */
  sessionEpoch: number;
};

type RedeemTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RedeemLogin = {
  id: string;
  email: string;
  role: string;
  disabledAt: Date | null;
  sessionEpoch: number;
};
type RedeemRow = { id: string; codeHash: string };

/** Compared against when no code row matched: the length of a real hash. */
const NO_HASH = '0'.repeat(64);

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/**
 * The steps of a redeem, which every branch runs in the same order (audit
 * B17: an unknown email, a disabled login and a wrong code do the same work,
 * so the timing does not tell whether an email is a client). Exported for
 * the test that pins the one path; not for other callers.
 */
export const redeemSteps = {
  /** The login with this email, whatever its role (null: none). */
  async findLogin(tx: RedeemTx, email: string): Promise<RedeemLogin | null> {
    const [login] = await tx
      .select({
        id: authUsers.id,
        email: authUsers.email,
        role: authUsers.role,
        disabledAt: authUsers.disabledAt,
        sessionEpoch: authUsers.sessionEpoch,
      })
      .from(authUsers)
      .where(sql`lower(${authUsers.email}) = ${email}`)
      .limit(1);
    return login ?? null;
  },
  /** The open code of THIS request for this login, locked (the one-use and
   *  five-tries guarantees rest on the lock). Runs for an unknown email too,
   *  against an id no row has. */
  async findOpenCode(
    tx: RedeemTx,
    requestId: string,
    loginId: string | null,
    now: Date,
  ): Promise<RedeemRow | null> {
    const [row] = await tx
      .select({ id: clientSigninCodes.id, codeHash: clientSigninCodes.codeHash })
      .from(clientSigninCodes)
      .where(
        and(
          eq(clientSigninCodes.requestId, requestId),
          eq(clientSigninCodes.kind, 'email'),
          eq(clientSigninCodes.loginId, loginId ?? NO_ID),
          isNull(clientSigninCodes.usedAt),
          isNull(clientSigninCodes.revokedAt),
          gt(clientSigninCodes.expiresAt, now),
          sql`${clientSigninCodes.attempts} < ${CLIENT_CODE_MAX_ATTEMPTS}`,
        ),
      )
      .limit(1)
      .for('update');
    return row ?? null;
  },
  /** Hash and compare; against a dummy when no row matched. */
  checkCode(requestId: string, code: string, storedHash: string | null): boolean {
    const same = sameHash(hashClientCode(requestId, code), storedHash ?? NO_HASH);
    return same && storedHash !== null;
  },
  /** A wrong try costs the code a try; with no code, the same statement
   *  touches nothing. */
  async countTry(tx: RedeemTx, codeId: string | null): Promise<void> {
    await tx
      .update(clientSigninCodes)
      .set({ attempts: sql`${clientSigninCodes.attempts} + 1` })
      .where(eq(clientSigninCodes.id, codeId ?? NO_ID));
  },
  async finish(tx: RedeemTx, row: RedeemRow, login: RedeemLogin, now: Date): Promise<void> {
    await tx.update(clientSigninCodes).set({ usedAt: now }).where(eq(clientSigninCodes.id, row.id));
    await tx.update(authUsers).set({ lastLoginAt: now }).where(eq(authUsers.id, login.id));
  },
};

/**
 * Trade a code for a session, in ONE transaction: the open code of THIS
 * browser's request for the login with this email (locked), when that login
 * is an active client. A wrong code costs a try; the fifth wrong try kills
 * the code. A wrong email finds no code at all (the verify route limits
 * failures per email plus address). Every branch runs the same steps
 * ({@link redeemSteps}). `null` for every failure.
 */
export async function redeemClientEmailCode(
  input: { requestId: string; email: string; code: string },
  now = new Date(),
): Promise<RedeemedClientEmailCode | null> {
  const email = input.email.trim().toLowerCase();
  const code = input.code.replace(/\s+/g, '');
  if (!UUID_RE.test(input.requestId) || !email || !/^\d{8}$/.test(code)) return null;
  const steps = redeemSteps;
  return db.transaction(async (tx) => {
    // One browser may have asked for two emails (Use a different email),
    // each with its code: the row is this request's code for THIS email.
    const login = await steps.findLogin(tx, email);
    const row = await steps.findOpenCode(tx, input.requestId, login?.id ?? null, now);
    const match = steps.checkCode(input.requestId, code, row?.codeHash ?? null);
    const usable =
      !!login &&
      login.role === 'client' &&
      login.disabledAt === null &&
      login.email.trim().toLowerCase() === email;
    if (!row || !login || !usable || !match) {
      await steps.countTry(tx, row?.id ?? null);
      return null;
    }
    await steps.finish(tx, row, login, now);
    return {
      loginId: login.id,
      email: login.email,
      codeId: row.id,
      sessionEpoch: login.sessionEpoch,
    };
  });
}
