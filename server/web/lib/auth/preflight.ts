/**
 * Shared preflight for the unauthenticated credential-exchange endpoints:
 * the share token exchange (`/s/<token>/auth`) and the SSO handoff
 * (`/api/auth/sso`). (The team-code `/api/team/auth` and `/api/team/sso` were
 * retired in member logins Phase 6.)
 *
 * Both accept a short secret from a caller who has not authenticated yet, so
 * both throttle before doing any work and answer a throttled caller
 * identically. What they must NOT share is the policy: each keeps its own
 * bucket names and caps, because a per-share exchange and a brain-level SSO
 * upgrade have genuinely different budgets.
 */
import { NextResponse } from '../../server/http-compat';
import type { RateLimitResult } from '../rate-limit';
import { requestOrigin } from '../auth-constants';
import { env } from '@mantle/config';

/**
 * The shared 429 when any of `gates` is exhausted, else null — so a caller
 * reads as `if (const denied = rateLimited(a, b)) return denied`.
 *
 * `Retry-After` is the longest window across the gates: a caller who waits out
 * the shortest one would only be refused again by the next.
 */
export function rateLimited(...gates: RateLimitResult[]): NextResponse | null {
  if (gates.every((g) => g.ok)) return null;
  const retryAfterSec = Math.max(...gates.map((g) => g.retryAfterSec));
  return NextResponse.json(
    { ok: false, error: 'too many attempts — try again shortly' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
  );
}

/**
 * Login-CSRF hardening for the SSO handoffs: when a browser sends `Origin` it
 * must be one of OURS, so no third-party page can pin a browser's server-origin
 * session to an identity of its choosing.
 *
 * Absent — same-origin navigations in some browsers, and curl — is trusted:
 * the credential in the request is the actual gate, and `Origin` only ever
 * narrows it. The opaque `'null'` origin (sandboxed iframe, redirected POST)
 * is likewise not a claim we can check, so it is treated as absent.
 *
 * Callers answer a rejection in their own words; only the decision is shared.
 */
export function isTrustedOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin || origin === 'null') return true;
  const clientOrigin = (env('MANTLE_CLIENT_ORIGIN') ?? '').replace(/\/+$/, '');
  return origin === requestOrigin(req) || origin === clientOrigin;
}

/** The origins the brain answers cross-origin by name (MANTLE_API_CORS_ORIGINS
 *  without its '*': the wildcard is refused on /api/auth anyway). */
function namedCorsOrigins(): string[] {
  return (env('MANTLE_API_CORS_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => s && s !== '*');
}

/** Is `Content-Type` JSON (`application/json`, any parameters)? */
function isJsonContentType(req: Request): boolean {
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  return type === 'application/json';
}

/**
 * Login-CSRF guard for the public /api/auth POSTs that take a JSON body and
 * set or use the session cookie (client logins audit B15): client-link,
 * client-code, client-code/verify, login, signup, invite/accept and
 * change-password. Call it first, before any limiter or lookup.
 *
 *  - 415 unless the body is declared JSON. A cross-site HTML form can send
 *    only urlencoded, multipart or text/plain; JSON needs a CORS preflight,
 *    which /api/auth answers only for origins listed by name.
 *  - 403 for a cross-site browser request: an `Origin` must be ours (this
 *    brain's origin, MANTLE_CLIENT_ORIGIN, or a named MANTLE_API_CORS_ORIGINS
 *    entry: the split owner UI and a detached client call from there). With
 *    no usable `Origin` (absent, or the opaque 'null' of a sandboxed frame),
 *    `Sec-Fetch-Site: cross-site` is refused.
 *
 * A non-browser client (the mobile app, curl) sends neither header and
 * passes. The bearer routes (token, token/refresh, mobile-login, pair/claim)
 * set no cookie and are left alone: shipped companion builds call them.
 * `json: false` checks only the origin (logout, whose body is optional).
 */
export function refuseCrossSiteAuthPost(
  req: Request,
  opts: { json?: boolean } = {},
): NextResponse | null {
  const origin = req.headers.get('origin');
  let crossSite: boolean;
  if (origin && origin !== 'null') {
    const claimed = origin.replace(/\/+$/, '');
    // Ours: the origin the proxy says it served (isTrustedOrigin), the one
    // the server built the request URL from, or a named cross-origin caller.
    crossSite =
      !isTrustedOrigin(req) &&
      claimed !== new URL(req.url).origin &&
      !namedCorsOrigins().includes(claimed);
  } else {
    crossSite = (req.headers.get('sec-fetch-site') ?? '').toLowerCase() === 'cross-site';
  }
  if (crossSite) {
    return NextResponse.json(
      { error: 'Cross-site request refused.', reason: 'cross-site' },
      { status: 403 },
    );
  }
  if ((opts.json ?? true) && !isJsonContentType(req)) {
    return NextResponse.json(
      { error: 'Send the body as JSON (Content-Type: application/json).', reason: 'not-json' },
      { status: 415 },
    );
  }
  return null;
}
