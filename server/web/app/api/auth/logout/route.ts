import { NextResponse } from '@/server/http-compat';
import { SESSION_COOKIE_NAME, endLoginSessions, publicLoginItself } from '@/lib/auth';
import { secureCookies } from '@/lib/auth-constants';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { clearOidcCookies } from '@/lib/oidc/cookies';
import { oidcSettings } from '@/lib/oidc/settings';

export const policy = routePolicy({
  POST: {
    passwordHold: 'sign-out',
    class: 'self',
    public: true,
    caller: 'publicLogin',
    item: { none: "the login's own things, not an item" },
    limits: { crossSite: 'origin' },
  },
});

/**
 * POST /api/auth/logout: clear this browser's session cookie. With a body of
 * `{ "everywhere": true }` it also ends every other session the login holds:
 * the session epoch is bumped, so each cookie and asset token signed
 * before it dies on its next request, and the login's bearers (the mobile
 * app, the web client) are revoked. Every role alike, except that a CLIENT's
 * plain sign-out ends its sessions too: a client
 * is often on a shared computer, and a download URL left in its history
 * must stop working when it signs out, not when the token expires.
 */
export async function POST(req: Request) {
  // The gate refused a cross-site post first, by its origin only: the body
  // is optional (a plain sign-out sends none; this file's `limits`).
  // A body that is not JSON (a form post, a stray byte) reads as none:
  // sign-out still clears the cookie.
  const body = (await readJson(req, { empty: null, invalid: null })) as {
    everywhere?: unknown;
  } | null;
  const everywhere = body?.everywhere === true;
  // Attribute the logout while the cookie is still readable; no valid session
  // (already logged out, expired) → nothing to record.
  // Every login signs out this way; "everywhere" also ends its other
  // sessions, asset tokens and API keys. A public row: the login the
  // pipeline answers at this read, after the origin check and the body.
  const login = await publicLoginItself();
  if (login) {
    if (everywhere) await endLoginSessions(login.loginId, { endKeys: true });
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
  // Company sign-in's short cookies (a held or fresh ticket a link could
  // start on) go too: cleared whenever company sign-in is on (the request
  // is not asked whether it carries them); off, the answer is as before.
  if (oidcSettings().mode !== 'off') clearOidcCookies(res, req);
  return res;
}
