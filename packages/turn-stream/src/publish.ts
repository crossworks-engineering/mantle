import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';
import type { TurnEvent } from '@mantle/client-types';
import { TURN_STREAM_CHANNEL } from './channel';

/**
 * Server-internal NOTIFY envelope. The `ownerId` is the cross-tenant isolation
 * key the web SSE bridge filters on — it is NEVER forwarded to the browser
 * (the client only ever sees the bare `TurnEvent`). A user can't receive
 * another owner's deltas even by guessing a `turnId`, because the envelope's
 * `ownerId` won't match their authenticated session.
 */
export interface TurnStreamEnvelope {
  ownerId: string;
  event: TurnEvent;
}

/**
 * Publish one live turn event to subscribers (the apps/web SSE bridge) via
 * Postgres `NOTIFY` — the only channel that crosses the apps/api → apps/web
 * process boundary. Mirrors the established `notifyPendingChanged` /
 * `notifyHeartbeatDue` pattern.
 *
 * **Fire-and-forget; never throws.** A dropped delta is purely cosmetic — the
 * authoritative answer is journaled durably by DBOS, entirely separately from
 * this stream (see `docs/live-turn-streaming.md` §0). So a `NOTIFY` hiccup is
 * logged and swallowed; it must never break the turn that emitted it.
 *
 * **Payload size:** Postgres caps a `NOTIFY` payload at ~8 KB. Individual deltas
 * are tiny by design; a producer must NEVER batch a large blob into one event —
 * long output streams as many small `text-delta`s.
 */
export async function publishTurnEvent(ownerId: string, event: TurnEvent): Promise<void> {
  try {
    // Channel is a string literal; payload is parameterised — injection-safe.
    const payload = JSON.stringify({ ownerId, event } satisfies TurnStreamEnvelope);
    await db.execute(sql`SELECT pg_notify(${TURN_STREAM_CHANNEL}, ${payload})`);
  } catch (err) {
    console.warn(
      '[turn-stream] pg_notify failed (delta dropped; the answer is durable):',
      err instanceof Error ? err.message : err,
    );
  }
}
