import { NextResponse } from '@/server/http-compat';
import { SESSION_COOKIE_NAME, endLoginSessions, getLoginOr401 } from '@/lib/auth';
import { secureCookies } from '@/lib/auth-constants';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { refuseCrossSiteAuthPost } from '@/lib/auth/preflight';
import { AUTH_BODY_CEILING_BYTES, readJsonCapped } from '@/lib/body-limit';

/**
 * POST /api/auth/logout: clear this browser's session cookie. With a body of
 * `{ "everywhere": true }` it also ends every other session the login holds
 * (F06): the session epoch is bumped, so each cookie and asset token signed
 * before it dies on its next request, and the login's bearers (the mobile
 * app, the web client) are revoked. Every role alike, except that a CLIENT's
 * plain sign-out ends its sessions too (client logins audit B23): a client
 * is often on a shared computer, and a download URL left in its history
 * must stop working when it signs out, not when the token expires.
 */
export async function POST(req: Request) {
  // Origin only: the body is optional (a plain sign-out sends none).
  const refused = refuseCrossSiteAuthPost(req, { json: false });
  if (refused) return refused;
  const body = (await readJsonCapped(req, AUTH_BODY_CEILING_BYTES)) as {
    everywhere?: unknown;
  } | null;
  const everywhere = body?.everywhere === true;
  // Attribute the logout while the cookie is still readable; no valid session
  // (already logged out, expired) → nothing to record.
  // Every role signs out this way; a client's sign-out also ends its other
  // sessions and asset tokens (audit B23).
  const login = await getLoginOr401();
  if (!(login instanceof NextResponse)) {
    const ending = everywhere || login.kind === 'client';
    if (ending) await endLoginSessions(login.loginId);
    auditFireAndForget({
      actorId: login.loginId,
      actorEmail: login.email,
      action: 'auth.logout',
      method: 'POST',
      path: '/api/auth/logout',
      ...(ending ? { detail: { everywhere: true } } : {}),
      ...requestMetaFrom(req),
    });
  }

  const res = NextResponse.json({ ok: true });
  // Match the set-cookie attributes from login so the overwrite is unambiguous
  // — some browsers treat a value-only re-set as a different cookie.
  res.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: secureCookies(req),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
