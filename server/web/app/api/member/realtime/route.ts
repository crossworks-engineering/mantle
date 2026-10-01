import { NextResponse } from '@/server/http-compat';
import { getMemberOr401, memberLoginActive, sessionCookieExpiryMs } from '@/lib/auth';
import { subscribeSpaceItems } from '@/lib/realtime';
import { sseResponse } from '@/lib/sse';
import { memberStreamLifetimeMs, takeMemberStream } from '@/lib/member-streams';
import type { SpaceItemChange } from '@mantle/content';

/**
 * GET /api/member/realtime : Server-Sent Events for a MEMBER (member logins
 * Phase 2). One event per personal-item change the member may care about:
 * items in their own space, and items that are (or just were) shared with the
 * team. Each event is `{ type: 'space_item', id, kind, own }` (kind: created,
 * saved, state, deleted, comment); the client reloads what it shows. Ids and
 * flags only: no title, no content, so an event never says more than the
 * lists the member can already read.
 *
 * The login is checked again on every heartbeat (a deactivated member's
 * stream closes), a stream lives at most an hour, and one login holds at most
 * MEMBER_STREAMS_PER_LOGIN at once (429 beyond, lib/member-streams.ts).
 */
export async function GET(req: Request): Promise<Response> {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;

  const maxLifetimeMs = memberStreamLifetimeMs(await sessionCookieExpiryMs());
  const release = takeMemberStream(member.loginId);
  if (!release) {
    return NextResponse.json(
      { error: 'Too many open live connections.', reason: 'rate-limit' },
      { status: 429, headers: { 'retry-after': '30' } },
    );
  }
  return sseResponse(req, {
    subscribe: (send) =>
      subscribeSpaceItems((c: SpaceItemChange) => {
        const own = c.spaceId === member.spaceId;
        if (!own && !c.team) return;
        send({ type: 'space_item', id: c.id, kind: c.kind, own });
      }),
    onPing: () => memberLoginActive(member.loginId),
    maxLifetimeMs,
    onClose: release,
  });
}
