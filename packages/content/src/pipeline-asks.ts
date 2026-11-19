/**
 * The day cap of the Agents' paid asks (docs/pipelines.md, "Agents"): one
 * number for the box, and the count it is held against. The count has ONE
 * source, the trace: each paid ask is one step with `meta.use` =
 * PIPELINE_ASK_USE (server/api/src/agent/extract/pipeline-ask.ts). There is
 * no second counter, and no table.
 *
 * The cap paces, it never drops (owner decision 2026-11-19: the provider is
 * the cap, no new limits): a run that reaches it is sent again once the
 * window has room (pipelineAsksFreeAt), and asks then only what its tab
 * does not hold. To take the cap away: delete the two `day_cap` checks of
 * pipeline-ask.ts and this file's cap reader, and the env number
 * MANTLE_PIPELINE_ASKS_PER_DAY (docs/pipelines.md, "The day cap").
 *
 * Two runs at the same time can pass the cap by the asks in flight (a step
 * is written when its call ends): at most a few asks, accepted.
 */
import { and, asc, eq, gte, sql } from 'drizzle-orm';
import { envNum } from '@mantle/config';
import { db, traceSteps, traces } from '@mantle/db';

/** The `meta.use` of the trace step of one paid ask. */
export const PIPELINE_ASK_USE = 'pipeline_ask';

/** The most paid asks of all Agents of this box in 24 hours: the operator's
 *  `MANTLE_PIPELINE_ASKS_PER_DAY`. 0: no Agent may ask. */
export function pipelineAsksDayCap(): number {
  return envNum('MANTLE_PIPELINE_ASKS_PER_DAY');
}

/** The paid asks of this box in the last 24 hours. The paid ask is only
 *  ever made inside a `pipeline_run` trace (the run job,
 *  server/api/src/agent/extract/pipeline-run.ts), so the count looks at those
 *  traces only, by the index `traces_owner_kind_started_idx`. A run's trace
 *  starts before its steps, and a run job lasts minutes: one hour more on
 *  the trace's start holds every step of the last 24 hours. */
export async function pipelineAsksToday(ownerId: string, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const tracesSince = new Date(since.getTime() - 60 * 60 * 1000);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(traceSteps)
    .innerJoin(traces, eq(traceSteps.traceId, traces.id))
    .where(
      and(
        eq(traces.ownerId, ownerId),
        eq(traces.kind, 'pipeline_run'),
        gte(traces.startedAt, tracesSince),
        gte(traceSteps.startedAt, since),
        sql`${traceSteps.meta}->>'use' = ${PIPELINE_ASK_USE}`,
      ),
    );
  return row?.n ?? 0;
}

/** The window of the count. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When the day cap has room again: `now` when it has room now, else the
 * moment the oldest ask that keeps it full leaves the 24-hour window (the
 * (count - cap + 1)th oldest of the window, plus 24 hours). Null when the cap
 * is 0 (the operator's "no Agent may ask": nothing is deferred to). One read
 * of the same steps as pipelineAsksToday.
 */
export async function pipelineAsksFreeAt(
  ownerId: string,
  cap: number,
  now = new Date(),
): Promise<Date | null> {
  if (!(cap > 0)) return null;
  const count = await pipelineAsksToday(ownerId, now);
  if (count < cap) return now;
  const since = new Date(now.getTime() - DAY_MS);
  const tracesSince = new Date(since.getTime() - 60 * 60 * 1000);
  const [row] = await db
    .select({ at: traceSteps.startedAt })
    .from(traceSteps)
    .innerJoin(traces, eq(traceSteps.traceId, traces.id))
    .where(
      and(
        eq(traces.ownerId, ownerId),
        eq(traces.kind, 'pipeline_run'),
        gte(traces.startedAt, tracesSince),
        gte(traceSteps.startedAt, since),
        sql`${traceSteps.meta}->>'use' = ${PIPELINE_ASK_USE}`,
      ),
    )
    .orderBy(asc(traceSteps.startedAt))
    .offset(count - cap)
    .limit(1);
  const at = row?.at ? new Date(row.at) : null;
  // No row (the window moved between the two reads): it has room now.
  return at ? new Date(Math.max(now.getTime(), at.getTime() + DAY_MS)) : now;
}
