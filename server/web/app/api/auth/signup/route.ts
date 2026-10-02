import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { countUsers } from '@mantle/db';
import { buildSessionCookie, SESSION_COOKIE_NAME } from '@/lib/auth';
import { secureCookies } from '@/lib/auth-constants';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { refuseCrossSiteAuthPost } from '@/lib/auth/preflight';
import { createFirstOwner } from '@/lib/auth/first-owner';
import { setupCodeConfigured, setupCodeMatches } from '@/lib/auth/setup-code';
import { AUTH_BODY_CEILING_BYTES, readJsonCapped } from '@/lib/body-limit';

/**
 * First-run account creation — the signup that replaces the old manual
 * `INSERT INTO auth.users` via psql. Mantle is single-user, so this endpoint is
 * open ONLY while `auth.users` is empty; once the first account exists it 403s
 * (the door closes). Mirrors the login route: same session cookie, same IP
 * rate-limit before bcrypt.
 *
 * When the box has a setup code (MANTLE_SETUP_CODE, written by the installer),
 * the body must carry it as `setupCode`: without it, whoever reaches a fresh
 * box first would own it. A wrong or missing code is a 403 with
 * `reason: 'setup-code'`. The rate limit runs BEFORE the compare, so the code
 * cannot be guessed faster than five tries a minute per address.
 */

const SignupBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(1024),
  setupCode: z.string().max(200).optional(),
});

export async function POST(req: Request) {
  const refused = refuseCrossSiteAuthPost(req);
  if (refused) return refused;
  // Rate limit before the setup-code compare and the (intentionally slow)
  // bcrypt hash.
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

  const raw = (await readJsonCapped(req, AUTH_BODY_CEILING_BYTES)) ?? {};
  const parsed = SignupBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Enter a valid email and a password of at least 8 characters.' },
      { status: 400 },
    );
  }

  if (setupCodeConfigured() && !setupCodeMatches(parsed.data.setupCode)) {
    auditFireAndForget({
      actorEmail: parsed.data.email.trim().toLowerCase(),
      action: 'auth.signup_failed',
      method: 'POST',
      path: '/api/auth/signup',
      detail: { reason: parsed.data.setupCode ? 'setup-code-wrong' : 'setup-code-missing' },
      ...requestMetaFrom(req),
    });
    return NextResponse.json(
      {
        error: parsed.data.setupCode
          ? 'That setup code is not right. Check it and try again.'
          : 'Enter the setup code the installer printed.',
        reason: 'setup-code',
      },
      { status: 403 },
    );
  }

  const created = await createFirstOwner(parsed.data.email, parsed.data.password);
  if (!created.ok) {
    return NextResponse.json(
      { error: 'An account already exists. Sign in instead.' },
      { status: 403 },
    );
  }
  const { id, email } = created;

  auditFireAndForget({
    actorId: id,
    actorEmail: email,
    action: 'user.create',
    method: 'POST',
    path: '/api/auth/signup',
    detail: { firstRun: true, isOwner: true },
    ...requestMetaFrom(req),
  });

  // Sign them straight in — onboarding picks up from /onboarding.
  // A brand-new login: its session epoch is the column default, 0.
  const { value, maxAgeSec } = buildSessionCookie(id, { epoch: 0 });
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
