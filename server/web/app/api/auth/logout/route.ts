import { NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME, getSessionUser } from '@/lib/auth';
import { secureCookies } from '@/lib/auth-constants';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';

export async function POST(req: Request) {
  // Attribute the logout while the cookie is still readable; no valid session
  // (already logged out, expired) → nothing to record.
  const user = await getSessionUser();
  if (user) {
    auditFireAndForget({
      actorId: user.actor.id,
      actorEmail: user.actor.email,
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
