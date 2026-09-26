import { getMemberOr401 } from '@/lib/auth';
import { subscribeSpaceItems } from '@/lib/realtime';
import type { SpaceItemChange } from '@mantle/content';

/**
 * GET /api/member/realtime : Server-Sent Events for a MEMBER (member logins
 * Phase 2). One event per personal-item change the member may care about:
 * items in their own space, and items that are (or just were) shared with the
 * team. Each event is `{ type: 'space_item', id, kind, own }` (kind: created,
 * saved, state, deleted, comment); the client reloads what it shows. Ids and
 * flags only: no title, no content, so an event never says more than the
 * lists the member can already read.
 */
export async function GET(req: Request): Promise<Response> {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    unsubscribe?.();
    unsubscribe = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          /* stream already closed */
        }
      };
      enc(': connected\n\n');
      unsubscribe = await subscribeSpaceItems((c: SpaceItemChange) => {
        const own = c.spaceId === member.spaceId;
        if (!own && !c.team) return;
        enc(`data: ${JSON.stringify({ type: 'space_item', id: c.id, kind: c.kind, own })}\n\n`);
      });
      heartbeat = setInterval(() => enc(': ping\n\n'), 25_000);
    },
    cancel() {
      cleanup();
    },
  });

  req.signal.addEventListener('abort', cleanup);

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
    },
  });
}
