import { NextResponse } from '@/server/http-compat';
import { SESSION_COOKIE_NAME, endLoginSessions, getLoginOr401 } from '@/lib/auth';
import { secureCookies } from '@/lib/auth-constants';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { refuseCrossSiteAuthPost } from '@/lib/auth/preflight';

/**
 * POST /api/auth/logout: clear this browser's session cookie. With a body of
 * `{ "everywhere": true }` it also ends every other session the login holds
 * (F06): the session epoch is bumped, so each cookie and asset token signed
 * before it dies on its next request, and the login's bearers (the mobile
 * app, the web client) are revoked. Every role alike.
 */
export async function POST(req: Request) {
  // Origin only: the body is optional (a plain sign-out sends none).
  const refused = refuseCrossSiteAuthPost(req, { json: false });
  if (refused) return refused;
  const body = (await req.json().catch(() => null)) as { everywhere?: unknown } | null;
  const everywhere = body?.everywhere === true;
  // Attribute the logout while the cookie is still readable; no valid session
  // (already logged out, expired) → nothing to record.
  // Every role signs out the same way (admin, member, client).
  const login = await getLoginOr401();
  if (!(login instanceof NextResponse)) {
    if (everywhere) await endLoginSessions(login.loginId);
    auditFireAndForget({
      actorId: login.loginId,
      actorEmail: login.email,
      action: 'auth.logout',
      method: 'POST',
      path: '/api/auth/logout',
      ...(everywhere ? { detail: { everywhere: true } } : {}),
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
