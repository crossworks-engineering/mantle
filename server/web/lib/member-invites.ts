import { countRateFailure } from '@/lib/route-limits';

/**
 * Shared bits of the member invite routes: the
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
 * lock them out (were every request counted, six addresses at their full
 * rate would). The brain-wide cap is a guard against a distributed
 * flood, not against guessing: an invite code carries about 92 bits, so no
 * rate of guesses finds one. It trips only when at least 12 addresses (the
 * accept) or 20 (the preview) keep failing at their full per-IP rate within
 * one minute, and then only for the rest of that minute.
 *
 * Both are limits of the routes' rows (lib/route-limits.ts: invitePreview
 * and invitePreviewFailures, inviteAccept and inviteAcceptFailures, 30 and
 * 10 a minute per address, 600 and 120 failed codes a minute for the
 * brain), taken by the gate before the handler; the handler counts each
 * failed code here.
 */

/** Count one failed code (an unknown, used, revoked or expired code, or a
 *  malformed request) toward the brain-wide cap. */
export function inviteFailed(kind: 'preview' | 'accept'): void {
  countRateFailure(kind === 'preview' ? 'invitePreviewFailures' : 'inviteAcceptFailures');
}
