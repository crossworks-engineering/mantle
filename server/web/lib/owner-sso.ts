/**
 * The owner SSO handoff handler — POST /api/auth/sso (route re-exports this;
 * lives in lib with relative imports so the co-located vitest run resolves it,
 * same pattern as token-login.ts / team-sso.ts).
 *
 * The owner counterpart of the member `/api/team/sso` upgrade, and it exists
 * for the same reason. Until v0.204 the owner UI decided "am I split?" with
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
 * Unlike the team route this takes NO `next` and never redirects: it is called
 * by `fetch` from our own shell, not by a top-level form navigation, so there
 * is no open-redirect surface to constrain and the bearer rides the
 * Authorization header rather than a form body.
 */
import { NextResponse } from '../server/http-compat';
import { buildSessionCookie, getOwnerOr401, SESSION_COOKIE_NAME } from './auth';
import { isTrustedOrigin, rateLimited } from './auth/preflight';
import { secureCookies } from './auth-constants';
import { rateLimit, clientIp } from './rate-limit';

/** See the mint below for why this is days, not the password login's year. */
export const OWNER_SSO_COOKIE_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function handleOwnerSso(req: Request): Promise<NextResponse> {
  const denied = rateLimited(
    rateLimit(`owner-sso:ip:${clientIp(req)}`, { max: 30, windowMs: 60_000 }),
  );
  if (denied) return denied;

  if (!isTrustedOrigin(req)) {
    return NextResponse.json({ ok: false, error: 'invalid origin' }, { status: 403 });
  }

  // Resolves a session cookie first, then an Authorization bearer — so this is
  // the same gate every owner API route uses, with no separate trust path.
  const user = await getOwnerOr401();
  if (user instanceof Response) return user as NextResponse;

  // Mint for the ACTOR, not the anchor: `user.id` is the anchor the brain's
  // data is keyed to, but a session identifies the login that opened it —
  // keying the cookie to the anchor would silently re-attribute every audit
  // row an added login writes to the anchor instead.
  //
  // SHORT TTL, deliberately — not the password login's year. The bearer this
  // upgrades is 30-day and revocable per device; the session cookie has no
  // revocation at all, so a long mint here would convert a revocable
  // credential into an irrevocable one that outlives it. Seven days is
  // enough because the shell re-fires upgradeOwnerCookie on EVERY page load:
  // the cookie renews continuously while the bearer stays valid, and dies
  // within a week of the device's token being revoked.
  const { value, maxAgeSec } = buildSessionCookie(user.actor.id, OWNER_SSO_COOKIE_TTL_SECONDS);
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
