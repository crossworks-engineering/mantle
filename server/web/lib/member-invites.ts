import { NextResponse } from '@/server/http-compat';
import { MemberInviteError } from '@mantle/content';
import { clientIpKey, rateLimit, rateLimitPeek } from '@/lib/rate-limit';

/**
 * Shared bits of the member invite routes (member logins, Phase 6): the
 * public preview and accept under /api/auth/invite, and the admin routes
 * under /api/team-admin/invites. The invite logic itself is
 * packages/content/src/member-invites.ts.
 */

/**
 * Per-IP and whole-brain caps on the public invite routes (the preview and
 * the accept are code oracles; an accept also runs bcrypt).
 *
 * Per IP, every request counts: one address cannot guess fast.
 *
 * Brain-wide, only FAILED codes count (a preview's 404, an accept's 401), so
 * honest invitees never spend the budget and a handful of addresses cannot
 * lock them out (final audit F31: at 60 requests a minute across the brain,
 * six addresses did). The brain-wide cap is a guard against a distributed
 * flood, not against guessing: an invite code carries about 92 bits, so no
 * rate of guesses finds one. It trips only when at least 12 addresses (the
 * accept) or 20 (the preview) keep failing at their full per-IP rate within
 * one minute, and then only for the rest of that minute.
 */
export const INVITE_LIMITS = {
  preview: { perIp: 30, globalFailures: 600 },
  accept: { perIp: 10, globalFailures: 120 },
} as const;

const WINDOW_MS = 60_000;

function tooMany(retryAfterSec: number): Response {
  return NextResponse.json(
    { error: 'Too many attempts. Try again in a minute.' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
  );
}

/** A 429 when the caller's address is over its cap, or the brain has seen
 *  too many failed codes this minute; else null. Call before any work. */
export function inviteRateLimited(req: Request, kind: keyof typeof INVITE_LIMITS): Response | null {
  const caps = INVITE_LIMITS[kind];
  const ip = rateLimit(`auth:invite-${kind}:${clientIpKey(req)}`, {
    max: caps.perIp,
    windowMs: WINDOW_MS,
  });
  if (!ip.ok) return tooMany(ip.retryAfterSec);
  const all = rateLimitPeek(`auth:invite-${kind}:failed`, {
    max: caps.globalFailures,
    windowMs: WINDOW_MS,
  });
  return all.ok ? null : tooMany(all.retryAfterSec);
}

/** Count one failed code (an unknown, used, revoked or expired code, or a
 *  malformed request) toward the brain-wide cap. */
export function inviteFailed(kind: keyof typeof INVITE_LIMITS): void {
  rateLimit(`auth:invite-${kind}:failed`, {
    max: INVITE_LIMITS[kind].globalFailures,
    windowMs: WINDOW_MS,
  });
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
