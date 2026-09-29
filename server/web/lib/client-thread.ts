/**
 * The HTTP side of the client thread on a client-level item (client logins
 * C5, decision 8): the comment body, the author's name as clients read it,
 * and the per-login rate limit on writes. The client routes
 * (/api/client/shared/:id/comments) and the member routes
 * (/api/member/library/:id/comments) are twins, never shared.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import type { ClientCaller } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';

/** A comment body: bounded, some text after trimming. */
export const ThreadCommentBody = z.object({ body: z.string().trim().min(1).max(10_000) });
export const ThreadParams = z.object({ id: z.string().uuid() });
export const ThreadCommentParams = z.object({
  id: z.string().uuid(),
  commentId: z.string().uuid(),
});

/** A client login's name on the thread: its display name, else "A client"
 *  (never the email: every client login and the team read it). */
export function clientThreadAuthor(client: ClientCaller): {
  kind: 'client';
  loginId: string;
  name: string;
} {
  return {
    kind: 'client',
    loginId: client.loginId,
    name: client.displayName?.trim() || 'A client',
  };
}

/** Comments a client login may write (and delete) on client threads, per
 *  minute. Each costs a row and no model work; this bounds a runaway tab. */
export const CLIENT_THREAD_WRITES_PER_MIN = 20;

/** The per-login rate limit on the client's comment writes: a 429 with
 *  Retry-After, or null to go on. Checked before the body is read. */
export function clientThreadWriteGate(client: ClientCaller): Response | null {
  const gate = rateLimit(`client-thread-writes:${client.loginId}`, {
    max: CLIENT_THREAD_WRITES_PER_MIN,
    windowMs: 60_000,
  });
  if (gate.ok) return null;
  return NextResponse.json(
    { error: 'Too many comments at once. Wait a moment, then try again.', reason: 'rate-limit' },
    { status: 429, headers: { 'retry-after': String(gate.retryAfterSec) } },
  );
}
