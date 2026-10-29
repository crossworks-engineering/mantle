import { memberCaller, memberLoginActive, sessionCookieExpiryMs } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { memberStreamLifetimeMs, takeMemberStream } from '@/lib/member-streams';
import { rateLimitedResponse } from '@/lib/route-limits';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', open: 'member' },
});

/**
 * GET /api/member/realtime : Server-Sent Events for a MEMBER, kept for an
 * older app that opens it: it opens, keeps alive and closes, and carries no
 * event (nothing raises a personal-item change: there are no personal
 * spaces).
 *
 * The login is checked again on every heartbeat (a deactivated member's
 * stream closes), a stream lives at most an hour, and one login holds at most
 * MEMBER_STREAMS_PER_LOGIN at once (429 beyond, lib/member-streams.ts).
 */
export async function GET(req: Request): Promise<Response> {
  const member = memberCaller();

  const maxLifetimeMs = memberStreamLifetimeMs(await sessionCookieExpiryMs());
  const release = takeMemberStream(member.loginId);
  // A cap on open streams, not a rate: the one 429 all the same.
  if (!release) return rateLimitedResponse(30);
  return sseResponse(req, {
    subscribe: async () => () => {},
    onPing: () => memberLoginActive(member.loginId),
    maxLifetimeMs,
    onClose: release,
  });
}
