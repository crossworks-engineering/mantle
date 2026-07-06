/**
 * GET /api/team/turn/[turnId]/stream — SSE for ONE in-flight TEAM turn: live
 * status + token deltas, replay-merged from turn_stream_buffer on reconnect.
 * Mirror of /api/assistant/turn/[turnId]/stream with the team gate instead of
 * the owner gate.
 *
 * Members see FULL status labels (same narration the owner sees) — a
 * deliberate transparency decision (plan §15.5), which also means no filtering
 * layer here.
 *
 * Isolation: only `team-<uuid>` turn ids are served (owner turns use bare
 * uuids, so a member can never tail one), and the per-(owner, turn) filter in
 * subscribeTurnStream scopes events to this brain.
 */
import { NextResponse } from 'next/server';
import { getBufferedTurnEvents, makeReplayMerger } from '@mantle/turn-stream';
import { subscribeTurnStream } from '@/lib/realtime';
import { isTurnStreamingEnabled } from '@/lib/turn-streaming';
import { resolveTeamChatCaller, contactOfTeamTurnId } from '@/lib/team-chat-gate';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ turnId: string }> },
): Promise<Response> {
  if (!isTurnStreamingEnabled()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const caller = await resolveTeamChatCaller(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Cross-member isolation: the turn id embeds the contact it belongs to
  // (minted server-side in the turn route). A member may only tail their OWN
  // turns — even a leaked id for another member's turn is rejected here, not
  // just filtered downstream. Owner turn ids (bare uuids) fail the prefix
  // check, so a member can never tail an owner turn either.
  const { turnId } = await ctx.params;
  if (!turnId || contactOfTeamTurnId(turnId) !== caller.contactId) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

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

      const header = req.headers.get('last-event-id');
      const sinceSeq = header !== null && Number.isFinite(Number(header)) ? Number(header) : -1;

      const merger = makeReplayMerger(sinceSeq, (event) => {
        enc(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      });

      unsubscribe = await subscribeTurnStream(caller.ownerId, turnId, (event) => merger.live(event));

      try {
        merger.replay(await getBufferedTurnEvents(caller.ownerId, turnId, sinceSeq));
      } catch {
        merger.replay([]);
      }

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
