import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { db, authUsers, eq, sql } from '@mantle/db';
import { buildSessionCookie, loginWithPassword, SESSION_COOKIE_NAME } from '@/lib/auth';
import { secureCookies } from '@/lib/auth-constants';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { clientIp, rateLimit } from '@/lib/rate-limit';

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(1024),
});

/** Single message for every failure so the response can't be used to
 *  enumerate which emails exist or distinguish a malformed body from a
 *  wrong password. */
const AUTH_FAILED_MESSAGE = 'Invalid email or password.';

export async function POST(req: Request) {
  // Rate limit by client IP before bcrypt so a flood doesn't pin CPU.
  // 10/min comfortably fits a user mistyping a password a few times;
  // it's brutal for credential stuffing.
  const ip = clientIp(req);
  const limit = rateLimit(`auth:login:${ip}`, { max: 10, windowMs: 60_000 });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many login attempts. Try again in a minute.' },
      {
        status: 429,
        headers: { 'Retry-After': String(limit.retryAfterSec) },
      },
    );
  }

  const raw = await req.json().catch(() => ({}));
  const parsed = LoginBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: AUTH_FAILED_MESSAGE }, { status: 401 });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const userId = await loginWithPassword(email, parsed.data.password);
  if (!userId) {
    // No actor id — the attempted email may not even exist. The 10/min/IP rate
    // limit above caps how fast this can grow the trail.
    auditFireAndForget({
      actorEmail: email,
      action: 'auth.login_failed',
      method: 'POST',
      path: '/api/auth/login',
      ...requestMetaFrom(req),
    });
    return NextResponse.json({ error: AUTH_FAILED_MESSAGE }, { status: 401 });
  }

  await db
    .update(authUsers)
    .set({ lastLoginAt: sql`now()` })
    .where(eq(authUsers.id, userId));
  auditFireAndForget({
    actorId: userId,
    actorEmail: email,
    action: 'auth.login',
    method: 'POST',
    path: '/api/auth/login',
    ...requestMetaFrom(req),
  });

  const { value, maxAgeSec } = buildSessionCookie(userId);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    secure: secureCookies(req),
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSec,
  });
  return res;
}
