import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db, authUsers, countUsers } from '@mantle/db';
import { buildSessionCookie, SESSION_COOKIE_NAME } from '@/lib/auth';
import { clientIp, rateLimit } from '@/lib/rate-limit';

/**
 * First-run account creation — the signup that replaces the old manual
 * `INSERT INTO auth.users` via psql. Mantle is single-user, so this endpoint is
 * open ONLY while `auth.users` is empty; once the first account exists it 403s
 * (the door closes). Mirrors the login route: same session cookie, same IP
 * rate-limit before bcrypt.
 */

const SignupBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(1024),
});

export async function POST(req: Request) {
  // Rate limit before the (intentionally slow) bcrypt hash.
  const ip = clientIp(req);
  const limit = rateLimit(`auth:signup:${ip}`, { max: 5, windowMs: 60_000 });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many attempts. Try again in a minute.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
    );
  }

  // Single-user: signup is only available on a fresh install.
  if ((await countUsers()) > 0) {
    return NextResponse.json(
      { error: 'An account already exists. Sign in instead.' },
      { status: 403 },
    );
  }

  const raw = await req.json().catch(() => ({}));
  const parsed = SignupBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Enter a valid email and a password of at least 8 characters.' },
      { status: 400 },
    );
  }

  const email = parsed.data.email.trim();
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const id = randomUUID();

  try {
    await db.insert(authUsers).values({ id, email, passwordHash });
  } catch {
    // Unique-email collision or a second signup racing through the count gate.
    return NextResponse.json(
      { error: 'An account already exists. Sign in instead.' },
      { status: 403 },
    );
  }

  // Sign them straight in — onboarding picks up from /onboarding.
  const { value, maxAgeSec } = buildSessionCookie(id);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSec,
  });
  return res;
}
