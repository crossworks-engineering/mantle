import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db, countUsers } from '@mantle/db';
import { buildSessionCookie, SESSION_COOKIE_NAME } from '@/lib/auth';
import { secureCookies } from '@/lib/auth-constants';
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

  // Store the email lowercased so it matches the case-insensitive login lookup.
  const email = parsed.data.email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const id = randomUUID();

  // Insert ONLY if auth.users is still empty — closes the TOCTOU window between
  // the countUsers() gate above and this insert (two concurrent first-run
  // signups with different emails could otherwise both land, breaking the
  // single-user invariant). The conditional INSERT…SELECT is atomic.
  try {
    const inserted = await db.execute(sql`
      INSERT INTO auth.users (id, email, password_hash)
      SELECT ${id}, ${email}, ${passwordHash}
      WHERE NOT EXISTS (SELECT 1 FROM auth.users)
      RETURNING id
    `);
    if (inserted.length === 0) {
      return NextResponse.json(
        { error: 'An account already exists. Sign in instead.' },
        { status: 403 },
      );
    }
  } catch {
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
    secure: secureCookies(req),
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSec,
  });
  return res;
}
