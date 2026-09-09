/**
 * Reap assistant turns stuck in 'pending' — the surface that had no sweeper at
 * all until 2026-09-09.
 *
 * An outbound row is written 'pending' the moment a turn starts and is settled
 * only by `finalize_outbound` / `fail_outbound` at the end. If the runner never
 * reaches either — a provider call that neither returns nor throws, or a
 * process killed mid-turn — the row sits 'pending' forever. Nothing logged it,
 * nothing counted it, and the only visible symptom was a composer stuck on
 * "Thinking…". That is how a stalled OpenRouter call went unnoticed for an hour,
 * twice in one morning, before anyone could say what had happened. The adapter
 * bug that caused it is fixed; this is the backstop for the next one.
 *
 * Shared by the cron sweep (sweeps.ts) and `pnpm turns:reap`, so there is one
 * definition of the rule.
 */
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { db, agents, assistantMessages } from '@mantle/db';
import { env } from '@mantle/config';

/** Minutes before an unsettled turn is treated as abandoned. Well clear of a
 *  legitimately long tool-loop turn and of every guard the chat adapters apply
 *  (60s connect, 120s idle, 90s SDK retry envelope). */
export function staleAfterMin(): number {
  return Number(env('MANTLE_TURN_STALE_MIN')) || 30;
}

export type StaleTurn = {
  id: string;
  createdAt: Date;
  model: string | null;
  agent: string | null;
};

function cutoff(): Date {
  return new Date(Date.now() - staleAfterMin() * 60_000);
}

function stalePredicate() {
  return and(
    eq(assistantMessages.direction, 'outbound'),
    eq(assistantMessages.status, 'pending'),
    lt(assistantMessages.createdAt, cutoff()),
  );
}

/** Read-only: which turns the sweep WOULD fail. Drives the script's dry run. */
export async function findStalePendingTurns(): Promise<StaleTurn[]> {
  return db
    .select({
      id: assistantMessages.id,
      createdAt: assistantMessages.createdAt,
      model: assistantMessages.model,
      agent: agents.slug,
    })
    .from(assistantMessages)
    .leftJoin(agents, eq(agents.id, assistantMessages.agentId))
    .where(stalePredicate())
    .orderBy(asc(assistantMessages.createdAt));
}

/** Flip stale 'pending' turns to 'failed'. Idempotent; a no-op once clean. */
export async function reapStalePendingTurns(): Promise<number> {
  const mins = staleAfterMin();
  const rows = await db
    .update(assistantMessages)
    .set({
      status: 'failed',
      error: sql`coalesce(${assistantMessages.error}, ${
        `abandoned — the turn never settled after ${mins} min ` +
        `(the model call neither returned nor threw, or the runner died mid-turn; swept by maintenance)`
      })`,
    })
    .where(stalePredicate())
    .returning({ id: assistantMessages.id });
  return rows.length;
}

/** One line for the maintenance run row. */
export function summariseTurnsReap(reaped: number): string {
  return reaped === 0 ? 'no stuck turns' : `failed ${reaped} stuck turn(s)`;
}
