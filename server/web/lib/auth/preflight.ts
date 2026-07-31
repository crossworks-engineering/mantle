/**
 * Shared preflight for the unauthenticated credential-exchange endpoints:
 * the two token exchanges (`/s/<token>/auth`, `/api/team/auth`) and the two SSO
 * handoffs (`/api/auth/sso`, `/api/team/sso`).
 *
 * All four accept a short secret from a caller who has not authenticated yet,
 * so all four throttle before doing any work and answer a throttled caller
 * identically. What they must NOT share is the policy: each keeps its own
 * bucket names and caps, because a per-share exchange and a brain-level SSO
 * upgrade have genuinely different budgets.
 */
import { NextResponse } from '../../server/http-compat';
import type { RateLimitResult } from '../rate-limit';
import { requestOrigin } from '../auth-constants';

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
  const clientOrigin = (process.env.MANTLE_CLIENT_ORIGIN ?? '').replace(/\/+$/, '');
  return origin === requestOrigin(req) || origin === clientOrigin;
}
