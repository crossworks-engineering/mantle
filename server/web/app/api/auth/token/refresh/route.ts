import { NextResponse } from '@/server/http-compat';
import { randomUUID } from 'node:crypto';
import { db, authUsers, mobileTokens, pushSubscriptions, and, eq, isNull, sql } from '@mantle/db';
import {
  CLIENT_DEVICE_MAX_AGE_SECONDS,
  CLIENT_SESSION_TTL_SECONDS,
  ROTATE_WHEN_UNDER_SECONDS,
  buildMobileToken,
  loginUsable,
  presentRotatedToken,
  verifyMobileToken,
  WEB_TOKEN_TTL_SECONDS,
  type UnusedSuccessor,
} from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { clientIpKey, rateLimit } from '@/lib/rate-limit';

/**
 * Rotate the calling bearer: mint a new jti + token, revoke the old row,
 * atomically, so a crash can't leave zero valid tokens. The old row is
 * CLAIMED first (revoked only if still live, in the same statement), so two
 * refreshes of one token at once give one new token, not two (F31): the
 * loser gets the same 401 as a revoked token. Self-authenticates from the
 * Authorization header (like mobile-logout), so it lives under the public
 * /api/auth prefix.
 *
 * The client calls this opportunistically when expiry is <7 days out
 * (piggybacked on the /api/shell boot call): an active browser never expires,
 * an idle one dies in ≤30 days. Always issues the WEB TTL — the old mobile
 * companion doesn't refresh (it holds a 1-year token); the three-role phone
 * app does, for every role.
 *
 * The rules, for every role (the checks are the session layer's,
 * getBearerLogin):
 *
 *  - Not yet. A token with more than {@link ROTATE_WHEN_UNDER_SECONDS} left
 *    is answered with ITSELF and its own expiry: nothing rotates, no row is
 *    written. A caller that loops on refresh makes no rows.
 *  - The epoch. A token that carries a session epoch is refused once the
 *    login's epoch has moved on; a client's token must carry one. The login
 *    row is locked for the rotation, so a refresh racing End sessions or a
 *    password change cannot mint a token that outlives it.
 *  - A client's cap. A client's device token is kept alive by refresh for at
 *    most {@link CLIENT_DEVICE_MAX_AGE_SECONDS} from the emailed code that
 *    signed the phone in (`signed_in_at`, copied through every rotation):
 *    after it, 401 with `reason: 'sign-in-expired'` and the person asks for
 *    a new code. Each token lasts at most a client session and never past
 *    the cap.
 *  - A lost answer. A token that was rotated away and is presented AGAIN
 *    while its successor has never been used is a retry: the answer is the
 *    SAME successor (its jti, re-signed to its own expiry). So a refresh is
 *    idempotent until the new token is first used. The successor is minted
 *    with no `last_used_at`; its first real use stamps it.
 *  - Reuse. A rotated token presented again once its successor HAS been
 *    used is a copy in someone else's hands (the app holds only the
 *    newest). That ends every session of the login once, writes
 *    `auth.token_reuse`, and marks the rotated row handled: every later
 *    presentation is a plain 401 (presentRotatedToken, which every bearer
 *    route runs too).
 *
 * The push devices the old token enrolled follow the new one.
 */
/** The roles whose bearer rotates here, named: a role this code does not
 *  know is no login. */
const BEARER_ROLES: ReadonlySet<string> = new Set(['admin', 'member', 'client']);

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

const unauthorized = (reason?: string) =>
  NextResponse.json(
    { error: 'unauthorized', ...(reason ? { reason } : {}) },
    { status: 401, headers: NO_STORE },
  );

/**
 * A refresh whose answer was lost, retried with the old token: answer the
 * successor again (the same jti, signed to its own expiry, a client's at the
 * login's epoch). Null when the login may not hold a token now.
 */
async function answerSuccessorAgain(
  next: UnusedSuccessor,
  row: {
    email: string;
    disabledAt: Date | null;
    role: string;
    sessionEpoch: number;
  },
): Promise<Response | null> {
  if (!loginUsable({ email: row.email, disabledAt: row.disabledAt })) return null;
  if (!BEARER_ROLES.has(row.role)) return null;
  const leftSec = Math.floor((next.expiresAt.getTime() - Date.now()) / 1000);
  if (leftSec <= 0) return null;
  const minted =
    row.role === 'client'
      ? buildMobileToken(next.userId, next.id, leftSec, row.sessionEpoch)
      : buildMobileToken(next.userId, next.id, leftSec);
  return NextResponse.json(
    {
      token: minted.value,
      expiresIn: minted.expiresInSec,
      expiresAt: minted.expiresAt.toISOString(),
      deviceId: next.id,
      role: row.role,
    },
    { headers: NO_STORE },
  );
}

export async function POST(req: Request) {
  // Per address, an IPv6 caller by its /64 (as the code routes count).
  const limit = rateLimit(`auth:token-refresh:${clientIpKey(req)}`, { max: 30, windowMs: 60_000 });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many refresh attempts. Try again in a minute.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
    );
  }

  const token = bearer(req);
  const claims = token ? verifyMobileToken(token) : null;
  if (!token || !claims) return unauthorized();
  const jti = claims.jti;

  const [row] = await db
    .select({
      userId: mobileTokens.userId,
      label: mobileTokens.label,
      revokedAt: mobileTokens.revokedAt,
      rotatedTo: mobileTokens.rotatedTo,
      expiresAt: mobileTokens.expiresAt,
      createdAt: mobileTokens.createdAt,
      signedInAt: mobileTokens.signedInAt,
      email: authUsers.email,
      disabledAt: authUsers.disabledAt,
      role: authUsers.role,
      sessionEpoch: authUsers.sessionEpoch,
    })
    .from(mobileTokens)
    .innerJoin(authUsers, eq(authUsers.id, mobileTokens.userId))
    .where(eq(mobileTokens.id, jti))
    .limit(1);
  if (!row) return unauthorized();

  const refused = (reason: string) => {
    auditFireAndForget({
      actorId: row.userId,
      actorEmail: row.email ?? '',
      action: 'auth.token_refresh_failed',
      method: 'POST',
      path: '/api/auth/token/refresh',
      detail: { device: row.label, deviceId: jti, reason },
      ...requestMetaFrom(req),
    });
  };

  // This token was rotated away, and here it is again: a retry of a refresh
  // whose answer was lost (the successor is unused: answer it again), or a
  // copy in other hands (the successor was used: presentRotatedToken ends
  // the login's sessions once and writes auth.token_reuse).
  if (row.revokedAt && row.rotatedTo && row.userId === claims.uid) {
    const seen = await presentRotatedToken(
      { jti, userId: row.userId, rotatedTo: row.rotatedTo },
      { method: 'POST', path: '/api/auth/token/refresh', meta: requestMetaFrom(req) },
    );
    if (seen.kind === 'retry') {
      const again = await answerSuccessorAgain(seen.successor, row);
      if (again) return again;
    }
    if (seen.kind !== 'reuse') refused('rotated');
    return unauthorized();
  }

  // A disabled login cannot keep a session alive by refreshing it. Only the
  // roles that hold a bearer rotate one, named (client logins audit A15).
  const isClient = row.role === 'client';
  const why = row.revokedAt
    ? 'revoked'
    : row.userId !== claims.uid
      ? 'wrong-login'
      : row.expiresAt.getTime() <= Date.now()
        ? 'expired'
        : !loginUsable({ email: row.email, disabledAt: row.disabledAt })
          ? 'login-disabled'
          : !BEARER_ROLES.has(row.role)
            ? 'role'
            : (claims.ep !== undefined && claims.ep !== row.sessionEpoch) ||
                (isClient && claims.ep === undefined)
              ? 'session-ended'
              : null;
  if (why) {
    refused(why);
    return unauthorized();
  }

  // Not yet: plenty of life left. The same token, its own expiry.
  const expiresAtMs = Math.min(row.expiresAt.getTime(), claims.exp * 1000);
  const leftSec = Math.floor((expiresAtMs - Date.now()) / 1000);
  if (leftSec > ROTATE_WHEN_UNDER_SECONDS) {
    return NextResponse.json(
      {
        token,
        expiresIn: leftSec,
        expiresAt: new Date(expiresAtMs).toISOString(),
        deviceId: jti,
        role: row.role,
      },
      { headers: NO_STORE },
    );
  }

  // A client's device: at most 90 days from the code that signed it in.
  const signedInAt = row.signedInAt ?? row.createdAt;
  let ttlSeconds = WEB_TOKEN_TTL_SECONDS;
  if (isClient) {
    const capLeft = Math.floor(
      (signedInAt.getTime() + CLIENT_DEVICE_MAX_AGE_SECONDS * 1000 - Date.now()) / 1000,
    );
    if (capLeft <= 60) {
      refused('sign-in-expired');
      return unauthorized('sign-in-expired');
    }
    ttlSeconds = Math.min(WEB_TOKEN_TTL_SECONDS, CLIENT_SESSION_TTL_SECONDS, capLeft);
  }

  const newJti = randomUUID();
  const minted = isClient
    ? buildMobileToken(row.userId, newJti, ttlSeconds, row.sessionEpoch)
    : buildMobileToken(row.userId, newJti, ttlSeconds);
  const rotated = await db.transaction(async (tx) => {
    // The login row, locked: End sessions, a password change and a disable
    // all update it first (endLoginSessions), so one of the two waits. If
    // they went first the epoch has moved and nothing is minted; if this
    // goes first they revoke the new token with the rest.
    const locked = (await tx.execute(
      sql`select session_epoch as epoch, disabled_at from auth.users
           where id = ${row.userId} for share`,
    )) as unknown as Array<{ epoch: number; disabled_at: Date | null }>;
    if (!locked[0] || Number(locked[0].epoch) !== row.sessionEpoch || locked[0].disabled_at) {
      return false;
    }
    const claimed = await tx
      .update(mobileTokens)
      .set({ revokedAt: new Date(), rotatedTo: newJti })
      .where(and(eq(mobileTokens.id, jti), isNull(mobileTokens.revokedAt)))
      .returning({ id: mobileTokens.id });
    if (claimed.length === 0) return false;
    await tx.insert(mobileTokens).values({
      id: newJti,
      userId: row.userId,
      label: row.label,
      expiresAt: minted.expiresAt,
      // Unused until its first real use (getBearerLogin stamps it): until
      // then a retry with the old token is answered with this one again.
      lastUsedAt: null,
      signedInAt,
    });
    // The push devices the old token enrolled follow the new one: a device
    // is pushed to only while its token is live.
    await tx
      .update(pushSubscriptions)
      .set({ tokenId: newJti })
      .where(eq(pushSubscriptions.tokenId, jti));
    return true;
  });
  if (!rotated) {
    refused('lost-the-race');
    return unauthorized();
  }

  auditFireAndForget({
    actorId: row.userId,
    actorEmail: row.email ?? '',
    action: 'auth.token_refreshed',
    method: 'POST',
    path: '/api/auth/token/refresh',
    detail: { device: row.label, rotatedFrom: jti, rotatedTo: newJti },
    ...requestMetaFrom(req),
  });

  return NextResponse.json(
    {
      token: minted.value,
      expiresIn: minted.expiresInSec,
      expiresAt: minted.expiresAt.toISOString(),
      deviceId: newJti,
      role: row.role,
    },
    { headers: NO_STORE },
  );
}
