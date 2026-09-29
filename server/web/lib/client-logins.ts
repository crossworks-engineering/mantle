import { randomBytes } from 'node:crypto';
import { NextResponse } from '@/server/http-compat';
import { ClientLoginError } from '@mantle/content';
import { hashLoginPassword } from '@/lib/auth';
import { clientIp, rateLimit, rateLimitPeek } from '@/lib/rate-limit';

/**
 * Shared bits of the client login routes (client logins, Phase C2): the
 * admin routes under /api/team-admin/clients and the public sign-in link
 * route POST /api/auth/client-link. The logic itself is
 * packages/content/src/client-logins.ts.
 */

/**
 * Caps on the public sign-in link route, as for the invite accept (lib/
 * member-invites.ts): every request counts per IP; only FAILED codes count
 * brain-wide, so an honest client never spends the budget. A link code
 * carries about 92 bits, so the caps are a flood guard, not the defence.
 */
export const CLIENT_LINK_LIMITS = { perIp: 10, globalFailures: 120 } as const;
const WINDOW_MS = 60_000;

function tooMany(retryAfterSec: number): Response {
  return NextResponse.json(
    { error: 'Too many attempts. Try again in a minute.' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
  );
}

/** A 429 when the caller's address is over its cap, or the brain has seen
 *  too many failed codes this minute; else null. Call before any work. */
export function clientLinkRateLimited(req: Request): Response | null {
  const ip = rateLimit(`auth:client-link:${clientIp(req)}`, {
    max: CLIENT_LINK_LIMITS.perIp,
    windowMs: WINDOW_MS,
  });
  if (!ip.ok) return tooMany(ip.retryAfterSec);
  const all = rateLimitPeek('auth:client-link:failed', {
    max: CLIENT_LINK_LIMITS.globalFailures,
    windowMs: WINDOW_MS,
  });
  return all.ok ? null : tooMany(all.retryAfterSec);
}

/** Count one failed sign-in toward the brain-wide cap. */
export function clientLinkFailed(): void {
  rateLimit('auth:client-link:failed', {
    max: CLIENT_LINK_LIMITS.globalFailures,
    windowMs: WINDOW_MS,
  });
}

/** A bcrypt hash of 32 random bytes nobody keeps: a client login's
 *  password_hash (NOT NULL), so no password ever opens it. */
export async function unusablePasswordHash(): Promise<string> {
  return hashLoginPassword(randomBytes(32).toString('base64url'));
}

/** The admin routes' refusals, as statuses: 409 for a state the admin must
 *  change first (the report, an existing login), 404 for a login that is
 *  not a client, 400 for bad input. */
export function clientLoginErrorResponse(err: unknown): Response {
  if (err instanceof ClientLoginError) {
    const status =
      err.reason === 'report-not-acknowledged' ||
      err.reason === 'email-has-login' ||
      err.reason === 'contact-has-login'
        ? 409
        : err.reason === 'not-a-client'
          ? 404
          : 400;
    return NextResponse.json({ error: err.message, reason: err.reason }, { status });
  }
  throw err;
}
