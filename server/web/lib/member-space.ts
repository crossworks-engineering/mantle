/**
 * The per-login rate limits of the member routes (member logins Phase 2).
 * The personal space itself is gone since W6b (0267): a member's items are
 * brain items homed in its private workspace, read and written through the
 * normal routes; the space role is retired.
 */
import { NextResponse } from '@/server/http-compat';
import type { MemberCaller } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';

/** Writes a member may make per login per minute (audit F31). Generous: an
 *  editor autosaves every second or two. */
export const MEMBER_WRITES_PER_MIN = 120;

/**
 * The per-login rate limit on a member write route: a 429 with Retry-After,
 * or null to go on. Checked before the body is read. Each write costs only
 * CPU and disk (no model work), but a page draft can be 2 MB and a table
 * save rebuilds its workbook, so a runaway client is bounded here.
 */
export function memberWriteGate(member: MemberCaller): Response | null {
  const gate = rateLimit(`member-writes:${member.loginId}`, {
    max: MEMBER_WRITES_PER_MIN,
    windowMs: 60_000,
  });
  if (gate.ok) return null;
  return NextResponse.json(
    { error: 'Too many changes at once. Wait a moment, then try again.', reason: 'rate-limit' },
    { status: 429, headers: { 'retry-after': String(gate.retryAfterSec) } },
  );
}

/** Requests a member may make to the bytes routes, per login per minute.
 *  A thumbnail may decode an image, so it has its own, smaller budget. */
export const MEMBER_BYTES_PER_MIN = 240;
export const MEMBER_THUMBS_PER_MIN = 60;

/**
 * The per-login rate limit on the member bytes routes (own and team files).
 * Answers a 429 with Retry-After, or null to go on. Checked before any file
 * is opened.
 */
export function memberBytesGate(req: Request, member: MemberCaller): Response | null {
  const thumb = new URL(req.url).searchParams.get('thumb') === '1';
  const gate = thumb
    ? rateLimit(`member-thumbs:${member.loginId}`, {
        max: MEMBER_THUMBS_PER_MIN,
        windowMs: 60_000,
      })
    : rateLimit(`member-bytes:${member.loginId}`, { max: MEMBER_BYTES_PER_MIN, windowMs: 60_000 });
  if (gate.ok) return null;
  return NextResponse.json(
    { error: 'Too many requests. Try again shortly.', reason: 'rate-limit' },
    { status: 429, headers: { 'retry-after': String(gate.retryAfterSec) } },
  );
}
