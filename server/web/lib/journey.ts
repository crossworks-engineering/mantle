import { and, desc, eq, gte, isNull, lt, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
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
  /** Outcome — what entered the brain. Facts mined + entities linked +
   *  relations drawn from this action's node (0 for non-content / dialog
   *  actions). */
  factCount: number;
  mentionCount: number;
  relationCount: number;
};

/** Live snapshot for the always-on Activity surfaces: what's running right now,
 *  what recently succeeded, and what failed. */
export type LiveActivity = {
  active: ActivityItem[];
  recent: ActivityItem[];
  failures: ActivityItem[];
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
  /** Graph — relations this node drew between entities (subject→object). */
  relations: { subject: string; relation: string; object: string }[];
};

export type JourneyDetail = TraceDetail & { landed: LandedLayers | null };

/** Normalise db.execute / select result shapes. */
function strOf(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Shared row → ActivityItem mapping (presentation + outcome counts). */
function mapActivityRow(r: {
  id: string;
  kind: string;
  status: string;
  startedAt: Date;
  durationMs: number | null;
  costMicroUsd: number | null;
  stepCount: number | null;
  subjectKind: string | null;
  subjectId: string | null;
  data: unknown;
  nodeType: string | null;
  nodeTitle: string | null;
  nodeData: unknown;
  factCount: number | null;
  mentionCount: number | null;
  relationCount: number | null;
}): ActivityItem {
  const traceData = (r.data ?? {}) as Record<string, unknown>;
  const nodeData = (r.nodeData ?? {}) as Record<string, unknown>;
  const source = strOf(traceData.source);
  const mime = strOf(nodeData.mimeType) ?? strOf(nodeData.mime);
  const pres = deriveAction({ kind: r.kind, nodeType: r.nodeType, mime, source });
  const title = r.nodeTitle ?? strOf(traceData.filename) ?? strOf(traceData.title);
  return {
    ...pres,
    traceId: r.id,
    kind: r.kind,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    durationMs: r.durationMs,
    costMicroUsd: r.costMicroUsd ?? 0,
    stepCount: r.stepCount ?? 0,
    title,
    subjectKind: r.subjectKind,
    subjectId: r.subjectId,
    factCount: r.factCount ?? 0,
    mentionCount: r.mentionCount ?? 0,
    relationCount: r.relationCount ?? 0,
  };
}

/** Core query shared by the feed + the live snapshot. The outcome counts are
 *  correlated subqueries on the indexed source_node_id / target_id columns. */
async function queryActivity(
  userId: string,
  extraConds: ReturnType<typeof eq>[],
  limit: number,
): Promise<ActivityItem[]> {
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
      factCount: sql<number>`(select count(*)::int from ${facts} where ${facts.sourceNodeId} = ${traces.subjectId} and ${facts.validTo} is null)`,
      mentionCount: sql<number>`(select count(*)::int from ${entityEdges} where ${entityEdges.targetId} = ${traces.subjectId} and ${entityEdges.targetKind} = 'node' and ${entityEdges.relation} = 'mentioned_in')`,
      relationCount: sql<number>`(select count(*)::int from ${entityEdges} where ${entityEdges.data}->>'source_node_id' = ${traces.subjectId}::text)`,
    })
    .from(traces)
    .leftJoin(
      nodes,
      and(
        eq(traces.subjectId, nodes.id),
        eq(traces.subjectKind, sql`'node'`),
        eq(nodes.ownerId, userId),
      ),
    )
    .where(and(eq(traces.ownerId, userId), ...extraConds))
    .orderBy(desc(traces.startedAt))
    .limit(limit);
  return rows.map((r) => mapActivityRow(r as Parameters<typeof mapActivityRow>[0]));
}

export async function listActivity(
  userId: string,
  opts: {
    sinceHours?: number;
    limit?: number;
    category?: ActionCategory;
    /** Hide no-op skips (body_too_short, already_extracted, no_new_activity, …)
     *  — show only traces that actually did work. */
    processedOnly?: boolean;
  } = {},
): Promise<ActivityItem[]> {
  const limit = Math.min(opts.limit ?? 80, 300);
  const extra: ReturnType<typeof eq>[] = [];
  if (opts.sinceHours && opts.sinceHours > 0) {
    extra.push(gte(traces.startedAt, new Date(Date.now() - opts.sinceHours * 3600_000)) as never);
  }
  if (opts.processedOnly) {
    extra.push(ne(traces.status, 'skipped') as never);
  }
  // Over-fetch when filtering by category, which depends on the derived
  // presentation (computed in JS, not the DB).
  const items = await queryActivity(userId, extra, opts.category ? limit * 3 : limit);
  const filtered = opts.category ? items.filter((i) => i.category === opts.category) : items;
  return filtered.slice(0, limit);
}

/** Real traces finish in seconds, but a bulky-document extraction on a slow CPU
 *  embedder can legitimately run for many minutes. Keep this ABOVE the extract
 *  queue's job-expiry (`MANTLE_EXTRACT_EXPIRE_MIN`, default 60) plus a buffer, so
 *  a long-but-live run isn't false-flagged as abandoned in the activity view —
 *  only a genuinely orphaned trace (process crashed before writing a terminal
 *  status) gets reaped. */
const ABANDON_AFTER_MIN = (Number(process.env.MANTLE_EXTRACT_EXPIRE_MIN) || 60) + 15;

/**
 * Reconcile orphaned traces: mark long-`running` rows as `error: abandoned`
 * with a finish time. Without this they'd sit in `running` forever — showing
 * as "active" in the live view and skewing every "running" count. Owner-scoped
 * and idempotent (a no-op once nothing is stale), so it's safe to call on every
 * poll as a self-heal. Returns how many it reaped.
 */
export async function reapAbandonedTraces(userId: string): Promise<number> {
  const cutoff = new Date(Date.now() - ABANDON_AFTER_MIN * 60_000);
  const rows = await db
    .update(traces)
    .set({
      status: 'error',
      error: `abandoned — no completion after ${ABANDON_AFTER_MIN} min (the process likely restarted or crashed mid-run)`,
      finishedAt: new Date(),
      durationMs: sql`(extract(epoch from (now() - ${traces.startedAt})) * 1000)::int`,
    })
    .where(
      and(eq(traces.ownerId, userId), eq(traces.status, 'running'), lt(traces.startedAt, cutoff)),
    )
    .returning({ id: traces.id });
  return rows.length;
}

/** The always-on live snapshot: in-flight runs, recent successes (what entered
 *  the brain), and recent failures. Reconciles orphaned runs first so the
 *  "active" list reflects reality. */
export async function getLiveActivity(userId: string): Promise<LiveActivity> {
  await reapAbandonedTraces(userId);
  const [active, recent, failures] = await Promise.all([
    queryActivity(userId, [eq(traces.status, 'running') as never], 12),
    queryActivity(userId, [eq(traces.status, 'success') as never], 30),
    queryActivity(
      userId,
      [
        eq(traces.status, 'error') as never,
        gte(traces.startedAt, new Date(Date.now() - 24 * 3600_000)) as never,
      ],
      12,
    ),
  ]);
  return { active, recent, failures };
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
    .where(and(eq(facts.ownerId, userId), eq(facts.sourceNodeId, nodeId), isNull(facts.validTo)))
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

  // Graph relations this node drew between entities (entity↔entity, stamped
  // with source_node_id). Join both endpoints for a readable subject→object.
  const subjEnt = alias(entities, 'subj_ent');
  const objEnt = alias(entities, 'obj_ent');
  const relationRows = await db
    .select({ subject: subjEnt.name, relation: entityEdges.relation, object: objEnt.name })
    .from(entityEdges)
    .innerJoin(subjEnt, eq(entityEdges.sourceId, subjEnt.id))
    .innerJoin(objEnt, eq(entityEdges.targetId, objEnt.id))
    .where(
      and(eq(entityEdges.ownerId, userId), sql`${entityEdges.data}->>'source_node_id' = ${nodeId}`),
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
    relations: relationRows.map((r) => ({
      subject: r.subject,
      relation: r.relation,
      object: r.object,
    })),
  };
}
