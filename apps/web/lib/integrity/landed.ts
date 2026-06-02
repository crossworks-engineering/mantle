/**
 * Live landed view — the passive, real-data replacement for the synthetic
 * integrity probe.
 *
 * `listLanded` pulls the most-recent real content nodes the user added (notes,
 * pages, todos, events, contacts, secrets, files, email) together with their
 * structural footprint (summary · embedding dims · tsv · fact/entity counts ·
 * the TS equivalent of `scripts/trace-node.sh`, batched into one query) and the
 * latest `extractor_run`. `evaluateLanded` turns each
 * footprint into the simple "did it touch the right part of the brain?" check
 * pills — outcome-aware, so a *correct* skip reads neutral, not red.
 *
 * Read-only except `deleteLandedNode`, which removes a real node via the same
 * cascade + reaper path the rest of the app uses. There are no fixtures and
 * nothing to clean up, so leaving the screen mid-anything is harmless.
 */
import { db, sql } from '@mantle/db';
import { deleteFileById } from '@mantle/files';

import { evaluateLanded } from './evaluate-landed';
import { rowsOf } from './sql-util';
import type { LandedItem, ProbeFootprint } from './types';

export { evaluateLanded } from './evaluate-landed';

/** The node types that represent content the user adds and that gets indexed.
 *  Telegram messages are deliberately excluded — they're unembedded by design,
 *  so they'd always read as "unindexed" noise here. */
export const LANDED_TYPES = [
  'note',
  'page',
  'task',
  'event',
  'contact',
  'secret',
  'file',
  'email',
] as const;

/** A run is only meaningful once it has terminated. */
const TERMINAL = new Set(['success', 'error', 'skipped']);

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

type LandedRow = {
  id: string;
  type: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  summary: string | null;
  emb_dims: number | null;
  has_tsv: boolean;
  n_facts: number | string;
  fact_kinds: string[] | null;
  n_entities: number | string;
  dup_edges: number | string;
  n_chunks: number | string;
  run_id: string | null;
  run_started_at: string | null;
  run_status: string | null;
  run_disposition: string | null;
  run_cost: number | string | null;
  run_steps: string[] | null;
};

export type ListLandedOpts = { limit?: number; types?: readonly string[] };

/**
 * The N most-recent real content nodes + their brain footprint, newest first.
 * One round-trip: the footprint columns read straight from the brain tables, the
 * latest extractor_run is a LATERAL join, and step names come from a correlated
 * array.
 */
export async function listLanded(ownerId: string, opts: ListLandedOpts = {}): Promise<LandedItem[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const types = (opts.types?.length ? opts.types : LANDED_TYPES) as readonly string[];
  const typeArr = sql`ARRAY[${sql.join(types.map((t) => sql`${t}`), sql`, `)}]::text[]`;

  const res = await db.execute<LandedRow>(sql`
    SELECT
      n.id,
      n.type::text                                          AS type,
      n.title,
      n.created_at,
      n.updated_at,
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
      (SELECT coalesce(sum(c - 1), 0) FROM (
         SELECT count(*) AS c FROM entity_edges ed
          WHERE ed.target_id = n.id AND ed.target_kind = 'node'
            AND ed.relation = 'mentioned_in' AND ed.owner_id = ${ownerId}
          GROUP BY ed.source_id HAVING count(*) > 1) d)     AS dup_edges,
      (SELECT count(*) FROM content_chunks ch WHERE ch.node_id = n.id) AS n_chunks,
      run.id                                                AS run_id,
      run.started_at                                        AS run_started_at,
      run.status::text                                      AS run_status,
      run.data->>'disposition'                              AS run_disposition,
      run.cost_micro_usd                                    AS run_cost,
      (SELECT coalesce(array_agg(s.name ORDER BY s.ordinal), '{}')
         FROM trace_steps s WHERE s.trace_id = run.id)      AS run_steps
    FROM nodes n
    LEFT JOIN LATERAL (
      SELECT t.id, t.started_at, t.status, t.data, t.cost_micro_usd
      FROM traces t
      WHERE t.subject_id = n.id AND t.owner_id = ${ownerId} AND t.kind = 'extractor_run'
      ORDER BY t.started_at DESC
      LIMIT 1
    ) run ON true
    WHERE n.owner_id = ${ownerId}
      AND n.type::text = ANY(${typeArr})
      -- Conversation digests are Saskia-authored notes, not content the user added.
      AND NOT (n.type = 'note' AND 'conversation-digest' = ANY(n.tags))
    ORDER BY GREATEST(n.created_at, n.updated_at) DESC
    LIMIT ${limit}
  `);

  const now = Date.now();
  return rowsOf<LandedRow>(res).map((r) => rowToItem(r, now));
}

function rowToItem(r: LandedRow, now: number): LandedItem {
  const hasTerminalRun = !!r.run_id && !!r.run_status && TERMINAL.has(r.run_status);
  const footprint: ProbeFootprint = {
    nodeId: r.id,
    exists: true,
    nodeType: r.type,
    summary: r.summary ?? null,
    embDims: r.emb_dims ?? null,
    hasTsv: !!r.has_tsv,
    nFacts: Number(r.n_facts ?? 0),
    factKinds: r.fact_kinds ?? [],
    nEntities: Number(r.n_entities ?? 0),
    dupMentionEdges: Number(r.dup_edges ?? 0),
    nChunks: Number(r.n_chunks ?? 0),
    run: hasTerminalRun
      ? {
          traceId: r.run_id as string,
          startedAt: String(r.run_started_at),
          status: r.run_status as string,
          disposition: r.run_disposition,
          stepNames: r.run_steps ?? [],
          costMicroUsd: Number(r.run_cost ?? 0),
        }
      : null,
  };
  const ageMs = now - new Date(r.updated_at).getTime();
  const { state, checks } = evaluateLanded(footprint, ageMs);
  return {
    nodeId: r.id,
    nodeType: r.type,
    title: r.title?.trim() || '(untitled)',
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    footprint,
    state,
    checks,
  };
}

export type DeleteLandedResult = { ok: boolean; type?: string; error?: string };

/**
 * Delete one real node and its brain footprint via the same path the rest of
 * the app uses: file nodes through `deleteFileById` (also removes disk bytes),
 * everything else by id (FK cascade + the kind-aware reaper triggers 0058/0059
 * handle edges/chunks/facts). Traces have no reaper, so we clear them too.
 */
export async function deleteLandedNode(ownerId: string, nodeId: string): Promise<DeleteLandedResult> {
  const row = rowsOf<{ type: string }>(
    await db.execute(sql`SELECT type::text AS type FROM nodes WHERE id = ${nodeId} AND owner_id = ${ownerId} LIMIT 1`),
  )[0];
  if (!row) return { ok: false, error: 'node not found' };

  // Traces first (no FK to nodes; trace_steps cascade from traces).
  await db.execute(sql`DELETE FROM traces WHERE subject_id = ${nodeId} AND owner_id = ${ownerId}`);

  if (row.type === 'file') {
    const res = await deleteFileById({ ownerId, fileId: nodeId });
    if (!res.ok) return { ok: false, type: row.type, error: 'file delete failed' };
    return { ok: true, type: row.type };
  }

  await db.execute(sql`DELETE FROM nodes WHERE id = ${nodeId} AND owner_id = ${ownerId}`);
  return { ok: true, type: row.type };
}
