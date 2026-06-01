/**
 * Read a node's structural footprint straight from the brain tables — the
 * TypeScript equivalent of `scripts/trace-node.sh`, returning exactly the
 * inputs the asserter needs: summary, embedding dims (to verify 768), tsv,
 * fact + entity counts, and the latest `extractor_run` trace + step names.
 *
 * Read-only. One round-trip per node plus the trace lookups.
 */
import { db, facts } from '@mantle/db';
import { and, eq, sql } from 'drizzle-orm';

import type { FactRef, ProbeFootprint } from './types';

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[];
}

type NodeRow = {
  type: string;
  summary: string | null;
  emb_dims: number | null;
  has_tsv: boolean;
  n_facts: number | string;
  fact_kinds: string[] | null;
  n_entities: number | string;
  dup_edges: number | string;
  n_chunks: number | string;
};

type RunRow = {
  id: string;
  started_at: string;
  status: string;
  disposition: string | null;
  cost_micro_usd: number | string;
};

const TERMINAL = new Set(['success', 'error', 'skipped']);

/** Load the current footprint. `run` is null until an extractor_run terminates. */
export async function loadProbeFootprint(
  ownerId: string,
  nodeId: string,
): Promise<ProbeFootprint> {
  const nodeRes = await db.execute<NodeRow>(sql`
    SELECT
      n.type::text                                          AS type,
      NULLIF(n.data->>'summary', '')                        AS summary,
      CASE WHEN n.embedding IS NULL THEN NULL
           ELSE vector_dims(n.embedding) END                AS emb_dims,
      (n.search_tsv IS NOT NULL)                            AS has_tsv,
      (SELECT count(*) FROM facts f
        WHERE f.source_node_id = n.id AND f.owner_id = ${ownerId}) AS n_facts,
      (SELECT coalesce(array_agg(DISTINCT f.kind::text), '{}') FROM facts f
        WHERE f.source_node_id = n.id AND f.owner_id = ${ownerId}) AS fact_kinds,
      (SELECT count(*) FROM entity_edges ed
        WHERE ed.target_id = n.id AND ed.target_kind = 'node'
          AND ed.relation = 'mentioned_in' AND ed.owner_id = ${ownerId}) AS n_entities,
      -- duplicate mentioned_in edges: same entity → node more than once. >0 means
      -- the extractor appended instead of delete-then-rebuilding (idempotency bug).
      (SELECT coalesce(sum(c - 1), 0) FROM (
         SELECT count(*) AS c FROM entity_edges ed
          WHERE ed.target_id = n.id AND ed.target_kind = 'node'
            AND ed.relation = 'mentioned_in' AND ed.owner_id = ${ownerId}
          GROUP BY ed.source_id HAVING count(*) > 1) d) AS dup_edges,
      (SELECT count(*) FROM content_chunks ch WHERE ch.node_id = n.id) AS n_chunks
    FROM nodes n
    WHERE n.id = ${nodeId} AND n.owner_id = ${ownerId}
    LIMIT 1
  `);
  const node = rowsOf<NodeRow>(nodeRes)[0];

  const runRes = await db.execute<RunRow>(sql`
    SELECT t.id, t.started_at, t.status::text AS status, t.data->>'disposition' AS disposition,
           t.cost_micro_usd
    FROM traces t
    WHERE t.subject_id = ${nodeId} AND t.owner_id = ${ownerId} AND t.kind = 'extractor_run'
    ORDER BY t.started_at DESC
    LIMIT 1
  `);
  const runRow = rowsOf<RunRow>(runRes)[0];

  let run: ProbeFootprint['run'] = null;
  if (runRow && TERMINAL.has(runRow.status)) {
    const stepRes = await db.execute<{ name: string }>(sql`
      SELECT s.name FROM trace_steps s WHERE s.trace_id = ${runRow.id} ORDER BY s.ordinal
    `);
    run = {
      traceId: runRow.id,
      startedAt: String(runRow.started_at),
      status: runRow.status,
      disposition: runRow.disposition,
      stepNames: rowsOf<{ name: string }>(stepRes).map((s) => s.name),
      costMicroUsd: Number(runRow.cost_micro_usd ?? 0),
    };
  }

  return {
    nodeId,
    exists: !!node,
    nodeType: node?.type ?? null,
    summary: node?.summary ?? null,
    embDims: node?.emb_dims ?? null,
    hasTsv: !!node?.has_tsv,
    nFacts: Number(node?.n_facts ?? 0),
    factKinds: node?.fact_kinds ?? [],
    nEntities: Number(node?.n_entities ?? 0),
    dupMentionEdges: Number(node?.dup_edges ?? 0),
    nChunks: Number(node?.n_chunks ?? 0),
    run,
  };
}

/** Fact ids + kinds currently sourced from this node — captured before a delete
 *  so the reaper's kind-aware behaviour can be verified afterward. */
export async function loadFactRefs(ownerId: string, nodeId: string): Promise<FactRef[]> {
  const rows = await db
    .select({ id: facts.id, kind: facts.kind })
    .from(facts)
    .where(and(eq(facts.ownerId, ownerId), eq(facts.sourceNodeId, nodeId)));
  return rows.map((r) => ({ id: r.id, kind: r.kind as string }));
}

/** Which of the given fact ids still exist (post-delete check). */
export async function existingFactIds(ownerId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { inArray } = await import('drizzle-orm');
  const rows = await db
    .select({ id: facts.id })
    .from(facts)
    .where(and(eq(facts.ownerId, ownerId), inArray(facts.id, ids)));
  return new Set(rows.map((r) => r.id));
}

/**
 * Poll until the node's latest `extractor_run` reaches a terminal status, or
 * `timeoutMs` elapses. Returns the final footprint either way; a null `run`
 * after timeout is the "stalled" signal (extractor never settled — is
 * apps/agent up?).
 */
export async function waitForExtractor(
  ownerId: string,
  nodeId: string,
  timeoutMs: number,
): Promise<ProbeFootprint> {
  const deadline = Date.now() + timeoutMs;
  let fp = await loadProbeFootprint(ownerId, nodeId);
  while (!fp.run && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 600));
    fp = await loadProbeFootprint(ownerId, nodeId);
  }
  return fp;
}

/**
 * After an edit, a *new* extractor_run fires while the prior one is already
 * terminal — so `waitForExtractor` would return the stale run immediately.
 * Poll until the latest run's trace id differs from `priorTraceId`.
 */
export async function waitForNewExtractor(
  ownerId: string,
  nodeId: string,
  priorTraceId: string | null,
  timeoutMs: number,
): Promise<ProbeFootprint> {
  const deadline = Date.now() + timeoutMs;
  let fp = await loadProbeFootprint(ownerId, nodeId);
  while ((!fp.run || fp.run.traceId === priorTraceId) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 600));
    fp = await loadProbeFootprint(ownerId, nodeId);
  }
  return fp;
}

export const EXPECTED_DIMS = 768;
