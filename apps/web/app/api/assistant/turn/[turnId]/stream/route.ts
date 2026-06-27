import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { subscribeTurnStream } from '@/lib/realtime';
import { isTurnStreamingEnabled } from '@/lib/turn-streaming';

/**
 * GET /api/assistant/turn/[turnId]/stream — Server-Sent Events for ONE in-flight
 * turn: live status, tool activity, reasoning, and (Phase 3) token deltas.
 * See `docs/live-turn-streaming.md`.
 *
 * **Bearer-authed from day one** (`getOwnerOr401`), so it serves the same-origin
 * web client AND the detached companion / Electron — unlike the legacy
 * same-origin-only assistant turn POST. Owner isolation is enforced twice: the
 * session gate here, and the per-(owner,turn) filter inside `subscribeTurnStream`
 * (the NOTIFY envelope's owner must match the authenticated session, so a
 * `turnId` guessed from another owner yields nothing).
 *
 * **Cross-process by necessity:** the turn executes in apps/api (the DBOS
 * runner), which publishes deltas via Postgres `NOTIFY`; this handler (apps/web,
 * a different process) LISTENs through the realtime bridge and relays them.
 *
 * **Flagged:** 404s until `MANTLE_TURN_STREAMING` is set. No producer is wired
 * yet, so the surface stays dark — zero behaviour change.
 *
 * Each frame is `id: <seq>` + `data: <TurnEvent JSON>`. The `id:` carries the
 * per-turn sequence for a future `Last-Event-ID` resume; today the bridge has no
 * backlog, so reconnect is best-effort and the durable message row remains the
 * source of truth for the final answer.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ turnId: string }> },
): Promise<Response> {
  // Flag gate first: while off, the endpoint simply doesn't exist.
  if (!isTurnStreamingEnabled()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // Owner-gate before opening the stream so a revoked/expired bearer gets a
  // clean 401 (not an HTML redirect) rather than an empty event stream.
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;

  const { turnId } = await ctx.params;
  if (!turnId) return NextResponse.json({ error: 'turnId required' }, { status: 400 });

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
      // Open immediately so the client's reader fires `open`.
      enc(': connected\n\n');
      unsubscribe = await subscribeTurnStream(owner.id, turnId, (event) => {
        // `id:` = the per-turn resume cursor; `data:` = the event JSON.
        enc(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      // Keep-alive comment so idle connections aren't reaped by proxies/cellular.
      heartbeat = setInterval(() => enc(': ping\n\n'), 25_000);
    },
    cancel() {
      cleanup();
    },
  });

  // Belt-and-suspenders: also unsubscribe when the request aborts (client
  // backgrounded / navigated / killed the stream), in case cancel() doesn't fire.
  req.signal.addEventListener('abort', cleanup);

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
    },
  });
}
