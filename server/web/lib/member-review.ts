/**
 * The HTTP side of member review (member logins Phase 4, plan v3.1 section
 * 6). Owner routes under /api/team-admin/submissions; the rules (what an
 * admin may see of a space, the bundle, Accept, Return, Discard) live in
 * @mantle/content member-review.ts.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ReviewError, toNodeCommentDto } from '@mantle/content';
import type { NodeCommentDbRow } from '@mantle/db';
import type { SessionUser } from '@/lib/auth';

export const SubmissionParams = z.object({ id: z.string().uuid() });

/** A refused review action as the status the client can act on: 404 for an
 *  item the admin may not see (a private item looks like a missing one), 400
 *  for bad input, 409 for a state conflict (recalled, not submitted). */
export function reviewErrorResponse(err: unknown): Response {
  if (err instanceof ReviewError) {
    const status = err.reason === 'not-found' ? 404 : err.reason === 'invalid' ? 400 : 409;
    return NextResponse.json({ error: err.message, reason: err.reason }, { status });
  }
  throw err;
}

export const reviewNotFound = () => NextResponse.json({ error: 'Not found.' }, { status: 404 });

/** The reviewing admin, for attribution. From the session, never the body. */
export function reviewer(user: SessionUser): { loginId: string; name: string } {
  const name = user.actor.displayName?.trim() || user.actor.email.split('@')[0] || 'Admin';
  return { loginId: user.actor.id, name };
}

export function commentsDto(rows: NodeCommentDbRow[], user: SessionUser) {
  return rows.map((r) => toNodeCommentDto(r, { loginId: user.actor.id }));
}
