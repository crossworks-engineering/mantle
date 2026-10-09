import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import {
  endLoginSessions,
  getLoginOr401,
  loginRefused,
  setSessionCookie,
  updatePassword,
  verifyPassword,
} from '@/lib/auth';
import { ownCookieOpts, ownLiveDeviceJti } from '@/lib/auth/own-device';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { firstIssue } from '@/lib/zod-issue';
import { refuseCrossSiteAuthPost } from '@/lib/auth/preflight';
import { AUTH_BODY_CEILING_BYTES, readJsonCapped } from '@/lib/body-limit';

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

  const raw = (await readJsonCapped(req, AUTH_BODY_CEILING_BYTES)) ?? {};
  const parsed = ChangePasswordBody.safeParse(raw);
  if (!parsed.success) {
    const message = firstIssue(parsed.error, 'Invalid input.');
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const ok = await verifyPassword(actorId, parsed.data.oldPassword);
  if (!ok) {
    return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 401 });
  }

  // The device that asked, before anything is revoked: its own live device
  // token, whether the request resolved on it (the phone) or on the cookie
  // the web client upgraded it to, which rides with it (access matrix T15).
  const keepJti = await ownLiveDeviceJti(req, actorId);
  await updatePassword(actorId, parsed.data.newPassword);
  // A new password ends every other session the login holds (F06): the epoch
  // bump kills each cookie and asset token signed before it, and the login's
  // bearers are revoked. The device that asked stays signed in: it keeps its
  // own bearer (only the others are revoked), and a cookie caller gets a
  // fresh cookie at the new epoch.
  const unboundPeerIds: string[] = [];
  const epoch = await endLoginSessions(actorId, { keepJti, endKeys: true, unboundPeerIds });
  auditFireAndForget({
    actorId,
    actorEmail: login.email,
    action: 'auth.password_change',
    method: 'POST',
    path: '/api/auth/change-password',
    ...requestMetaFrom(req),
  });
  // How many linked brains (peers acting as the login) were unbound: binding
  // one to the same login again restores it (access matrix L12).
  const res = NextResponse.json({ ok: true, peersUnbound: unboundPeerIds.length });
  // A cookie that rides with a bearer is the web client's upgrade of it
  // (POST /api/auth/sso): it keeps that short life, or the re-mint would
  // outlive the device's revocable bearer by a year, and it is bound to the
  // kept device token, so a revoke of that device ends it.
  if (login.source === 'web' && epoch !== null) {
    setSessionCookie(res, req, actorId, epoch, ownCookieOpts(req, keepJti));
  }
  return res;
}
