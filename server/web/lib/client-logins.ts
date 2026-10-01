import { randomBytes } from 'node:crypto';
import { NextResponse } from '@/server/http-compat';
import { ClientLoginError } from '@mantle/content';
import { hashLoginPassword } from '@/lib/auth';
import { secureCookies } from '@/lib/auth-constants';
import { clientIpKey, rateLimit, rateLimitPeek } from '@/lib/rate-limit';

/**
 * Shared bits of the client login routes (client logins, Phase C2): the
 * admin routes under /api/team-admin/clients and the public sign-in link
 * route POST /api/auth/client-link, and the email code routes under
 * /api/auth/client-code (C2b). The logic itself is
 * packages/content/src/client-logins.ts and client-codes.ts.
 */

/**
 * The cap on the public sign-in link route: every request counts per
 * address (an IPv6 caller by its /64, `clientIpKey`). There is NO brain-wide
 * failure cap (client logins audit B11): one counted before the lookup let a
 * stranger with a dozen addresses hold every client's link sign-in at 429. A
 * link code carries about 92 bits, so the cap is a flood guard, not the
 * defence.
 */
export const CLIENT_LINK_LIMITS = { perIp: 10 } as const;
const WINDOW_MS = 60_000;

function tooMany(retryAfterSec: number): Response {
  return NextResponse.json(
    { error: 'Too many attempts. Try again in a minute.' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
  );
}

/** A 429 when the caller's address is over its cap; else null. Call before
 *  any work. */
export function clientLinkRateLimited(req: Request): Response | null {
  const ip = rateLimit(`auth:client-link:${clientIpKey(req)}`, {
    max: CLIENT_LINK_LIMITS.perIp,
    windowMs: WINDOW_MS,
  });
  return ip.ok ? null : tooMany(ip.retryAfterSec);
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

// ── Email sign-in codes (C2b) ───────────────────────────────────────────────

/** The request cookie of an emailed code: the browser that asked. Only the
 *  code routes see it (its path). */
export const CLIENT_CODE_COOKIE = 'mantle_code_req';
const CODE_COOKIE_PATH = '/api/auth/client-code';
const CODE_COOKIE_MAX_AGE = 15 * 60;

/**
 * Caps on the code routes, per address: an IPv6 caller counts by its /64
 * (`clientIpKey`, client logins audit B2). A request: every one counts per address (a
 * code is mailed at most once per open code anyway, and the mail caps live
 * with the code). A verify: every one counts per address, and FAILED tries
 * count per email plus address. There is NO brain-wide failure cap (plan
 * section 4): a stranger cannot lock the clients out.
 */
export const CLIENT_CODE_LIMITS = {
  requestPerIp: 10,
  verifyPerIp: 30,
  verifyFailuresPerEmailIp: 5,
} as const;
const FAILURE_WINDOW_MS = 10 * 60_000;

export function clientCodeRequestLimited(req: Request): Response | null {
  const ip = rateLimit(`auth:client-code:${clientIpKey(req)}`, {
    max: CLIENT_CODE_LIMITS.requestPerIp,
    windowMs: WINDOW_MS,
  });
  return ip.ok ? null : tooMany(ip.retryAfterSec);
}

const failureKey = (req: Request, email: string) =>
  `auth:client-code-failed:${email.trim().toLowerCase()}:${clientIpKey(req)}`;

/** A 429 when the address is over its cap, or this email has failed too
 *  often from this address; else null. Call before any lookup. */
export function clientCodeVerifyLimited(req: Request, email: string): Response | null {
  const ip = rateLimit(`auth:client-code-verify:${clientIpKey(req)}`, {
    max: CLIENT_CODE_LIMITS.verifyPerIp,
    windowMs: WINDOW_MS,
  });
  if (!ip.ok) return tooMany(ip.retryAfterSec);
  const failed = rateLimitPeek(failureKey(req, email), {
    max: CLIENT_CODE_LIMITS.verifyFailuresPerEmailIp,
    windowMs: FAILURE_WINDOW_MS,
  });
  return failed.ok ? null : tooMany(failed.retryAfterSec);
}

/** Count one failed verify for this email from this address. */
export function clientCodeVerifyFailed(req: Request, email: string): void {
  rateLimit(failureKey(req, email), {
    max: CLIENT_CODE_LIMITS.verifyFailuresPerEmailIp,
    windowMs: FAILURE_WINDOW_MS,
  });
}

const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A request id a caller sent in a body (device mode), when it is one. */
export function requestIdFrom(value: unknown): string | null {
  return typeof value === 'string' && REQUEST_ID_RE.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

/** The request id this browser's request cookie holds, when it holds one. */
export function existingRequestId(req: Request): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== CLIENT_CODE_COOKIE) continue;
    const id = decodeURIComponent(v.join('=')).trim();
    return REQUEST_ID_RE.test(id) ? id.toLowerCase() : null;
  }
  return null;
}

/** Set the request cookie holding `requestId` (15 minutes from now). */
export function setClientCodeCookie(res: NextResponse, req: Request, requestId: string): void {
  res.cookies.set(CLIENT_CODE_COOKIE, requestId, {
    httpOnly: true,
    secure: secureCookies(req),
    sameSite: 'strict',
    path: CODE_COOKIE_PATH,
    maxAge: CODE_COOKIE_MAX_AGE,
  });
}

export function clearClientCodeCookie(res: NextResponse, req: Request): void {
  res.cookies.set(CLIENT_CODE_COOKIE, '', {
    httpOnly: true,
    secure: secureCookies(req),
    sameSite: 'strict',
    path: CODE_COOKIE_PATH,
    maxAge: 0,
  });
}
