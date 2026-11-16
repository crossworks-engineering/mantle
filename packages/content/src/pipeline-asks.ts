/**
 * The day cap of the Agents' paid asks (docs/pipelines.md, "Agents"): one
 * number for the box, and the count it is held against. The count has ONE
 * source, the trace: each paid ask is one step with `meta.use` =
 * PIPELINE_ASK_USE (server/api/src/agent/extract/pipeline-ask.ts). There is
 * no second counter, and no table.
 *
 * Two runs at the same time can pass the cap by the asks in flight (a step
 * is written when its call ends): at most a few asks, accepted.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
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
