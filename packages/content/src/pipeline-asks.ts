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

/** The paid asks of this box in the last 24 hours. */
export async function pipelineAsksToday(ownerId: string, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(traceSteps)
    .innerJoin(traces, eq(traceSteps.traceId, traces.id))
    .where(
      and(
        eq(traces.ownerId, ownerId),
        gte(traceSteps.startedAt, since),
        sql`${traceSteps.meta}->>'use' = ${PIPELINE_ASK_USE}`,
      ),
    );
  return row?.n ?? 0;
}
