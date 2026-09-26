import { NextResponse } from '@/server/http-compat';
import { SESSION_COOKIE_NAME, getLoginOr401 } from '@/lib/auth';
import { secureCookies } from '@/lib/auth-constants';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';

export async function POST(req: Request) {
  // Attribute the logout while the cookie is still readable; no valid session
  // (already logged out, expired) → nothing to record.
  // Admin or member: both sign out the same way.
  const login = await getLoginOr401();
  if (!(login instanceof NextResponse)) {
    auditFireAndForget({
      actorId: login.loginId,
      actorEmail: login.email,
      action: 'auth.logout',
      method: 'POST',
      path: '/api/auth/logout',
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
