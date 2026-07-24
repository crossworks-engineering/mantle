import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { db, authUsers, mobileTokens, eq } from '@mantle/db';
import { buildMobileToken, mobileTokenJti, WEB_TOKEN_TTL_SECONDS } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { clientIp, rateLimit } from '@/lib/rate-limit';

/**
 * Rotate the calling web-client bearer: mint a new jti + token, revoke the old
 * row — atomically, so a crash can't leave zero valid tokens. Self-
 * authenticates from the Authorization header (like mobile-logout), so it
 * lives under the public /api/auth prefix.
 *
 * The client calls this opportunistically when expiry is <7 days out
 * (piggybacked on the /api/shell boot call): an active browser never expires,
 * an idle one dies in ≤30 days. Always issues the WEB TTL — the mobile
 * companion doesn't refresh (it holds a 1-year token).
 */
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
  const jti = token ? mobileTokenJti(token) : null;
  if (!jti) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const [row] = await db
    .select({
      userId: mobileTokens.userId,
      label: mobileTokens.label,
      revokedAt: mobileTokens.revokedAt,
      expiresAt: mobileTokens.expiresAt,
      email: authUsers.email,
    })
    .from(mobileTokens)
    .innerJoin(authUsers, eq(authUsers.id, mobileTokens.userId))
    .where(eq(mobileTokens.id, jti))
    .limit(1);
  if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const newJti = randomUUID();
  const minted = buildMobileToken(row.userId, newJti, WEB_TOKEN_TTL_SECONDS);
  await db.transaction(async (tx) => {
    await tx.insert(mobileTokens).values({
      id: newJti,
      userId: row.userId,
      label: row.label,
      expiresAt: minted.expiresAt,
      lastUsedAt: new Date(),
    });
    await tx.update(mobileTokens).set({ revokedAt: new Date() }).where(eq(mobileTokens.id, jti));
  });

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
  });
}
