import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { db, entities, entityEdges, facts, nodes, traces } from '@mantle/db';
import { getTrace } from './traces';
import type { TraceDetail } from './traces-format';
import { deriveAction, type ActionCategory, type ActionPresentation } from './journey-format';

/**
 * Journey view data layer (server-only). Reads the observability tables and
 * presents them as "actions and their reactions": each trace becomes a
 * human-readable activity row, and a single trace expands into its step
 * timeline + the brain layers it actually wrote (L5 index, L4 facts, graph).
 *
 * Owner-scoped throughout — pass the user's id. Read-only; never mutates.
 */

export type ActivityItem = ActionPresentation & {
  traceId: string;
  kind: string;
  status: string;
  startedAt: string;
  durationMs: number | null;
  costMicroUsd: number;
  stepCount: number;
  /** Node title (or recorded filename) for the subject of the action. */
  title: string | null;
  subjectKind: string | null;
  subjectId: string | null;
};

export type LandedLayers = {
  /** L6 content_store — the node itself. */
  node: { id: string; type: string; title: string } | null;
  /** L5 content_index — the searchable catalogue entry. */
  index: {
    summary: string | null;
    hasEmbedding: boolean;
    hasText: boolean;
    tags: string[];
  } | null;
  /** L4 profile — durable facts mined from this node (currently-valid only). */
  facts: { content: string; kind: string; entityName: string | null }[];
  /** Graph — entities mentioned in this node. */
  mentions: { name: string; kind: string }[];
};

export type JourneyDetail = TraceDetail & { landed: LandedLayers | null };

/** Normalise db.execute / select result shapes. */
function strOf(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export async function listActivity(
  userId: string,
  opts: { sinceHours?: number; limit?: number; category?: ActionCategory } = {},
): Promise<ActivityItem[]> {
  const limit = Math.min(opts.limit ?? 80, 300);
  const conds = [eq(traces.ownerId, userId)];
  if (opts.sinceHours && opts.sinceHours > 0) {
    conds.push(gte(traces.startedAt, new Date(Date.now() - opts.sinceHours * 3600_000)));
  }

  // Over-fetch a little so category filtering (done in JS, since it depends on
  // the derived presentation) still returns a useful page.
  const rows = await db
    .select({
      id: traces.id,
      kind: traces.kind,
      status: traces.status,
      startedAt: traces.startedAt,
      durationMs: traces.durationMs,
      costMicroUsd: traces.costMicroUsd,
      stepCount: traces.stepCount,
      subjectKind: traces.subjectKind,
      subjectId: traces.subjectId,
      data: traces.data,
      nodeType: nodes.type,
      nodeTitle: nodes.title,
      nodeData: nodes.data,
    })
    .from(traces)
    .leftJoin(
      nodes,
      and(eq(traces.subjectId, nodes.id), eq(traces.subjectKind, sql`'node'`), eq(nodes.ownerId, userId)),
    )
    .where(and(...conds))
    .orderBy(desc(traces.startedAt))
    .limit(opts.category ? limit * 3 : limit);

  const items = rows.map((r) => {
    const traceData = (r.data ?? {}) as Record<string, unknown>;
    const nodeData = (r.nodeData ?? {}) as Record<string, unknown>;
    const source = strOf(traceData.source);
    const mime = strOf(nodeData.mimeType) ?? strOf(nodeData.mime);
    const pres = deriveAction({
      kind: r.kind as string,
      nodeType: (r.nodeType as string | null) ?? null,
      mime,
      source,
    });
    const title = r.nodeTitle ?? strOf(traceData.filename) ?? strOf(traceData.title);
    return {
      ...pres,
      traceId: r.id,
      kind: r.kind as string,
      status: r.status as string,
      startedAt: r.startedAt.toISOString(),
      durationMs: r.durationMs,
      costMicroUsd: r.costMicroUsd ?? 0,
      stepCount: r.stepCount ?? 0,
      title,
      subjectKind: r.subjectKind,
      subjectId: r.subjectId,
    } satisfies ActivityItem;
  });

  const filtered = opts.category ? items.filter((i) => i.category === opts.category) : items;
  return filtered.slice(0, limit);
}

/** A single action + the brain layers it produced. */
export async function getJourney(userId: string, traceId: string): Promise<JourneyDetail | null> {
  const detail = await getTrace(userId, traceId);
  if (!detail) return null;
  let landed: LandedLayers | null = null;
  if (detail.subjectKind === 'node' && detail.subjectId) {
    landed = await loadLanded(userId, detail.subjectId);
  }
  return { ...detail, landed };
}

async function loadLanded(userId: string, nodeId: string): Promise<LandedLayers | null> {
  const [node] = await db
    .select({
      id: nodes.id,
      type: nodes.type,
      title: nodes.title,
      data: nodes.data,
      tags: nodes.tags,
      hasEmbedding: sql<boolean>`${nodes.embedding} is not null`,
    })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, userId)))
    .limit(1);

  if (!node) return null;

  const nodeData = (node.data ?? {}) as Record<string, unknown>;

  const factRows = await db
    .select({
      content: facts.content,
      kind: facts.kind,
      entityName: entities.name,
    })
    .from(facts)
    .leftJoin(entities, eq(facts.entityId, entities.id))
    .where(
      and(eq(facts.ownerId, userId), eq(facts.sourceNodeId, nodeId), isNull(facts.validTo)),
    )
    .limit(50);

  const mentionRows = await db
    .select({ name: entities.name, kind: entities.kind })
    .from(entityEdges)
    .innerJoin(entities, eq(entityEdges.sourceId, entities.id))
    .where(
      and(
        eq(entityEdges.ownerId, userId),
        eq(entityEdges.targetId, nodeId),
        eq(entityEdges.targetKind, 'node'),
        eq(entityEdges.relation, 'mentioned_in'),
      ),
    )
    .limit(50);

  return {
    node: { id: node.id, type: node.type as string, title: node.title },
    index: {
      summary: strOf(nodeData.summary),
      hasEmbedding: !!node.hasEmbedding,
      hasText: typeof nodeData.text === 'string' && (nodeData.text as string).trim().length > 0,
      tags: node.tags ?? [],
    },
    facts: factRows.map((f) => ({
      content: f.content,
      kind: f.kind as string,
      entityName: f.entityName,
    })),
    mentions: mentionRows.map((m) => ({ name: m.name, kind: m.kind as string })),
  };
}
