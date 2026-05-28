import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { agents, db, traceSteps, traces } from '@mantle/db';
import { contextLimitFor, contextSourceFor, refreshModelCatalog, type ContextSource } from '@mantle/tracing';

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

export type SpendRange = 'day' | 'week' | 'month';

export type SpendSummary = {
  range: SpendRange;
  costMicroUsd: number;
  runs: number;
};

const RANGE_HOURS: Record<SpendRange, number> = {
  day: 24,
  week: 24 * 7,
  month: 24 * 30,
};

export async function spendInRange(userId: string, range: SpendRange): Promise<SpendSummary> {
  const since = new Date(Date.now() - RANGE_HOURS[range] * 3600_000);
  const rows = await db
    .select({
      costMicroUsd: sql<number>`coalesce(sum(${traces.costMicroUsd}), 0)::bigint`,
      runs: sql<number>`count(*)::int`,
    })
    .from(traces)
    .where(and(eq(traces.ownerId, userId), gte(traces.startedAt, since)));
  const r = rows[0];
  return {
    range,
    costMicroUsd: Number(r?.costMicroUsd ?? 0),
    runs: r?.runs ?? 0,
  };
}

export type AgentContext = {
  agentId: string;
  agentName: string | null;
  agentSlug: string | null;
  modelSlug: string;
  lastTokensIn: number;
  contextLimit: number | null;
  /** Where contextLimit came from: live OpenRouter data, the static
   *  fallback, or unknown (slug not in either). Surfaced in the UI. */
  contextSource: ContextSource;
  pct: number | null;
  lastRunAt: string;
};

type AgentContextRow = {
  agent_id: string;
  agent_name: string | null;
  agent_slug: string | null;
  model: string;
  started_at: string;
  max_tokens_in: number;
};

/**
 * For each agent that ran a responder_turn in the last 24h, return the
 * MAX prompt-token count across that turn's llm_call steps as a proxy
 * for "context fill" — tool-loop turns have multiple llm_calls, each
 * with its own (independent) prompt; the biggest single one is what
 * actually had to fit in the model's context window.
 *
 * Model comes from agents.model (the currently-configured slug), which
 * is correct as long as the model wasn't swapped between the last turn
 * and now. For an unknown model, contextLimit + pct stay null and the
 * UI shows a greyed-out bar.
 */
export async function recentAgentContext(userId: string): Promise<AgentContext[]> {
  // Warm the live model catalog without blocking this render — the static
  // fallback is accurate, so the first paint is already correct and live
  // data takes over once the (TTL-gated, keyless) fetch completes.
  void refreshModelCatalog();
  const since = new Date(Date.now() - 24 * 3600_000);
  const result = await db.execute<AgentContextRow>(sql`
    WITH latest_trace AS (
      SELECT DISTINCT ON (agent_id) id, agent_id, started_at
      FROM traces
      WHERE owner_id = ${userId}
        AND kind = 'responder_turn'
        AND agent_id IS NOT NULL
        AND started_at >= ${since.toISOString()}
      ORDER BY agent_id, started_at DESC
    )
    SELECT
      lt.agent_id,
      a.name AS agent_name,
      a.slug AS agent_slug,
      a.model,
      lt.started_at,
      COALESCE((
        SELECT MAX((meta->>'tokens_in')::int)
        FROM trace_steps
        WHERE trace_id = lt.id AND kind = 'llm_call'
      ), 0) AS max_tokens_in
    FROM latest_trace lt
    JOIN agents a ON a.id = lt.agent_id
    ORDER BY lt.started_at DESC
  `);
  const rows = (Array.isArray(result) ? result : (result as { rows?: AgentContextRow[] }).rows ?? []) as AgentContextRow[];
  return rows.map((r) => {
    const limit = contextLimitFor(r.model);
    const tokensIn = Number(r.max_tokens_in);
    return {
      agentId: r.agent_id,
      agentName: r.agent_name,
      agentSlug: r.agent_slug,
      modelSlug: r.model,
      lastTokensIn: tokensIn,
      contextLimit: limit,
      contextSource: contextSourceFor(r.model),
      pct: limit ? Math.min(1, tokensIn / limit) : null,
      lastRunAt: new Date(r.started_at).toISOString(),
    };
  });
}

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

export type DuplicateSuppression = {
  /** Model slug captured in trace_steps.meta.model at suppression time. */
  model: string;
  /** How many duplicate tool_use blocks were suppressed in the window. */
  count: number;
  /** Distinct tool slugs the duplicates targeted (top 5, comma-separated). */
  topSlugs: string;
  /** Most recent suppression, ISO string. */
  lastAt: string;
};

/**
 * Roll-up of in-response duplicate tool-call suppressions, grouped by model.
 * Drives the `/debug` "Duplicates suppressed by model" widget — answers the
 * question "is the dedup guard firing, and which model is the worst
 * offender?" without an ad-hoc query.
 *
 * Background: some models (notably Grok-4.x) emit byte-identical parallel
 * tool_use blocks for the same write op in one response. The tool-loop
 * suppresses each duplicate and records a step with kind='compute',
 * status='skipped', and meta.duplicate_in_response=true + meta.model so
 * this rollup works without a join back to the trace's first llm_call.
 * See architecture.md §9n.
 */
export async function duplicateSuppressionStats(
  userId: string,
  daysBack: number,
): Promise<DuplicateSuppression[]> {
  const since = new Date(Date.now() - daysBack * 86_400_000);
  const rows = await db
    .select({
      model: sql<string>`coalesce(${traceSteps.meta}->>'model', '(unknown)')`,
      count: sql<number>`count(*)::int`,
      topSlugs: sql<string>`string_agg(
        distinct coalesce(${traceSteps.input}->>'slug', '(unknown)'),
        ', '
        order by coalesce(${traceSteps.input}->>'slug', '(unknown)')
      )`,
      lastAt: sql<Date>`max(${traceSteps.startedAt})`,
    })
    .from(traceSteps)
    .innerJoin(traces, eq(traceSteps.traceId, traces.id))
    .where(
      and(
        eq(traces.ownerId, userId),
        gte(traceSteps.startedAt, since),
        sql`${traceSteps.meta}->>'duplicate_in_response' = 'true'`,
      ),
    )
    .groupBy(sql`coalesce(${traceSteps.meta}->>'model', '(unknown)')`)
    .orderBy(desc(sql`count(*)`));

  return rows.map((r) => ({
    model: r.model,
    count: r.count,
    topSlugs: r.topSlugs ?? '',
    lastAt: r.lastAt instanceof Date ? r.lastAt.toISOString() : String(r.lastAt),
  }));
}

export type FactCostCapStats = {
  /** Extractor model slug captured in trace_steps.meta.model. */
  model: string;
  /** How many process_facts steps dropped facts to the cap in the window. */
  runs: number;
  /** Total facts discarded across those runs (sum of meta.dropped). */
  factsDropped: number;
  /** Most recent occurrence, ISO string. */
  lastAt: string;
};

/**
 * Roll-up of fact runs that hit the extractor's cost cap and discarded
 * facts the LLM already produced (and we already paid for), grouped by
 * model. Drives the `/debug` "Facts dropped to cost cap" widget — the
 * answer to "is a mis-set cap silently eating my profile facts?".
 *
 * Background: `process_facts` marks the step `skipped` + sets
 * meta.fact_cost_cap=true / meta.dropped / meta.model when the per-node
 * fact-classification budget is exhausted. A cap of 0 used to read as
 * "zero budget" and drop *every* fact while the run still reported
 * success — invisible until you hand-traced it. This widget surfaces it.
 * See observability.md §6 (disposition catalog) + data-flow-tracing.md §4.
 */
export async function factCostCapStats(
  userId: string,
  daysBack: number,
): Promise<FactCostCapStats[]> {
  const since = new Date(Date.now() - daysBack * 86_400_000);
  const rows = await db
    .select({
      model: sql<string>`coalesce(${traceSteps.meta}->>'model', '(unknown)')`,
      runs: sql<number>`count(*)::int`,
      factsDropped: sql<number>`coalesce(sum((${traceSteps.meta}->>'dropped')::int), 0)::int`,
      lastAt: sql<Date>`max(${traceSteps.startedAt})`,
    })
    .from(traceSteps)
    .innerJoin(traces, eq(traceSteps.traceId, traces.id))
    .where(
      and(
        eq(traces.ownerId, userId),
        gte(traceSteps.startedAt, since),
        sql`${traceSteps.meta}->>'fact_cost_cap' = 'true'`,
      ),
    )
    .groupBy(sql`coalesce(${traceSteps.meta}->>'model', '(unknown)')`)
    .orderBy(desc(sql`coalesce(sum((${traceSteps.meta}->>'dropped')::int), 0)`));

  return rows.map((r) => ({
    model: r.model,
    runs: r.runs,
    factsDropped: r.factsDropped,
    lastAt: r.lastAt instanceof Date ? r.lastAt.toISOString() : String(r.lastAt),
  }));
}
