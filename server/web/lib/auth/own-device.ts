/**
 * The device that asked, for a route that ends a login's other sessions and
 * keeps the caller's own (a password change, an admin resetting their own
 * password).
 *
 * The web client sends its device bearer AND the cookie it upgraded that
 * bearer to (POST /api/auth/sso). The session resolves the cookie first, so
 * such a request reads as a cookie caller; its bearer must still be kept, or
 * the tab is left holding a dead one (access matrix T15). And the cookie
 * given back rides with that bearer: it keeps the upgrade's short life and
 * is bound to the device token, as the upgrade binds it (T2, T14).
 */
import { OWNER_SSO_COOKIE_TTL_SECONDS } from '../owner-sso';
import { loadBearerToken } from './login-row';
import { requestCookie } from '../../server/http-compat/headers';
import { bearerFromHeader } from './request';
import { SESSION_COOKIE_NAME, verifyMobileToken, verifySessionCookie } from './tokens';

/** The request's bearer, when it is a live device token of `loginId`: its
 *  id, the one to keep. Null for no bearer, another login's, or one that is
 *  revoked or expired. */
export async function ownLiveDeviceJti(req: Request, loginId: string): Promise<string | null> {
  const token = bearerFromHeader(req.headers.get('authorization'));
  if (!token) return null;
  const claims = verifyMobileToken(token);
  if (!claims || claims.uid !== loginId) return null;
  const row = await loadBearerToken(claims.jti);
  if (!row || row.userId !== loginId || row.revokedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return claims.jti;
}

/** How to re-mint the caller's own cookie. A cookie on its own (a password
 *  sign-in) keeps its year. One made by company sign-in keeps the end it
 *  had (MANTLE_OIDC_SESSION_HOURS from its sign-in): a re-mint never turns
 *  it into a year. One that rides with a bearer is the web client's
 *  upgrade of it: the upgrade's 7 days, bound to the kept device token, so a
 *  revoke of that device ends it too. A bearer company sign-in made gives
 *  the cookie its end and its mark, as the upgrade does. */
export function ownCookieOpts(
  req: Request,
  keptJti: string | null,
): { ttlSeconds?: number; deviceJti?: string; oidc?: boolean } {
  // Checked first, whatever Authorization header rides along (a junk or
  // revoked bearer must not turn it into the 7-day upgrade cookie): the
  // session resolves on the cookie, so the cookie's own end is kept.
  const sso = ownOidcCookieEnd(req);
  if (sso !== null) {
    return { ttlSeconds: sso, oidc: true, ...(keptJti ? { deviceJti: keptJti } : {}) };
  }
  const token = bearerFromHeader(req.headers.get('authorization'));
  if (!token) return {};
  const bearerEnd = ownOidcBearerEnd(token);
  if (bearerEnd !== null) {
    return { ttlSeconds: bearerEnd, oidc: true, ...(keptJti ? { deviceJti: keptJti } : {}) };
  }
  return {
    ttlSeconds: OWNER_SSO_COOKIE_TTL_SECONDS,
    ...(keptJti ? { deviceJti: keptJti } : {}),
  };
}

/** The seconds left on a device bearer company sign-in made (at least 1),
 *  else null. */
function ownOidcBearerEnd(token: string): number | null {
  const c = verifyMobileToken(token);
  return c?.oidc ? Math.max(1, c.exp - Math.floor(Date.now() / 1000)) : null;
}

/** Whether the request's device bearer is one company sign-in made. A phone
 *  or a chat paired from such a session would outlive it, so pairing refuses
 *  it, as it does the cookie (ownOidcCookieEnd). */
export function ownCompanyBearer(req: Request): boolean {
  const token = bearerFromHeader(req.headers.get('authorization'));
  return !!token && ownOidcBearerEnd(token) !== null;
}

/** The seconds left on the request's session cookie when company sign-in
 *  made it (at least 1), else null. Read with the session's own parser
 *  (requestCookie: the first cookie of the name, one layer of quotes
 *  stripped, as findLogin reads it), so the cookie judged here is the one
 *  the session resolved, never a sibling's or a differently spelt copy. */
export function ownOidcCookieEnd(req: Request): number | null {
  const v = requestCookie(req, SESSION_COOKIE_NAME)?.value;
  const c = v ? verifySessionCookie(v) : null;
  return c?.oidc ? Math.max(1, c.exp - Math.floor(Date.now() / 1000)) : null;
}
