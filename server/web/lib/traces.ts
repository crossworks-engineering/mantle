import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  agents,
  db,
  heartbeatFires,
  runItems,
  runs,
  traceSteps,
  traces,
  type TraceStep,
} from '@mantle/db';
import type {
  TraceDetail,
  TraceFilter,
  TraceStepSummary,
  TraceSummary,
} from '@mantle/client-types/traces-format';

/**
 * Read-only helpers for /traces. Owner-scoped — pass the user's id.
 *
 * Pure types + format helpers live in `./traces-format` so client
 * components can pull them in without dragging postgres-js into the
 * browser bundle.
 */

export type {
  TraceSummary,
  TraceFilter,
  TraceStepSummary,
  TraceDetail,
} from '@mantle/client-types/traces-format';
export { formatMicroUsd, formatDuration } from '@mantle/client-types/traces-format';

/** Shared WHERE for trace list/count queries. */
function traceConds(userId: string, filter: TraceFilter) {
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
  return conds;
}

export async function listTraces(
  userId: string,
  filter: TraceFilter = {},
): Promise<TraceSummary[]> {
  const limit = Math.min(filter.limit ?? 50, 500);
  const sortCol =
    filter.sort === 'cost'
      ? traces.costMicroUsd
      : filter.sort === 'duration'
        ? traces.durationMs
        : traces.startedAt;
  const orderFn = filter.dir === 'asc' ? asc : desc;

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
    .where(and(...traceConds(userId, filter)))
    .orderBy(orderFn(sortCol))
    .limit(limit)
    .offset(filter.offset ?? 0);

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

export async function countTraces(userId: string, filter: TraceFilter = {}): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(traces)
    .where(and(...traceConds(userId, filter)));
  return row?.n ?? 0;
}

/**
 * The login whose turn trace `traceId` records, or null for system work (W7
 * integration fix 2, H2): a heartbeat fire's answerer
 * (heartbeat_fires.answered_by, null the anchor), else the login the trace
 * names (traces.login_id), else the login of the run it planned or ran
 * (runs.login_id, by origin_turn_id or an item's trace_ref). The brain
 * owner's login comes back as the owner id.
 */
async function traceTurnLogin(ownerId: string, traceId: string): Promise<string | null> {
  const [fire] = await db
    .select({ by: heartbeatFires.answeredBy })
    .from(heartbeatFires)
    .where(eq(heartbeatFires.traceId, traceId))
    .limit(1);
  if (fire) return fire.by ?? ownerId;
  const [t] = await db
    .select({ login: traces.loginId })
    .from(traces)
    .where(and(eq(traces.id, traceId), eq(traces.ownerId, ownerId)))
    .limit(1);
  if (t?.login) return t.login;
  const [planned] = await db
    .select({ login: runs.loginId })
    .from(runs)
    .where(and(eq(runs.ownerId, ownerId), eq(runs.originTurnId, traceId)))
    .limit(1);
  if (planned?.login) return planned.login;
  const [ran] = await db
    .select({ login: runs.loginId })
    .from(runItems)
    .innerJoin(runs, eq(runs.id, runItems.runId))
    .where(and(eq(runs.ownerId, ownerId), eq(runItems.traceRef, traceId)))
    .limit(1);
  return ran?.login ?? null;
}

/**
 * Whether `reader` (the signed-in login; null or the owner id for the brain
 * owner) may read trace `traceId` (W7 integration fix 2, H2): each user
 * reads only their own turns. Another login reads only the traces of turns
 * it was answered in; the brain owner reads its own and the system's
 * (no login), never another login's.
 */
export async function traceReadable(
  ownerId: string,
  traceId: string,
  reader: string | null,
): Promise<boolean> {
  const norm = (l: string | null) =>
    l && l.toLowerCase() !== ownerId.toLowerCase() ? l.toLowerCase() : null;
  return norm(await traceTurnLogin(ownerId, traceId)) === norm(reader);
}

/** One trace with its steps, or null when it is not the owner's or not
 *  `reader`'s to read (traceReadable). `reader`: the signed-in login, null
 *  for the brain owner. */
export async function getTrace(
  userId: string,
  traceId: string,
  reader: string | null,
): Promise<TraceDetail | null> {
  if (!(await traceReadable(userId, traceId, reader))) return null;
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

// silence unused-import in tree-shake scenarios
void sql;
