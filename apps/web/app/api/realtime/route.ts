import { getOwnerOr401 } from '@/lib/auth';
import { subscribeRealtime, type RealtimeChange } from '@/lib/realtime';

/**
 * Server-Sent Events stream of live node changes for the current owner. Backed
 * by the Postgres `node_ingested` LISTEN bridge (lib/realtime). Clients open it
 * with EventSource via the useRealtime() hook and refresh on a matching change.
 *
 * `?types=event,note` filters to those node types; omit for all. Owner
 * isolation is enforced here — a change for another owner is never emitted.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const typesParam = new URL(req.url).searchParams.get('types');
  const types = typesParam
    ? new Set(typesParam.split(',').map((s) => s.trim()).filter(Boolean))
    : null;

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
      // Open the stream immediately so EventSource fires `open`.
      enc(': connected\n\n');
      unsubscribe = await subscribeRealtime((change: RealtimeChange) => {
        if (change.ownerId !== user.id) return;
        if (types && !types.has(change.type)) return;
        enc(`data: ${JSON.stringify({ type: change.type, id: change.id })}\n\n`);
      });
      // Keep-alive comment so idle connections aren't reaped by proxies.
      heartbeat = setInterval(() => enc(': ping\n\n'), 25_000);
    },
    cancel() {
      cleanup();
    },
  });

  // Client navigated away / closed the tab.
  req.signal.addEventListener('abort', cleanup);

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
    },
  });
}
