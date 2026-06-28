import { lt, sql } from 'drizzle-orm';
import { db, turnStreamBuffer } from '@mantle/db';
import type { TurnEvent } from '@mantle/client-types';
import { TURN_STREAM_CHANNEL, TURN_CANCEL_CHANNEL } from './channel';

/**
 * Buffering is gated on the SAME master flag as the SSE route + the non-blocking
 * POST (`MANTLE_TURN_STREAMING`). It MUST be gated: `streamId`→`turnId` is set on
 * the trace unconditionally whenever a turn carries an idempotency-key (see
 * run-turn.ts), so `publishTurnEvent` already fires for status/lifecycle on every
 * web turn even when the feature is dark — and we don't want a dark feature
 * writing to the buffer table on every turn. The runner reads apps/web/.env.local,
 * so it sees the flag. (The `pg_notify` below stays unconditional — it's harmless
 * when no consumer is subscribed, and that's the pre-existing behaviour.)
 */
function isBufferingEnabled(): boolean {
  return !!process.env.MANTLE_TURN_STREAMING?.trim();
}

/** How long a turn's buffered events live before the lazy sweep reaps them — a
 *  Postgres interval literal (internal constant, never user input). Ample for a
 *  reconnecting client to resume; a completed turn's client reconciles to the
 *  durable `assistant_messages` row well within this window. */
const BUFFER_TTL_SQL = sql`now() - interval '15 minutes'`;

/**
 * Persist one event to the short-TTL replay buffer so a reconnecting subscriber
 * can resume via `Last-Event-ID` (NOTIFY has no backlog — see
 * `turn_stream_buffer`). Called BEFORE the `pg_notify` so a client that
 * subscribes then drains the backlog can't miss a committed event.
 *
 * **Best-effort; never throws** — a dropped buffer row is as cosmetic as a
 * dropped delta (the answer is journaled durably, entirely separately). On a
 * `turn-start` event (once per turn) it also lazily sweeps expired rows, so the
 * table stays small with no cron.
 *
 * `ON CONFLICT (turn_id, seq) DO NOTHING`: a DBOS-recovered turn re-runs its LLM
 * step and the in-memory seq cursor resets on runner restart, so a recovered turn
 * can re-emit seqs from 0 — keep the first row, the durable row is the real
 * source of truth either way.
 */
async function bufferTurnEvent(ownerId: string, event: TurnEvent): Promise<void> {
  if (!isBufferingEnabled()) return;
  try {
    await db
      .insert(turnStreamBuffer)
      // `event` column is typed loosely (no client-types dep in @mantle/db); a
      // TurnEvent (a tagged union, no index signature) needs the widening cast.
      .values({ turnId: event.turnId, seq: event.seq, ownerId, event: event as unknown as Record<string, unknown> })
      .onConflictDoNothing();
    if (event.type === 'turn-start') {
      await db.delete(turnStreamBuffer).where(lt(turnStreamBuffer.createdAt, BUFFER_TTL_SQL));
    }
  } catch (err) {
    console.warn(
      '[turn-stream] buffer write failed (replay degraded; the answer is durable):',
      err instanceof Error ? err.message : err,
    );
  }
}

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
  // Persist to the replay buffer FIRST (so a reconnecting subscriber that
  // subscribes then reads the backlog can't miss this event), then notify live.
  await bufferTurnEvent(ownerId, event);
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

/** The NOTIFY payload for a turn-cancel request. `ownerId` is the isolation key
 *  the runner re-checks before aborting (a turnId guessed from another owner
 *  won't match the registered controller's owner). */
export interface TurnCancelEnvelope {
  ownerId: string;
  turnId: string;
}

/**
 * Ask the runner (apps/api) to CANCEL an in-flight turn — published by the web
 * cancel route over `TURN_CANCEL_CHANNEL`. The runner LISTENs, looks up the
 * turn's `AbortController` and aborts it, halting LLM generation mid-stream and
 * keeping whatever partial reply has streamed so far.
 *
 * **Fire-and-forget; never throws.** A dropped cancel is recoverable — the user
 * can hit stop again, and the worst case is the turn finishes normally. So a
 * `NOTIFY` hiccup is logged and swallowed.
 */
export async function publishTurnCancel(ownerId: string, turnId: string): Promise<void> {
  try {
    const payload = JSON.stringify({ ownerId, turnId } satisfies TurnCancelEnvelope);
    await db.execute(sql`SELECT pg_notify(${TURN_CANCEL_CHANNEL}, ${payload})`);
  } catch (err) {
    console.warn(
      '[turn-stream] cancel pg_notify failed:',
      err instanceof Error ? err.message : err,
    );
  }
}
