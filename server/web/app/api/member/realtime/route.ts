import { NextResponse } from '@/server/http-compat';
import { memberCaller, memberLoginActive, sessionCookieExpiryMs } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { memberStreamLifetimeMs, takeMemberStream } from '@/lib/member-streams';

/**
 * GET /api/member/realtime : Server-Sent Events for a MEMBER (member logins
 * Phase 2). It carried one event per personal-item change; personal spaces
 * folded into the brain in workspaces W6b, and nothing has raised such a
 * change since, so the feed went in W8d. The stream stays for an older app
 * that opens it: it opens, keeps alive and closes as before, and carries no
 * event.
 *
 * The login is checked again on every heartbeat (a deactivated member's
 * stream closes), a stream lives at most an hour, and one login holds at most
 * MEMBER_STREAMS_PER_LOGIN at once (429 beyond, lib/member-streams.ts).
 */
export async function GET(req: Request): Promise<Response> {
  const member = memberCaller();

  const maxLifetimeMs = memberStreamLifetimeMs(await sessionCookieExpiryMs());
  const release = takeMemberStream(member.loginId);
  if (!release) {
    return NextResponse.json(
      { error: 'Too many open live connections.', reason: 'rate-limit' },
      { status: 429, headers: { 'retry-after': '30' } },
    );
  }
  return sseResponse(req, {
    subscribe: async () => () => {},
    onPing: () => memberLoginActive(member.loginId),
    maxLifetimeMs,
    onClose: release,
  });
}
