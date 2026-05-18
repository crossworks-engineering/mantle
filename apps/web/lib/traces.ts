import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  agents,
  db,
  traceSteps,
  traces,
  type TraceStep,
} from '@mantle/db';

/**
 * Read-only helpers for /traces. Owner-scoped — pass the user's id.
 */

export type TraceSummary = {
  id: string;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  costMicroUsd: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  stepCount: number;
  subjectKind: string | null;
  subjectId: string | null;
  agentName: string | null;
  agentSlug: string | null;
  error: string | null;
};

export type TraceFilter = {
  kinds?: string[];
  statuses?: string[];
  sinceHours?: number;
  limit?: number;
};

export async function listTraces(userId: string, filter: TraceFilter = {}): Promise<TraceSummary[]> {
  const limit = Math.min(filter.limit ?? 50, 500);
  const conds = [eq(traces.ownerId, userId)];
  if (filter.kinds && filter.kinds.length > 0) {
    conds.push(inArray(traces.kind, filter.kinds as never));
  }
  if (filter.statuses && filter.statuses.length > 0) {
    conds.push(inArray(traces.status, filter.statuses as never));
  }
  if (filter.sinceHours && filter.sinceHours > 0) {
    const since = new Date(Date.now() - filter.sinceHours * 3600_000);
    conds.push(gte(traces.startedAt, since));
  }

  const rows = await db
    .select({
      id: traces.id,
      kind: traces.kind,
      status: traces.status,
      startedAt: traces.startedAt,
      finishedAt: traces.finishedAt,
      durationMs: traces.durationMs,
      costMicroUsd: traces.costMicroUsd,
      tokensIn: traces.tokensIn,
      tokensOut: traces.tokensOut,
      tokensCacheRead: traces.tokensCacheRead,
      stepCount: traces.stepCount,
      subjectKind: traces.subjectKind,
      subjectId: traces.subjectId,
      agentName: agents.name,
      agentSlug: agents.slug,
      error: traces.error,
    })
    .from(traces)
    .leftJoin(agents, eq(traces.agentId, agents.id))
    .where(and(...conds))
    .orderBy(desc(traces.startedAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as string,
    status: r.status as string,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    durationMs: r.durationMs,
    costMicroUsd: r.costMicroUsd ?? 0,
    tokensIn: r.tokensIn ?? 0,
    tokensOut: r.tokensOut ?? 0,
    tokensCacheRead: r.tokensCacheRead ?? 0,
    stepCount: r.stepCount ?? 0,
    subjectKind: r.subjectKind,
    subjectId: r.subjectId,
    agentName: r.agentName,
    agentSlug: r.agentSlug,
    error: r.error,
  }));
}

export type TraceDetail = TraceSummary & {
  data: Record<string, unknown>;
  steps: TraceStepSummary[];
};

export type TraceStepSummary = {
  id: string;
  parentStepId: string | null;
  ordinal: number;
  name: string;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  meta: Record<string, unknown>;
  error: string | null;
};

export async function getTrace(userId: string, traceId: string): Promise<TraceDetail | null> {
  const [t] = await db
    .select({
      id: traces.id,
      kind: traces.kind,
      status: traces.status,
      startedAt: traces.startedAt,
      finishedAt: traces.finishedAt,
      durationMs: traces.durationMs,
      costMicroUsd: traces.costMicroUsd,
      tokensIn: traces.tokensIn,
      tokensOut: traces.tokensOut,
      tokensCacheRead: traces.tokensCacheRead,
      stepCount: traces.stepCount,
      subjectKind: traces.subjectKind,
      subjectId: traces.subjectId,
      agentName: agents.name,
      agentSlug: agents.slug,
      error: traces.error,
      data: traces.data,
    })
    .from(traces)
    .leftJoin(agents, eq(traces.agentId, agents.id))
    .where(and(eq(traces.id, traceId), eq(traces.ownerId, userId)))
    .limit(1);

  if (!t) return null;

  const stepRows = await db
    .select()
    .from(traceSteps)
    .where(eq(traceSteps.traceId, traceId))
    .orderBy(traceSteps.ordinal);

  return {
    id: t.id,
    kind: t.kind as string,
    status: t.status as string,
    startedAt: t.startedAt.toISOString(),
    finishedAt: t.finishedAt?.toISOString() ?? null,
    durationMs: t.durationMs,
    costMicroUsd: t.costMicroUsd ?? 0,
    tokensIn: t.tokensIn ?? 0,
    tokensOut: t.tokensOut ?? 0,
    tokensCacheRead: t.tokensCacheRead ?? 0,
    stepCount: t.stepCount ?? 0,
    subjectKind: t.subjectKind,
    subjectId: t.subjectId,
    agentName: t.agentName,
    agentSlug: t.agentSlug,
    error: t.error,
    data: (t.data ?? {}) as Record<string, unknown>,
    steps: stepRows.map(stepSummary),
  };
}

function stepSummary(s: TraceStep): TraceStepSummary {
  return {
    id: s.id,
    parentStepId: s.parentStepId,
    ordinal: s.ordinal,
    name: s.name,
    kind: s.kind as string,
    status: s.status as string,
    startedAt: s.startedAt.toISOString(),
    finishedAt: s.finishedAt?.toISOString() ?? null,
    durationMs: s.durationMs,
    input: (s.input ?? {}) as Record<string, unknown>,
    output: (s.output ?? {}) as Record<string, unknown>,
    meta: (s.meta ?? {}) as Record<string, unknown>,
    error: s.error,
  };
}

export function formatMicroUsd(microUsd: number): string {
  if (microUsd === 0) return '$0';
  const usd = microUsd / 1_000_000;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

// silence unused-import in tree-shake scenarios
void sql;
