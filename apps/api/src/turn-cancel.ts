/**
 * Turn-cancel listener — the runner half of "stop a stream mid-flight".
 *
 * A user hitting Stop in `apps/web` publishes a `turn_cancel` NOTIFY (the cancel
 * route → `publishTurnCancel`). This process (apps/api), where the turn actually
 * runs, LISTENs on that channel and aborts the matching turn's AbortController
 * (`abortTurn`), which the tool loop threaded into the streaming LLM call — so
 * generation halts upstream, keeping whatever partial reply already streamed.
 *
 * One dedicated single connection (a LISTEN monopolises its connection), mirroring
 * `apps/web/lib/realtime.ts`. Survives nothing fancy — if it can't start, turns
 * still run, they just can't be cancelled (the user's Stop becomes a no-op).
 */

import postgres from 'postgres';
import { abortTurn } from '@mantle/tracing';
import { TURN_CANCEL_CHANNEL, type TurnCancelEnvelope } from '@mantle/turn-stream';

let sql: ReturnType<typeof postgres> | null = null;

/** Start LISTENing for turn-cancel requests. Idempotent; returns once live. */
export async function startTurnCancelListener(): Promise<void> {
  if (sql) return;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');
  sql = postgres(url, { max: 1, prepare: false });
  await sql.listen(TURN_CANCEL_CHANNEL, (payload) => {
    try {
      const env = JSON.parse(payload) as TurnCancelEnvelope;
      if (env && env.ownerId && env.turnId) {
        const aborted = abortTurn(env.ownerId, env.turnId);
        if (aborted) console.log(`[api] turn ${env.turnId} cancelled by owner request`);
      }
    } catch {
      /* malformed payload — drop it rather than crash the listener */
    }
  });
}

/** Tear the listener down (shutdown path). */
export async function stopTurnCancelListener(): Promise<void> {
  if (!sql) return;
  try {
    await sql.end({ timeout: 5 });
  } catch {
    /* ignore */
  }
  sql = null;
}
