import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import {
  endLoginSessions,
  publicLoginCaller,
  setSessionCookie,
  updatePassword,
  verifyPassword,
} from '@/lib/auth';
import { ownCookieOpts, ownLiveDeviceJti } from '@/lib/auth/own-device';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';

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
  // Every login changes its own password. A public row: the login the
  // pipeline answers at this read, after the gate's cross-site refusal (A4
  // hand batch B; lib/route-limits.ts ROUTE_GATES), as the guard was called
  // here. The read takes the row's per-login limit (authChangePassword, 5
  // an hour: a hijacked cookie must not pin bcrypt) and throws the one 429
  // over it.
  const login = await publicLoginCaller();
  if (!login) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }
  // The LOGIN's own credential — always the login, never the anchor
  // (a co-admin changing "their" password must not rewrite the anchor's).
  const actorId = login.loginId;

  const raw = (await readJson(req)) ?? {};
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
