import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import { agents, db, traceSteps, traces, type TraceStep } from '@mantle/db';
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

/**
 * Who reads traces: `login` the signed-in login (null or the owner id for
 * the brain owner), and whether it reads the system's work too (the traces
 * of no login's turn). The brain owner always does; another login when it
 * is an Admin user with the settings area (traceReaderFor). A reader never
 * reads another login's work.
 */
export type TraceReader = { readonly login: string | null; readonly system: boolean };

/** The brain owner's reader: its own turns and the system's. */
export const OWNER_TRACE_READER: TraceReader = { login: null, system: true };

function isOwnerLogin(ownerId: string, login: string | null): boolean {
  return !login || login.toLowerCase() === ownerId.toLowerCase();
}

/** The login `reader` reads as: the owner id for the brain owner. */
export function readerLogin(ownerId: string, reader: TraceReader): string {
  return (isOwnerLogin(ownerId, reader.login) ? ownerId : reader.login!).toLowerCase();
}

/**
 * Whether node `nodeId` (a column) is open to `login`: not a per-login row
 * of another login (nodes.login_id). Under the row rules a node the
 * reader's scope does not read is not open either. (A node homed in
 * another login's private workspace never reaches a reader here: its
 * traces are that login's, stamped at write and by 0356.)
 */
export function nodeOpenTo(nodeId: SQLWrapper, login: string): SQL {
  return sql`exists (
    select 1 from nodes n
     where n.id = ${nodeId} and (n.login_id is null or n.login_id = ${login}::uuid))`;
}

/**
 * The traces `reader` lists and reads (traceReadable is the same rule for
 * one trace), by the login the row is stamped with (traces.login_id, the
 * login whose work it is: packages/tracing rowLoginFor, and 0356 for older
 * rows): its own work, and with `system` the system's (no login). The brain
 * owner reads its own and the system's; no reader reads another login's.
 */
export function traceListedFor(ownerId: string, reader: TraceReader): SQL {
  const own = eq(traces.loginId, readerLogin(ownerId, reader));
  return reader.system || isOwnerLogin(ownerId, reader.login)
    ? (or(isNull(traces.loginId), own) as SQL)
    : own;
}

/** Shared WHERE for trace list/count queries. */
function traceConds(userId: string, reader: TraceReader, filter: TraceFilter) {
  const conds = [eq(traces.ownerId, userId), traceListedFor(userId, reader)];
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

/** A page of the traces `reader` may see (traceListedFor). */
export async function listTraces(
  userId: string,
  reader: TraceReader,
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
    .where(and(...traceConds(userId, reader, filter)))
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

export async function countTraces(
  userId: string,
  reader: TraceReader,
  filter: TraceFilter = {},
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(traces)
    .where(and(...traceConds(userId, reader, filter)));
  return row?.n ?? 0;
}

/**
 * Whether `reader` may read trace `traceId`: the rule traceListedFor
 * lists by, for one trace.
 */
export async function traceReadable(
  ownerId: string,
  traceId: string,
  reader: TraceReader,
): Promise<boolean> {
  const [row] = await db
    .select({ id: traces.id })
    .from(traces)
    .where(
      and(eq(traces.id, traceId), eq(traces.ownerId, ownerId), traceListedFor(ownerId, reader)),
    )
    .limit(1);
  return !!row;
}

/** One trace with its steps, or null when it is not the owner's or not
 *  `reader`'s to read (traceReadable). */
export async function getTrace(
  userId: string,
  traceId: string,
  reader: TraceReader,
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
