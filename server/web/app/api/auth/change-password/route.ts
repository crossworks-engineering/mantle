import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import {
  bearerFromHeader,
  endLoginSessions,
  getLoginOr401,
  loginRefused,
  mobileTokenJti,
  setSessionCookie,
  updatePassword,
  verifyPassword,
} from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { firstIssue } from '@/lib/zod-issue';
import { refuseCrossSiteAuthPost } from '@/lib/auth/preflight';

const ChangePasswordBody = z
  .object({
    oldPassword: z.string().min(1).max(1024),
    newPassword: z.string().min(8).max(1024),
  })
  .refine((d) => d.oldPassword !== d.newPassword, {
    message: 'New password must be different from the current one.',
    path: ['newPassword'],
  });

export async function POST(req: Request) {
  const refused = refuseCrossSiteAuthPost(req);
  if (refused) return refused;
  // Admin or member: a login changes its own password. A client has no
  // password (it signs in with a link or a code, client logins C2).
  const login = await getLoginOr401();
  if (login instanceof NextResponse) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }
  if (login.kind !== 'admin' && login.kind !== 'member') return loginRefused(login.kind);
  // The LOGIN's own credential — always the login, never the anchor
  // (a co-admin changing "their" password must not rewrite the anchor's).
  const actorId = login.loginId;

  // Throttle even with a valid session — a hijacked cookie should not
  // be able to pin bcrypt CPU. 5/hour per user comfortably fits any
  // honest workflow.
  const limit = rateLimit(`auth:change-password:${actorId}`, {
    max: 5,
    windowMs: 60 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many password change attempts. Try again later.' },
      {
        status: 429,
        headers: { 'Retry-After': String(limit.retryAfterSec) },
      },
    );
  }

  const raw = await req.json().catch(() => ({}));
  const parsed = ChangePasswordBody.safeParse(raw);
  if (!parsed.success) {
    const message = firstIssue(parsed.error, 'Invalid input.');
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const ok = await verifyPassword(actorId, parsed.data.oldPassword);
  if (!ok) {
    return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 401 });
  }

  await updatePassword(actorId, parsed.data.newPassword);
  // A new password ends every other session the login holds (F06): the epoch
  // bump kills each cookie and asset token signed before it, and the login's
  // bearers are revoked. The device that asked stays signed in: a cookie
  // caller gets a fresh cookie at the new epoch, a bearer caller keeps its
  // own bearer (only the others are revoked).
  const keepJti =
    login.source === 'mobile'
      ? mobileTokenJti(bearerFromHeader(req.headers.get('authorization')) ?? '')
      : null;
  const epoch = await endLoginSessions(actorId, { keepJti });
  auditFireAndForget({
    actorId,
    actorEmail: login.email,
    action: 'auth.password_change',
    method: 'POST',
    path: '/api/auth/change-password',
    ...requestMetaFrom(req),
  });
  const res = NextResponse.json({ ok: true });
  if (login.source === 'web' && epoch !== null) setSessionCookie(res, req, actorId, epoch);
  return res;
}
