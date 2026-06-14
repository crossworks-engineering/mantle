import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, mobileTokens } from '@mantle/db';
import { buildMobileToken, loginWithPassword } from '@/lib/auth';
import { clientIp, rateLimit } from '@/lib/rate-limit';

/**
 * Mobile companion login. Same credentials as the web login, but instead of a
 * session cookie it returns a per-device bearer token (stored hashed-by-id in
 * mobile_tokens, revocable per device). Lives under /api/auth, which is public
 * (bypasses the session middleware) — see auth-constants.ts.
 */
const Body = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(1024),
  deviceName: z.string().trim().min(1).max(80).optional(),
});

/** One message for every failure so the response can't enumerate emails or
 *  distinguish a malformed body from a wrong password (mirrors /api/auth/login). */
const AUTH_FAILED_MESSAGE = 'Invalid email or password.';

export async function POST(req: Request) {
  // Rate limit by client IP before bcrypt so a flood can't pin CPU.
  const ip = clientIp(req);
  const limit = rateLimit(`auth:mobile-login:${ip}`, { max: 10, windowMs: 60_000 });
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

  const userId = await loginWithPassword(parsed.data.email, parsed.data.password);
  if (!userId) {
    return NextResponse.json({ error: AUTH_FAILED_MESSAGE }, { status: 401 });
  }

  const jti = randomUUID();
  const { value, expiresInSec, expiresAt } = buildMobileToken(userId, jti);
  await db.insert(mobileTokens).values({
    id: jti,
    userId,
    label: parsed.data.deviceName ?? 'Mobile device',
    expiresAt,
  });

  return NextResponse.json({ token: value, expiresIn: expiresInSec });
}
