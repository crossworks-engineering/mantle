/**
 * The bearer-to-cookie SSO handoff handler — POST /api/auth/sso (route re-exports this;
 * lives in lib with relative imports so the co-located vitest run resolves it,
 * same pattern as token-login.ts).
 *
 * It began as the owner counterpart of the team-code `/api/team/sso` upgrade
 * (retired in member logins Phase 6). Until v0.204 the owner UI decided "am I split?" with
 * `runtimeApiBase() !== ''`, which is TRUE on every same-origin box that sets
 * a base — so owners on a one-domain deployment authenticated in BEARER mode
 * and hold no session cookie. The API surface doesn't care (the bearer is a
 * first-class carrier), but the browser-native loaders do: `<img>`, `<iframe>`
 * and download anchors can't set an Authorization header, so once those go
 * back to same-origin cookie auth, a bearer-only owner would 401 on every
 * asset.
 *
 * So: verify the caller (cookie OR bearer, whichever they have), mint a fresh
 * session cookie, answer 204. No token re-entry, no redirect, no re-login.
 *
 * Why this grants nothing new: the bearer it accepts ALREADY authorises every
 * owner API call. Minting a cookie for that same identity moves the credential
 * between carriers, it does not widen it — which is also why a caller who is
 * already on a cookie is served idempotently rather than refused.
 *
 * A MEMBER is upgraded too (team apps, member MCP over OAuth): the MCP
 * consent page is a top-level navigation, which carries cookies only, so a
 * bearer-only member reached it as nobody and was bounced to /login. The
 * member's cookie reaches what its bearer already reaches, and no more. A
 * client is refused (see getCookieUpgradeLoginOr401).
 *
 * Unlike the retired team route this takes NO `next` and never redirects: it is called
 * by `fetch` from our own shell, not by a top-level form navigation, so there
 * is no open-redirect surface to constrain and the bearer rides the
 * Authorization header rather than a form body.
 */
import { NextResponse } from '../server/http-compat';
import { buildSessionCookie, getCookieUpgradeLoginOr401, SESSION_COOKIE_NAME } from './auth';
import { isTrustedOrigin, rateLimited } from './auth/preflight';
import { secureCookies } from './auth-constants';
import { clientIpKey, rateLimit } from './rate-limit';

/** See the mint below for why this is days, not the password login's year. */
export const OWNER_SSO_COOKIE_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function handleOwnerSso(req: Request): Promise<NextResponse> {
  const denied = rateLimited(
    rateLimit(`owner-sso:ip:${clientIpKey(req)}`, { max: 30, windowMs: 60_000 }),
  );
  if (denied) return denied;

  if (!isTrustedOrigin(req)) {
    return NextResponse.json({ ok: false, error: 'invalid origin' }, { status: 403 });
  }

  // Resolves a session cookie first, then an Authorization bearer — the same
  // resolver every API route uses, with no separate trust path.
  const login = await getCookieUpgradeLoginOr401();
  if (login instanceof Response) return login as NextResponse;

  // Mint for the LOGIN, not the anchor: an admin's data is keyed to the
  // anchor, but a session identifies the login that opened it — keying the
  // cookie to the anchor would silently re-attribute every audit row an added
  // login writes to the anchor instead. Signed at the epoch the credential
  // was just verified at.
  //
  // SHORT TTL, deliberately — not the password login's year. The bearer this
  // upgrades is 30-day and revocable per device; the session cookie is
  // revocable only for the whole login (its session epoch, 0181), not per
  // device, so a long mint here would let one device's cookie outlive that
  // device's revoked token. Seven days is
  // enough because the shell re-fires upgradeOwnerCookie on EVERY page load:
  // the cookie renews continuously while the bearer stays valid, and dies
  // within a week of the device's token being revoked.
  const { value, maxAgeSec } = buildSessionCookie(login.loginId, {
    epoch: login.epoch,
    ttlSeconds: OWNER_SSO_COOKIE_TTL_SECONDS,
  });
  const res = new NextResponse(null, { status: 204 });
  res.cookies.set(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(req),
    path: '/',
    maxAge: maxAgeSec,
  });
  return res;
}
