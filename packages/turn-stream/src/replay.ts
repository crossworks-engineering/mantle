import { and, asc, eq, gt } from 'drizzle-orm';
import { db, turnStreamBuffer } from '@mantle/db';
import type { TurnEvent } from '@mantle/client-types';

/**
 * Read a turn's buffered events for `Last-Event-ID` replay — everything with
 * `seq > sinceSeq`, in order. The SSE route calls this on connect to fill the gap
 * a dropped/backgrounded subscriber missed (NOTIFY has no backlog). Pass
 * `sinceSeq = -1` for a fresh connect to replay the whole turn (seq starts at 0);
 * `sinceSeq = N` to resume after `Last-Event-ID: N`.
 *
 * Owner-filtered as defence-in-depth: the route already owner-gated, but a
 * `turnId` guessed from another owner still yields nothing here. The natural key
 * `(turn_id, seq)` makes this a range scan. The buffer is gated on
 * `MANTLE_TURN_STREAMING`, so when the feature is dark this returns `[]` (nothing
 * was ever written) — the route then simply live-tails as before.
 */
export async function getBufferedTurnEvents(
  ownerId: string,
  turnId: string,
  sinceSeq: number,
): Promise<TurnEvent[]> {
  const rows = await db
    .select({ event: turnStreamBuffer.event })
    .from(turnStreamBuffer)
    .where(
      and(
        eq(turnStreamBuffer.turnId, turnId),
        eq(turnStreamBuffer.ownerId, ownerId),
        gt(turnStreamBuffer.seq, sinceSeq),
      ),
    )
    .orderBy(asc(turnStreamBuffer.seq));
  // The column is typed loosely (`@mantle/db` carries no client-types dep); the
  // value is always a full TurnEvent the producer wrote (widening cast back).
  return rows.map((r) => r.event as unknown as TurnEvent);
}

/** Merges a replayed backlog with the live NOTIFY stream for one connection,
 *  deduped + ordered by `seq`. See {@link makeReplayMerger}. */
export interface ReplayMerger {
  /** Feed a LIVE event (from the NOTIFY subscription). Queued while the backlog is
   *  still being read, then emitted directly once `replay()` has run. */
  live(event: TurnEvent): void;
  /** Emit the buffered backlog (pre-filtered to `seq > sinceSeq`, ordered), then
   *  flush any live events that arrived during the async read and switch to live.
   *  Call exactly once, after subscribing. */
  replay(backlog: TurnEvent[]): void;
}

/**
 * The subscribe-first / drain-backlog / dedup-by-seq state machine the SSE route
 * uses so a reconnecting client neither MISSES nor DUPLICATES an event:
 *
 * - **No gap:** the route subscribes to the live NOTIFY stream BEFORE reading the
 *   backlog and feeds those live events through `live()`; they're queued until
 *   `replay()` flushes the backlog, so an event landing in the async window
 *   between "subscribed" and "backlog read" is preserved, not dropped.
 * - **No duplicate:** every event passes a single `seq` guard — an event whose
 *   `seq` is not strictly greater than the highest already emitted is skipped.
 *   This makes the backlog/live overlap safe AND makes a re-sent `Last-Event-ID`
 *   idempotent.
 *
 * Pure and synchronous (no DB/HTTP) so it's unit-tested deterministically.
 * `sinceSeq` seeds the guard: `-1` (fresh connect) emits from seq 0; `N` resumes
 * strictly after `N`.
 */
export function makeReplayMerger(sinceSeq: number, emit: (event: TurnEvent) => void): ReplayMerger {
  let maxSeq = sinceSeq;
  // While non-null we're still replaying: live events are queued. Null once live.
  let queued: TurnEvent[] | null = [];

  const push = (event: TurnEvent): void => {
    if (event.seq <= maxSeq) return; // already emitted — dedup
    maxSeq = event.seq;
    emit(event);
  };

  return {
    live(event) {
      if (queued) queued.push(event);
      else push(event);
    },
    replay(backlog) {
      for (const event of backlog) push(event);
      const drain = queued ?? [];
      queued = null; // go live: subsequent live() calls emit directly
      for (const event of drain) push(event);
    },
  };
}
