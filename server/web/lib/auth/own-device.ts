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
import { bearerFromHeader } from './request';
import { verifyMobileToken } from './tokens';

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
 *  sign-in) keeps its year. One that rides with a bearer is the web client's
 *  upgrade of it: the upgrade's 7 days, bound to the kept device token, so a
 *  revoke of that device ends it too. */
export function ownCookieOpts(
  req: Request,
  keptJti: string | null,
): { ttlSeconds?: number; deviceJti?: string } {
  if (!bearerFromHeader(req.headers.get('authorization'))) return {};
  return {
    ttlSeconds: OWNER_SSO_COOKIE_TTL_SECONDS,
    ...(keptJti ? { deviceJti: keptJti } : {}),
  };
}
