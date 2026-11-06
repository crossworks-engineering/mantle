import { NextResponse } from '@/server/http-compat';
import { getBufferedTurnEvents, makeReplayMerger } from '@mantle/turn-stream';
import { chatCaller } from '@/lib/auth';
import { subscribeTurnStream } from '@/lib/realtime';
import { memberTurnLogin, turnOpenTo } from '@/lib/turn-access';
import { rateLimitedResponse } from '@/lib/route-limits';
import { loadProfilePreferences } from '@mantle/content';
import { feature } from '@mantle/config';
import type { RouteSwitches } from '@/lib/auth/route-switches';
import { CACHE_CONTROL } from '@/lib/cache-control';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', open: 'chat', limits: { rateLimit: ['chatTurnStream'] } },
});

/** The most streams of member turns one login holds open at once in this
 *  process (a member's opens are rate limited too: chatTurnStream). An
 *  Admin user's own turns are not counted. */
const MEMBER_OPEN_STREAMS_MAX = 4;
const openMemberStreams = new Map<string, number>();

/** Hold one open stream for `loginId`: the release, or null at the cap. */
function holdMemberStream(loginId: string): (() => void) | null {
  const n = openMemberStreams.get(loginId) ?? 0;
  if (n >= MEMBER_OPEN_STREAMS_MAX) return null;
  openMemberStreams.set(loginId, n + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (openMemberStreams.get(loginId) ?? 1) - 1;
    if (left <= 0) openMemberStreams.delete(loginId);
    else openMemberStreams.set(loginId, left);
  };
}

/**
 * GET /api/assistant/turn/[turnId]/stream — Server-Sent Events for ONE in-flight
 * turn: live status, tool activity, reasoning, and token deltas.
 * See `docs/live-turn-streaming.md`.
 *
 * **Bearer-authed from day one**, so it serves the same-origin web client AND
 * the detached companion / Electron. Open to every chat login (`open: 'chat'`),
 * each for its own turns only (lib/turn-access.ts turnOpenTo): a member's turn
 * id names its login (`ws-<loginId>.<key>`, minted by the turn route from the
 * session), so it is open to that login only, whatever its role; any other id
 * is an Admin user's turn, open to an Admin user as before. Anything else is a
 * 404 with no detail, as for a turn that does not exist. Owner isolation holds
 * as before: the per-(owner,turn) filter inside `subscribeTurnStream` (the
 * NOTIFY envelope's owner must match the session's brain).
 *
 * **Cross-process by necessity:** the turn executes in server/api (the DBOS
 * runner), which publishes deltas via Postgres `NOTIFY`; this handler (server/web,
 * a different process) LISTENs through the realtime bridge and relays them.
 *
 * **Flagged:** 404s until `MANTLE_TURN_STREAMING` is set. No producer is wired
 * yet, so the surface stays dark — zero behaviour change.
 *
 * Each frame is `id: <seq>` + `data: <TurnEvent JSON>`. The `id:` carries the
 * per-turn sequence: a reconnecting client sends `Last-Event-ID: <seq>` and we
 * replay what it missed from the `turn_stream_buffer` (NOTIFY itself has no
 * backlog) before live-tailing — gap-free and duplicate-free via the merger. The
 * durable message row stays the source of truth for the final answer regardless.
 */

/** Served under MANTLE_TURN_STREAMING: the gate answers 404 first while it
 *  is off (lib/auth/route-switches.ts). */
export const routeSwitches = { GET: 'turn-streaming' } as const satisfies RouteSwitches;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ turnId: string }> },
): Promise<Response> {
  // The owner the gate answered, before the stream opens, so a revoked or
  // expired bearer gets a clean 401 (not an HTML redirect) rather than an
  // empty event stream. The flag is the row's switch: while
  // MANTLE_TURN_STREAMING is off the gate answers 404 first, before the
  // caller, and the endpoint simply doesn't exist (`routeSwitches` above).
  const login = chatCaller();
  const ownerId = login.ownerId;

  // Per-brain gate: if this owner turned live thinking off in Settings → Profile,
  // the route 404s just like the env-off case. The client treats that as a clean
  // fallback (no reconnect loop) and shows the static thinking bubble instead.
  if (!feature('streamThoughts', { prefs: await loadProfilePreferences(ownerId) })) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const { turnId } = await ctx.params;
  if (!turnId) return NextResponse.json({ error: 'turnId required' }, { status: 400 });
  // Another login's turn: the same 404, before anything is subscribed.
  if (!(await turnOpenTo(turnId, login))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  // A member's turn: a few open at once per login, then the one 429.
  const release = memberTurnLogin(turnId) ? holdMemberStream(login.loginId) : () => {};
  if (!release) return rateLimitedResponse(5);

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    unsubscribe?.();
    unsubscribe = null;
    release();
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

      // Resume cursor: a reconnecting client sends `Last-Event-ID: <seq>` so we
      // replay only what it missed during the drop (NOTIFY has no backlog).
      // Absent/NaN → -1 → replay the whole buffer for this turn (seq starts at 0;
      // normally empty on the pre-POST subscribe, so this is a no-op there).
      const header = req.headers.get('last-event-id');
      const sinceSeq = header !== null && Number.isFinite(Number(header)) ? Number(header) : -1;

      // The merger guarantees NO gap (live events arriving during the backlog read
      // are queued, then drained) and NO duplicate (dedup by seq) — see
      // @mantle/turn-stream. `id:` = the resume cursor; `data:` = the event JSON.
      const merger = makeReplayMerger(sinceSeq, (event) => {
        enc(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      });

      // Subscribe to the live stream FIRST so an event landing in the async window
      // before the backlog is read is queued, not lost.
      unsubscribe = await subscribeTurnStream(ownerId, turnId, (event) => merger.live(event));

      // Then replay the backlog and flush the queued live events, going fully live.
      try {
        merger.replay(await getBufferedTurnEvents(ownerId, turnId, sinceSeq));
      } catch {
        // Replay is best-effort — switch the merger to live (drain the queue); the
        // live tail + the durable assistant_messages row still cover the answer.
        merger.replay([]);
      }

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
      'Cache-Control': CACHE_CONTROL.stream,
      Connection: 'keep-alive',
    },
  });
}
