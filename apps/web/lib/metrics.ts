import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { agents, db, traceSteps, traces } from '@mantle/db';

/**
 * Aggregate metrics computed over the traces + trace_steps tables.
 * All owner-scoped. Used by the /debug dashboard widgets.
 */

export type Traffic = {
  count: number;
  errorCount: number;
  avgMs: number | null;
  costMicroUsd: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
};

export async function trafficWindow(userId: string, hoursBack: number): Promise<Traffic> {
  const since = new Date(Date.now() - hoursBack * 3600_000);
  const rows = await db
    .select({
      count: sql<number>`count(*)::int`,
      errorCount: sql<number>`count(*) filter (where ${traces.status} = 'error')::int`,
      avgMs: sql<number | null>`avg(${traces.durationMs})::int`,
      costMicroUsd: sql<number>`coalesce(sum(${traces.costMicroUsd}), 0)::bigint`,
      tokensIn: sql<number>`coalesce(sum(${traces.tokensIn}), 0)::int`,
      tokensOut: sql<number>`coalesce(sum(${traces.tokensOut}), 0)::int`,
      tokensCacheRead: sql<number>`coalesce(sum(${traces.tokensCacheRead}), 0)::int`,
    })
    .from(traces)
    .where(and(eq(traces.ownerId, userId), gte(traces.startedAt, since)));
  const r = rows[0];
  return {
    count: r?.count ?? 0,
    errorCount: r?.errorCount ?? 0,
    avgMs: r?.avgMs ?? null,
    costMicroUsd: Number(r?.costMicroUsd ?? 0),
    tokensIn: r?.tokensIn ?? 0,
    tokensOut: r?.tokensOut ?? 0,
    tokensCacheRead: r?.tokensCacheRead ?? 0,
  };
}

export type AgentSpend = {
  agentId: string | null;
  agentName: string | null;
  agentSlug: string | null;
  costMicroUsd: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  runs: number;
};

export async function spendByAgent(userId: string, daysBack: number): Promise<AgentSpend[]> {
  const since = new Date(Date.now() - daysBack * 86_400_000);
  const rows = await db
    .select({
      agentId: traces.agentId,
      agentName: agents.name,
      agentSlug: agents.slug,
      costMicroUsd: sql<number>`coalesce(sum(${traces.costMicroUsd}), 0)::bigint`,
      tokensIn: sql<number>`coalesce(sum(${traces.tokensIn}), 0)::int`,
      tokensOut: sql<number>`coalesce(sum(${traces.tokensOut}), 0)::int`,
      cacheReadTokens: sql<number>`coalesce(sum(${traces.tokensCacheRead}), 0)::int`,
      runs: sql<number>`count(*)::int`,
    })
    .from(traces)
    .leftJoin(agents, eq(traces.agentId, agents.id))
    .where(and(eq(traces.ownerId, userId), gte(traces.startedAt, since)))
    .groupBy(traces.agentId, agents.name, agents.slug)
    .orderBy(desc(sql`coalesce(sum(${traces.costMicroUsd}), 0)`));

  return rows.map((r) => ({
    agentId: r.agentId,
    agentName: r.agentName,
    agentSlug: r.agentSlug,
    costMicroUsd: Number(r.costMicroUsd),
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    cacheReadTokens: r.cacheReadTokens,
    runs: r.runs,
  }));
}

export type CacheHitStats = {
  hits: number;
  misses: number;
  apiCalls: number;
};

export async function embedderCacheStats(
  userId: string,
  daysBack: number,
): Promise<CacheHitStats> {
  const since = new Date(Date.now() - daysBack * 86_400_000);
  const rows = await db
    .select({
      hits: sql<number>`coalesce(sum((${traceSteps.meta}->>'cache_hits')::int), 0)::int`,
      misses: sql<number>`coalesce(sum((${traceSteps.meta}->>'cache_misses')::int), 0)::int`,
      apiCalls: sql<number>`coalesce(sum((${traceSteps.meta}->>'api_calls')::int), 0)::int`,
    })
    .from(traceSteps)
    .innerJoin(traces, eq(traceSteps.traceId, traces.id))
    .where(
      and(
        eq(traces.ownerId, userId),
        gte(traceSteps.startedAt, since),
        eq(traceSteps.kind, 'embed'),
      ),
    );
  const r = rows[0];
  return {
    hits: r?.hits ?? 0,
    misses: r?.misses ?? 0,
    apiCalls: r?.apiCalls ?? 0,
  };
}

export type DailySpend = {
  /** ISO date (YYYY-MM-DD) in the server's local timezone. */
  day: string;
  costMicroUsd: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  runs: number;
};

/**
 * Per-day spend buckets for the last `daysBack` days. Includes zero
 * rows for empty days so charts can render a continuous strip.
 */
export async function spendByDay(userId: string, daysBack: number): Promise<DailySpend[]> {
  const since = new Date(Date.now() - daysBack * 86_400_000);
  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${traces.startedAt}), 'YYYY-MM-DD')`,
      costMicroUsd: sql<number>`coalesce(sum(${traces.costMicroUsd}), 0)::bigint`,
      tokensIn: sql<number>`coalesce(sum(${traces.tokensIn}), 0)::int`,
      tokensOut: sql<number>`coalesce(sum(${traces.tokensOut}), 0)::int`,
      cacheReadTokens: sql<number>`coalesce(sum(${traces.tokensCacheRead}), 0)::int`,
      runs: sql<number>`count(*)::int`,
    })
    .from(traces)
    .where(and(eq(traces.ownerId, userId), gte(traces.startedAt, since)))
    .groupBy(sql`date_trunc('day', ${traces.startedAt})`)
    .orderBy(sql`date_trunc('day', ${traces.startedAt}) asc`);

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: DailySpend[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = daysBack - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const row = byDay.get(key);
    out.push({
      day: key,
      costMicroUsd: row ? Number(row.costMicroUsd) : 0,
      tokensIn: row?.tokensIn ?? 0,
      tokensOut: row?.tokensOut ?? 0,
      cacheReadTokens: row?.cacheReadTokens ?? 0,
      runs: row?.runs ?? 0,
    });
  }
  return out;
}

export type ModelSpend = {
  /** The OpenRouter model slug captured in trace_steps.meta.model. */
  model: string;
  costMicroUsd: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  calls: number;
};

/**
 * Per-model spend rollup over the trace_steps table. Embeddings and chat
 * completions both land here because both go through `step(...).setMeta(
 * { model, cost_micro_usd, ... })`. Keyed by `meta.model` so the
 * dashboard can spot which model is eating the budget.
 */
export async function spendByModel(userId: string, daysBack: number): Promise<ModelSpend[]> {
  const since = new Date(Date.now() - daysBack * 86_400_000);
  const rows = await db
    .select({
      model: sql<string>`coalesce(${traceSteps.meta}->>'model', '(unknown)')`,
      costMicroUsd: sql<number>`coalesce(sum((${traceSteps.meta}->>'cost_micro_usd')::bigint), 0)::bigint`,
      tokensIn: sql<number>`coalesce(sum((${traceSteps.meta}->>'tokens_in')::int), 0)::int`,
      tokensOut: sql<number>`coalesce(sum((${traceSteps.meta}->>'tokens_out')::int), 0)::int`,
      cacheReadTokens: sql<number>`coalesce(sum((${traceSteps.meta}->>'cache_read')::int), 0)::int`,
      calls: sql<number>`count(*)::int`,
    })
    .from(traceSteps)
    .innerJoin(traces, eq(traceSteps.traceId, traces.id))
    .where(
      and(
        eq(traces.ownerId, userId),
        gte(traceSteps.startedAt, since),
        sql`${traceSteps.meta} ? 'model'`,
      ),
    )
    .groupBy(sql`coalesce(${traceSteps.meta}->>'model', '(unknown)')`)
    .orderBy(desc(sql`coalesce(sum((${traceSteps.meta}->>'cost_micro_usd')::bigint), 0)`));

  return rows.map((r) => ({
    model: r.model,
    costMicroUsd: Number(r.costMicroUsd),
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    cacheReadTokens: r.cacheReadTokens,
    calls: r.calls,
  }));
}

export type TopError = {
  message: string;
  count: number;
  lastAt: string;
  lastTraceId: string;
};

export async function topErrors(
  userId: string,
  daysBack: number,
  limit = 5,
): Promise<TopError[]> {
  const since = new Date(Date.now() - daysBack * 86_400_000);
  // Group by the first 80 chars of the error message — keeps similar
  // failures clustered without overfitting to stack-trace specifics.
  const rows = await db
    .select({
      key: sql<string>`substring(${traces.error} from 1 for 80)`,
      count: sql<number>`count(*)::int`,
      lastAt: sql<Date>`max(${traces.startedAt})`,
      lastTraceId: sql<string>`(array_agg(${traces.id} order by ${traces.startedAt} desc))[1]`,
    })
    .from(traces)
    .where(
      and(
        eq(traces.ownerId, userId),
        eq(traces.status, 'error'),
        gte(traces.startedAt, since),
        sql`${traces.error} is not null`,
      ),
    )
    .groupBy(sql`substring(${traces.error} from 1 for 80)`)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  return rows.map((r) => ({
    message: r.key,
    count: r.count,
    lastAt: new Date(r.lastAt).toISOString(),
    lastTraceId: r.lastTraceId,
  }));
}

export type RecentFailure = {
  id: string;
  kind: string;
  startedAt: string;
  error: string;
};

export async function recentFailures(userId: string, limit = 10): Promise<RecentFailure[]> {
  const rows = await db
    .select({
      id: traces.id,
      kind: traces.kind,
      startedAt: traces.startedAt,
      error: traces.error,
    })
    .from(traces)
    .where(and(eq(traces.ownerId, userId), eq(traces.status, 'error')))
    .orderBy(desc(traces.startedAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as string,
    startedAt: r.startedAt.toISOString(),
    error: r.error ?? '',
  }));
}
