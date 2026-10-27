import { anyLoginCaller, sessionCookieExpiryMs } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { memberStreamLifetimeMs, takeMemberStream } from '@/lib/member-streams';
import { rateLimitedResponse } from '@/lib/route-limits';
import { subscribeMessenger } from '@/lib/realtime';
import { messengerLoginUsable, touchLoginPresence } from '@/lib/messenger';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { MessengerStreamEvent } from '@mantle/client-types/dto/messenger';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any' },
});

/**
 * GET /api/messenger/stream: Server-Sent Events of the messenger (plan
 * section 7) for any login, an Admin user's too. Each event is ids and a
 * seq, never text: the client fetches after_seq. Only the conversations the
 * login is a participant of reach it (lib/realtime.ts, the fan-out map).
 *
 * The guards of /api/member/realtime: the login is checked again on every
 * heartbeat (a disabled login's stream closes), a stream lives at most an
 * hour, and one login holds at most MEMBER_STREAMS_PER_LOGIN messenger
 * streams at once (429 beyond), apart from its member streams. The heartbeat also marks the login active ("online").
 */
export async function GET(req: Request): Promise<Response> {
  const login = anyLoginCaller();
  const maxLifetimeMs = memberStreamLifetimeMs(await sessionCookieExpiryMs());
  const release = takeMemberStream(login.loginId, 'messenger');
  if (!release) return rateLimitedResponse(30);
  void touchLoginPresence(login.loginId).catch(() => {});
  return sseResponse(req, {
    subscribe: async (send) =>
      subscribeMessenger(login.loginId, (c) => {
        const event = toEvent(c);
        if (event) send(event);
      }),
    onPing: async () => {
      const ok = await messengerLoginUsable(login.loginId);
      if (ok) void touchLoginPresence(login.loginId).catch(() => {});
      return ok;
    },
    maxLifetimeMs,
    onClose: release,
  });
}

/** A NOTIFY payload as a stream event (the DTO's shape). 'self' (my clear
 *  or mute, from another tab) refetches like a room event. */
function toEvent(c: {
  c: string;
  seq: number | null;
  kind: string;
  actor: string | null;
}): MessengerStreamEvent | null {
  switch (c.kind) {
    case 'new':
    case 'edit':
    case 'delete':
      return c.seq === null ? null : { type: 'message', c: c.c, seq: c.seq, kind: c.kind };
    case 'read':
      return c.seq === null || !c.actor
        ? null
        : { type: 'read', c: c.c, seq: c.seq, loginId: c.actor };
    case 'reaction':
      return c.seq === null ? null : { type: 'reaction', c: c.c, seq: c.seq };
    case 'typing':
      return c.actor ? { type: 'typing', c: c.c, loginId: c.actor } : null;
    case 'history':
      return { type: 'history', c: c.c };
    case 'participants':
    case 'self':
      return { type: 'participants', c: c.c };
    default:
      return null;
  }
}
