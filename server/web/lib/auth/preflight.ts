/**
 * Shared preflight for the unauthenticated credential-exchange endpoints:
 * the origin checks of the SSO handoff (`/api/auth/sso`) and the login-CSRF
 * refusal of the public auth posts. (The team-code `/api/team/auth` and
 * `/api/team/sso` were retired in member logins Phase 6.)
 *
 * Their throttles are rows' limits now (A10 #8): each its own named limit
 * (lib/route-limits.ts RATE_LIMITS), taken by the gate before the handler
 * and answered with the one 429. The cross-site refusal is the gate's too,
 * on the rows that name it (ROUTE_GATES `crossSite`), before any limit.
 */
import { NextResponse } from '../../server/http-compat';
import { requestOrigin } from '../auth-constants';
import { env } from '@mantle/config';

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
 * set or use the session cookie (client logins audit B15): login, signup,
 * invite/accept, change-password, the contact code (/s/:token/code), and
 * sign-out by its origin. The gate calls it for the rows that name it
 * (lib/route-limits.ts ROUTE_GATES `crossSite`), first, before any limiter
 * or lookup.
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
