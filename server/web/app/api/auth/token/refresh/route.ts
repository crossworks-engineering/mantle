import { NextResponse } from '@/server/http-compat';
import { randomUUID } from 'node:crypto';
import { db, authUsers, mobileTokens, pushSubscriptions, and, eq, isNull } from '@mantle/db';
import {
  CLIENT_SESSION_TTL_SECONDS,
  buildMobileToken,
  loginUsable,
  verifyMobileToken,
  WEB_TOKEN_TTL_SECONDS,
} from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { clientIp, rateLimit } from '@/lib/rate-limit';

/**
 * Rotate the calling web-client bearer: mint a new jti + token, revoke the old
 * row, atomically, so a crash can't leave zero valid tokens. The old row is
 * CLAIMED first (revoked only if still live, in the same statement), so two
 * refreshes of one token at once give one new token, not two (F31): the
 * loser gets the same 401 as a revoked token. Self-
 * authenticates from the Authorization header (like mobile-logout), so it
 * lives under the public /api/auth prefix.
 *
 * The client calls this opportunistically when expiry is <7 days out
 * (piggybacked on the /api/shell boot call): an active browser never expires,
 * an idle one dies in ≤30 days. Always issues the WEB TTL — the old mobile
 * companion doesn't refresh (it holds a 1-year token); the three-role phone
 * app does, for every role.
 *
 * A CLIENT's device token (minted by the emailed code in device mode)
 * rotates here too: the new token carries the login's session epoch again
 * and never lasts longer than a client session. A token that carries an
 * epoch is refused once the login's epoch has moved on, as the session layer
 * refuses it. The push devices the old token enrolled follow the new one.
 */
/** The roles whose bearer rotates here, named: a role this code does not
 *  know is no login. */
const BEARER_ROLES: ReadonlySet<string> = new Set(['admin', 'member', 'client']);

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

export async function POST(req: Request) {
  const ip = clientIp(req);
  const limit = rateLimit(`auth:token-refresh:${ip}`, { max: 30, windowMs: 60_000 });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many refresh attempts. Try again in a minute.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
    );
  }

  const token = bearer(req);
  const claims = token ? verifyMobileToken(token) : null;
  if (!claims) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const jti = claims.jti;

  const [row] = await db
    .select({
      userId: mobileTokens.userId,
      label: mobileTokens.label,
      revokedAt: mobileTokens.revokedAt,
      expiresAt: mobileTokens.expiresAt,
      email: authUsers.email,
      disabledAt: authUsers.disabledAt,
      role: authUsers.role,
      sessionEpoch: authUsers.sessionEpoch,
    })
    .from(mobileTokens)
    .innerJoin(authUsers, eq(authUsers.id, mobileTokens.userId))
    .where(eq(mobileTokens.id, jti))
    .limit(1);
  // A disabled login cannot keep a session alive by refreshing it. Only the
  // roles that hold a bearer rotate one, named (client logins audit A15): a
  // role this code does not know is no login. The checks are the session
  // layer's (getBearerLogin): the row names the token's login, a token with
  // an epoch is held to the login's epoch, and a client's token must carry
  // one.
  const isClient = row?.role === 'client';
  if (
    !row ||
    row.revokedAt ||
    row.userId !== claims.uid ||
    row.expiresAt.getTime() <= Date.now() ||
    !loginUsable({ email: row.email, disabledAt: row.disabledAt }) ||
    !BEARER_ROLES.has(row.role) ||
    (claims.ep !== undefined && claims.ep !== row.sessionEpoch) ||
    (isClient && claims.ep === undefined)
  ) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const newJti = randomUUID();
  // A client's new token: at most a client session long, at the epoch the
  // old one was checked against.
  const minted = isClient
    ? buildMobileToken(
        row.userId,
        newJti,
        Math.min(WEB_TOKEN_TTL_SECONDS, CLIENT_SESSION_TTL_SECONDS),
        row.sessionEpoch,
      )
    : buildMobileToken(row.userId, newJti, WEB_TOKEN_TTL_SECONDS);
  const rotated = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(mobileTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(mobileTokens.id, jti), isNull(mobileTokens.revokedAt)))
      .returning({ id: mobileTokens.id });
    if (claimed.length === 0) return false;
    await tx.insert(mobileTokens).values({
      id: newJti,
      userId: row.userId,
      label: row.label,
      expiresAt: minted.expiresAt,
      lastUsedAt: new Date(),
    });
    // The push devices the old token enrolled follow the new one (mobile_roles_push):
    // a device is pushed to only while its token is live.
    await tx
      .update(pushSubscriptions)
      .set({ tokenId: newJti })
      .where(eq(pushSubscriptions.tokenId, jti));
    return true;
  });
  if (!rotated) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  auditFireAndForget({
    actorId: row.userId,
    actorEmail: row.email ?? '',
    action: 'auth.token_refreshed',
    method: 'POST',
    path: '/api/auth/token/refresh',
    detail: { device: row.label, rotatedFrom: jti, rotatedTo: newJti },
    ...requestMetaFrom(req),
  });

  return NextResponse.json({
    token: minted.value,
    expiresIn: minted.expiresInSec,
    expiresAt: minted.expiresAt.toISOString(),
    deviceId: newJti,
    role: row.role,
  });
}
