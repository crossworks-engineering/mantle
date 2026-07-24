/**
 * Node biography — assemble a timeline of everything that touched a
 * given node so the operator can answer "what happened to my file
 * after I uploaded it?"
 *
 * One server-side query bundle:
 *   - The node row itself, with derived flags (has summary? has
 *     embedding? content length?).
 *   - Every trace where subject_id = nodeId. This catches ingest
 *     events (content_ingest), pipeline runs (extractor_run,
 *     summarizer_run, photo_ingest), and any other code that
 *     records traces tied to a node.
 *   - The trace_steps for each trace (truncated input/output/meta
 *     jsonb the page renders directly).
 *   - Aggregate stats so the page header can show "8 traces, $0.003
 *     total cost, first seen 2026-05-18 14:20."
 *
 * Owner-scoped throughout. The DB queries trust the owner_id check
 * on traces; the node row is fetched with both ownerId AND id so a
 * leaked node id from another owner returns null.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, agents, nodes, traces, traceSteps } from '@mantle/db';
import type { TraceDetail, TraceStepSummary } from '@mantle/web-ui/traces-format';

export type NodeBiographyView = {
  node: {
    id: string;
    type: string;
    title: string;
    path: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
    /** First N chars of the summary the extractor wrote — null if
     *  the extractor hasn't run (or refused to). */
    summary: string | null;
    /** True when the node has an embedding vector — second half of
     *  the "is this node ready for retrieval?" check. */
    hasEmbedding: boolean;
    /** Bytes of the content field (text-shaped nodes) or 0
     *  otherwise. Useful for "did extractor skip because body too
     *  short?" debugging. */
    contentChars: number;
    /** First 4KB of content. Lets the biography page show a quick
     *  preview of what was actually saved. */
    contentPreview: string | null;
    /** The data jsonb truncated and key-summarised so we don't blow
     *  up the page rendering a 1MB blob inline. */
    dataKeys: string[];
  };
  /** Traces in chronological order (oldest first). Operators read
   *  these top-to-bottom as a story: ingest → extractor → ... */
  traces: TraceDetail[];
  stats: {
    totalTraces: number;
    totalCostMicroUsd: number;
    totalTokensIn: number;
    totalTokensOut: number;
    /** ISO timestamp of the earliest trace touching this node, or
     *  the node's own createdAt if there are no traces. */
    firstSeen: string;
    /** ISO timestamp of the most recent trace. Equal to firstSeen
     *  when there's only one. */
    lastTouched: string;
    /** Counts by kind + status for the header chips. */
    byKind: Record<string, number>;
    byStatus: Record<string, number>;
  };
};

/** Pull the node + every trace + every step that touched it, into
 *  one bundle the page renders. Returns null when the node doesn't
 *  exist or isn't owned by the caller. */
export async function loadNodeBiography(
  ownerId: string,
  nodeId: string,
): Promise<NodeBiographyView | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  if (!node) return null;

  // All traces tied to this node, ordered chronologically so the
  // biography reads as a story.
  const traceRows = await db
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
    .where(and(eq(traces.subjectId, nodeId), eq(traces.ownerId, ownerId)))
    .orderBy(asc(traces.startedAt));

  // Steps for every trace, in one query. Order by trace + ordinal so
  // we can bucket in JS without re-sorting.
  const stepRows =
    traceRows.length > 0
      ? await db
          .select()
          .from(traceSteps)
          .where(
            inArray(
              traceSteps.traceId,
              traceRows.map((t) => t.id),
            ),
          )
          .orderBy(asc(traceSteps.ordinal))
      : [];

  // Bucket steps by trace.
  const stepsByTrace = new Map<string, TraceStepSummary[]>();
  for (const s of stepRows) {
    const summary: TraceStepSummary = {
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
    const arr = stepsByTrace.get(s.traceId) ?? [];
    arr.push(summary);
    stepsByTrace.set(s.traceId, arr);
  }

  // Stitch into TraceDetail objects.
  const traceDetails: TraceDetail[] = traceRows.map((r) => ({
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
    data: (r.data ?? {}) as Record<string, unknown>,
    steps: stepsByTrace.get(r.id) ?? [],
  }));

  // Stats.
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let totalCost = 0;
  let totalIn = 0;
  let totalOut = 0;
  for (const t of traceDetails) {
    byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    totalCost += t.costMicroUsd;
    totalIn += t.tokensIn;
    totalOut += t.tokensOut;
  }
  const firstSeenISO = traceDetails[0]?.startedAt ?? node.createdAt.toISOString();
  const lastTouchedISO =
    traceDetails[traceDetails.length - 1]?.startedAt ?? node.updatedAt.toISOString();

  // Derive node-shape flags.
  const data = (node.data ?? {}) as Record<string, unknown>;
  const content = typeof data.content === 'string' ? (data.content as string) : '';
  const summary = typeof data.summary === 'string' ? (data.summary as string) : null;
  // Buffer.byteLength would be more accurate for byte counts but
  // contentChars is the metric extractor uses (chars). Match it so
  // operators see the same number the extractor sees.
  const contentChars = content.length;
  const contentPreview = content.length > 0 ? content.slice(0, 4096) : null;

  return {
    node: {
      id: node.id,
      type: node.type,
      title: node.title,
      path: node.path as unknown as string,
      tags: (node.tags ?? []) as string[],
      createdAt: node.createdAt.toISOString(),
      updatedAt: node.updatedAt.toISOString(),
      summary: summary
        ? // Cap the summary so a runaway extractor output doesn't
          // dominate the page header.
          summary.length > 600
          ? `${summary.slice(0, 600)}…`
          : summary
        : null,
      hasEmbedding: node.embedding != null,
      contentChars,
      contentPreview,
      dataKeys: Object.keys(data),
    },
    traces: traceDetails,
    stats: {
      totalTraces: traceDetails.length,
      totalCostMicroUsd: totalCost,
      totalTokensIn: totalIn,
      totalTokensOut: totalOut,
      firstSeen: firstSeenISO,
      lastTouched: lastTouchedISO,
      byKind,
      byStatus,
    },
  };
}
