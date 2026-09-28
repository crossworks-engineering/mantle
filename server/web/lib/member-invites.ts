import { NextResponse } from '@/server/http-compat';
import { MemberInviteError } from '@mantle/content';
import { clientIp, rateLimit } from '@/lib/rate-limit';

/**
 * Shared bits of the member invite routes (member logins, Phase 6): the
 * public preview and accept under /api/auth/invite, and the admin routes
 * under /api/team-admin/invites. The invite logic itself is
 * packages/content/src/member-invites.ts.
 */

/** Per-IP and whole-brain caps. The public routes are code oracles, so both
 *  apply: one address cannot guess fast, and many addresses together cannot
 *  either. A preview is cheap; an accept runs bcrypt. */
export const INVITE_LIMITS = {
  preview: { perIp: 30, global: 300 },
  accept: { perIp: 10, global: 60 },
} as const;

const WINDOW_MS = 60_000;

/** A 429 when the caller is over either cap, else null. The per-IP bucket is
 *  taken first, so one noisy address does not spend the global budget. */
export function inviteRateLimited(req: Request, kind: keyof typeof INVITE_LIMITS): Response | null {
  const caps = INVITE_LIMITS[kind];
  const ip = rateLimit(`auth:invite-${kind}:${clientIp(req)}`, {
    max: caps.perIp,
    windowMs: WINDOW_MS,
  });
  const hit = ip.ok
    ? rateLimit(`auth:invite-${kind}:all`, { max: caps.global, windowMs: WINDOW_MS })
    : ip;
  if (hit.ok) return null;
  return NextResponse.json(
    { error: 'Too many attempts. Try again in a minute.' },
    { status: 429, headers: { 'Retry-After': String(hit.retryAfterSec) } },
  );
}

/** The admin create's refusals, as statuses. */
export function inviteErrorResponse(err: unknown): Response {
  if (err instanceof MemberInviteError) {
    const status =
      err.reason === 'contact-has-login' || err.reason === 'email-has-login' ? 409 : 400;
    return NextResponse.json({ error: err.message, reason: err.reason }, { status });
  }
  throw err;
}
