/**
 * Read a node's structural footprint straight from the brain tables — the
 * TypeScript equivalent of `scripts/trace-node.sh`, returning exactly the
 * inputs the asserter needs: summary, embedding dims (to verify 768), tsv,
 * fact + entity counts, and the latest `extractor_run` trace + step names.
 *
 * Read-only. One round-trip per node plus the trace lookups.
 */
import { db } from '@mantle/db';
import { sql } from 'drizzle-orm';

import type { ProbeFootprint } from './types';

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
};

type RunRow = { id: string; status: string; disposition: string | null; cost_micro_usd: number | string };

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
          AND ed.relation = 'mentioned_in' AND ed.owner_id = ${ownerId}) AS n_entities
    FROM nodes n
    WHERE n.id = ${nodeId} AND n.owner_id = ${ownerId}
    LIMIT 1
  `);
  const node = rowsOf<NodeRow>(nodeRes)[0];

  const runRes = await db.execute<RunRow>(sql`
    SELECT t.id, t.status::text AS status, t.data->>'disposition' AS disposition,
           t.cost_micro_usd
    FROM traces t
    WHERE t.subject_id = ${nodeId} AND t.kind = 'extractor_run'
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
    run,
  };
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

export const EXPECTED_DIMS = 768;
