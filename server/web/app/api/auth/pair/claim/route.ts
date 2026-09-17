import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { db, authUsers, eq, sql } from '@mantle/db';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { claimPairCode } from '@/lib/pair-code';

/**
 * POST /api/auth/pair/claim — the phone's half of QR sign-in. Public (the
 * phone has no session yet), rate-limited by IP like the token logins, body
 * `{ code, deviceName? }`. A good code mints the same kind-'m' bearer
 * `mobile-login` does and answers the same shape (plus `email`, so the phone
 * can show who it is). Every failure — unknown, expired, already used,
 * malformed — is one 401 with one line, so nothing can be enumerated.
 */
const Body = z.object({
  code: z.string().trim().min(16).max(128),
  deviceName: z.string().trim().min(1).max(80).optional(),
});

const CLAIM_FAILED_MESSAGE =
  "That code didn't work. Show a fresh one on the web app and scan again.";

export async function POST(req: Request) {
  const ip = clientIp(req);
  const limit = rateLimit(`auth:pair-claim:${ip}`, { max: 10, windowMs: 60_000 });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many attempts. Try again in a minute.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
    );
  }

  const raw = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: CLAIM_FAILED_MESSAGE }, { status: 401 });
  }

  const claimed = await claimPairCode(parsed.data.code, parsed.data.deviceName);
  if (!claimed) {
    auditFireAndForget({
      actorEmail: '',
      action: 'auth.login_failed',
      method: 'POST',
      path: '/api/auth/pair/claim',
      detail: { channel: 'mobile-qr' },
      ...requestMetaFrom(req),
    });
    return NextResponse.json({ error: CLAIM_FAILED_MESSAGE }, { status: 401 });
  }

  await db
    .update(authUsers)
    .set({ lastLoginAt: sql`now()` })
    .where(eq(authUsers.id, claimed.userId));
  auditFireAndForget({
    actorId: claimed.userId,
    actorEmail: claimed.email,
    action: 'auth.login',
    method: 'POST',
    path: '/api/auth/pair/claim',
    detail: { channel: 'mobile-qr', device: claimed.label },
    ...requestMetaFrom(req),
  });

  return NextResponse.json({
    token: claimed.token,
    expiresIn: claimed.expiresIn,
    expiresAt: claimed.expiresAt.toISOString(),
    deviceId: claimed.deviceId,
    email: claimed.email,
  });
}
