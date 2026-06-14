import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { subscribeConversations, type ConversationChange } from '@/lib/realtime';

/**
 * Server-Sent Events stream of live conversation turns for the current owner —
 * the mobile companion's live chat. Backed by the Postgres `conversation_changed`
 * LISTEN bridge (lib/realtime), which fires on every assistant_messages insert
 * regardless of channel (web / Telegram / heartbeat / future).
 *
 * Each event is `data: {agentSlug, direction}` — the client refetches that
 * agent's thread (and the inbox) on receipt, the same "ping-to-refetch" model
 * as /api/realtime. `direction` lets the client skip a refetch for its own
 * just-sent inbound echo. Owner isolation is enforced here; another owner's
 * turn is never emitted.
 *
 * Owner-gated with getOwnerOr401 so a revoked/expired bearer gets a clean 401
 * (not an HTML redirect) before the stream opens.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;

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
      // Open immediately so the client's stream fires `open`.
      enc(': connected\n\n');
      unsubscribe = await subscribeConversations((c: ConversationChange) => {
        if (c.ownerId !== owner.id) return;
        enc(`data: ${JSON.stringify({ agentSlug: c.agentSlug, direction: c.direction })}\n\n`);
      });
      // Keep-alive comment so idle connections aren't reaped by proxies.
      heartbeat = setInterval(() => enc(': ping\n\n'), 25_000);
    },
    cancel() {
      cleanup();
    },
  });

  // Belt-and-suspenders: also unsubscribe when the request aborts (client
  // backgrounded / killed the stream), in case cancel() doesn't fire.
  req.signal.addEventListener('abort', cleanup);

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
    },
  });
}
