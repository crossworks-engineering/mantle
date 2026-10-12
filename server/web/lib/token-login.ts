import { NextResponse } from '../server/http-compat';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, authUsers, mobileTokens, eq, sql } from '@mantle/db';
import { buildMobileToken, loginWithPassword } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { clientIpKey, rateLimit } from '@/lib/rate-limit';
import { AUTH_BODY_CEILING_BYTES, readJsonCapped } from '@/lib/body-limit';
import { brainIdField } from '@/lib/brain-identity';
import { updateTheAppResponse } from '@/lib/mobile-build';

/**
 * Shared credentials→bearer flow behind BOTH token-login routes:
 *
 *   /api/auth/mobile-login — the companion app (1-year TTL, byte-compatible
 *                            with every shipped client)
 *   /api/auth/token        — the web client (30-day TTL, rotated via
 *                            /api/auth/token/refresh)
 *   /api/auth/device-login — the phone app for an admin or a member (30-day
 *                            TTL, rotated the same way; the answer names
 *                            the role)
 *
 * Same credentials as the cookie login, but the response body carries a
 * per-device kind-'m' bearer (hashed-by-id row in mobile_tokens, revocable
 * per device from Settings → Logins).
 */
const Body = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(1024),
  // A label, never a credential: read loosely and clamped (deviceLabel), so
  // a long or empty name cannot turn a good password into "Invalid".
  deviceName: z.unknown().optional(),
});

/** The device's label: the name the caller sent, trimmed and cut to 80
 *  characters, else `fallback`. */
export function deviceLabel(name: unknown, fallback: string): string {
  return (typeof name === 'string' ? name.trim().slice(0, 80) : '') || fallback;
}

/** One message for every failure so the response can't enumerate emails or
 *  distinguish a malformed body from a wrong password (mirrors /api/auth/login). */
const AUTH_FAILED_MESSAGE = 'Invalid email or password.';

export async function handleTokenLogin(
  req: Request,
  opts: {
    path: string;
    channel: string;
    ttlSeconds?: number;
    defaultLabel: string;
    /** Refuse a non-Admin login (the old mobile companion: every route it
     *  calls is an admin route, so a member bearer would only collect 403s).
     *  Since workspaces W7e it answers 426 "Update the app": the phone build
     *  that serves every login signs in through /api/auth/device-login. */
    adminsOnly?: boolean;
    /** Name the login in the answer (`role`, `loginId`): the phone app must
     *  know which shell to call before it calls one. */
    withRole?: boolean;
  },
): Promise<NextResponse> {
  // Rate limit by client IP before bcrypt so a flood can't pin CPU. One shared
  // bucket across both token routes — a flood can't double its budget by
  // alternating endpoints.
  // Per address, an IPv6 caller by its /64 (as the code routes count).
  const limit = rateLimit(`auth:token-login:${clientIpKey(req)}`, { max: 10, windowMs: 60_000 });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many login attempts. Try again in a minute.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
    );
  }

  const raw = (await readJsonCapped(req, AUTH_BODY_CEILING_BYTES)) ?? {};
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

  const [login] =
    opts.adminsOnly || opts.withRole
      ? await db
          .select({ role: authUsers.role })
          .from(authUsers)
          .where(eq(authUsers.id, userId))
          .limit(1)
      : [];
  // After the password check, so this cannot tell anyone whether an email
  // exists. No token is minted. A member on the old companion's route: the
  // app is older than the workspaces contract (W7e, plan 7.3), 426 "Update
  // the app". A login that is gone by now is refused like a wrong
  // password (only admins and members sign in with one since W8a).
  if (opts.adminsOnly && login?.role !== 'admin') {
    if (login?.role === 'member') return updateTheAppResponse();
    return NextResponse.json({ error: AUTH_FAILED_MESSAGE }, { status: 401 });
  }

  const label = deviceLabel(parsed.data.deviceName, opts.defaultLabel);
  const jti = randomUUID();
  const { value, expiresInSec, expiresAt } = buildMobileToken(userId, jti, opts.ttlSeconds);
  await db
    .insert(mobileTokens)
    .values({ id: jti, userId, label, expiresAt, signedInAt: new Date() });
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
    detail: { channel: opts.channel, device: label, deviceId: jti },
    ...requestMetaFrom(req),
  });

  return NextResponse.json(
    {
      token: value,
      expiresIn: expiresInSec,
      expiresAt: expiresAt.toISOString(),
      deviceId: jti,
      // device-login: the login and this brain (the key a device holding
      // several logins files the session under, docs/mobile-companion-backend.md).
      ...(opts.withRole ? { role: login?.role, loginId: userId, ...(await brainIdField()) } : {}),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
