import { NextResponse } from '../server/http-compat';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, authUsers, mobileTokens, eq, sql } from '@mantle/db';
import { buildMobileToken, loginWithPassword } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { clientIp, rateLimit } from '@/lib/rate-limit';

/**
 * Shared credentials→bearer flow behind BOTH token-login routes:
 *
 *   /api/auth/mobile-login — the companion app (1-year TTL, byte-compatible
 *                            with every shipped client)
 *   /api/auth/token        — the web client (30-day TTL, rotated via
 *                            /api/auth/token/refresh)
 *
 * Same credentials as the cookie login, but the response body carries a
 * per-device kind-'m' bearer (hashed-by-id row in mobile_tokens, revocable
 * per device from Settings → Security).
 */
const Body = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(1024),
  deviceName: z.string().trim().min(1).max(80).optional(),
});

/** One message for every failure so the response can't enumerate emails or
 *  distinguish a malformed body from a wrong password (mirrors /api/auth/login). */
const AUTH_FAILED_MESSAGE = 'Invalid email or password.';

export async function handleTokenLogin(
  req: Request,
  opts: { path: string; channel: string; ttlSeconds?: number; defaultLabel: string },
): Promise<NextResponse> {
  // Rate limit by client IP before bcrypt so a flood can't pin CPU. One shared
  // bucket across both token routes — a flood can't double its budget by
  // alternating endpoints.
  const ip = clientIp(req);
  const limit = rateLimit(`auth:token-login:${ip}`, { max: 10, windowMs: 60_000 });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many login attempts. Try again in a minute.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
    );
  }

  const raw = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: AUTH_FAILED_MESSAGE }, { status: 401 });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const userId = await loginWithPassword(email, parsed.data.password);
  if (!userId) {
    auditFireAndForget({
      actorEmail: email,
      action: 'auth.login_failed',
      method: 'POST',
      path: opts.path,
      detail: { channel: opts.channel },
      ...requestMetaFrom(req),
    });
    return NextResponse.json({ error: AUTH_FAILED_MESSAGE }, { status: 401 });
  }

  const label = parsed.data.deviceName ?? opts.defaultLabel;
  const jti = randomUUID();
  const { value, expiresInSec, expiresAt } = buildMobileToken(userId, jti, opts.ttlSeconds);
  await db.insert(mobileTokens).values({ id: jti, userId, label, expiresAt });
  await db
    .update(authUsers)
    .set({ lastLoginAt: sql`now()` })
    .where(eq(authUsers.id, userId));
  auditFireAndForget({
    actorId: userId,
    actorEmail: email,
    action: 'auth.login',
    method: 'POST',
    path: opts.path,
    detail: { channel: opts.channel, device: label },
    ...requestMetaFrom(req),
  });

  return NextResponse.json({
    token: value,
    expiresIn: expiresInSec,
    expiresAt: expiresAt.toISOString(),
    deviceId: jti,
  });
}
