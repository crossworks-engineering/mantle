/**
 * Passive corpus audit — read-only invariant checks over the existing brain.
 *
 * Each check is one aggregate query returning offending rows ({id, kind,
 * detail}); the runner caps the result and derives count + samples. Pure
 * SELECTs, owner-scoped, no writes, ~free. This is the standing health monitor:
 * it watches your *real* data, complementing the probe (which proves the write
 * path on synthetic fixtures). See docs/data-flow-tracing.md for the invariants
 * these encode.
 *
 * Per-type nuance matters here just like the probe's expectation matrix — e.g.
 * sourceless semantic/preference facts are CORRECT (the reaper keeps them), so
 * the reaper-miss check only flags episodic/factual orphans.
 */
import { db } from '@mantle/db';
import { sql, type SQL } from 'drizzle-orm';

import { rowsOf } from './sql-util';
import type { AuditCheck, AuditReport, AuditSeverity } from './types';

const CAP = 200;

type Row = { id: string; kind: string; detail: string };
type CheckDef = {
  key: string;
  label: string;
  severity: AuditSeverity;
  note: string;
  query: (ownerId: string) => SQL;
};

const CHECKS: CheckDef[] = [
  {
    key: 'silent_miss',
    label: 'Silent-miss nodes',
    severity: 'high',
    note: 'extractor_run succeeded but no summary landed — the LLM ran (cost spent) yet its output was unusable. Invisible in /traces; only the corpus betrays it.',
    query: (o) => sql`
      SELECT n.id, n.type::text AS kind, left(coalesce(n.title, ''), 60) AS detail
      FROM nodes n
      JOIN LATERAL (
        SELECT t.status FROM traces t
        WHERE t.subject_id = n.id AND t.owner_id = ${o} AND t.kind = 'extractor_run'
        ORDER BY t.started_at DESC LIMIT 1
      ) lt ON true
      WHERE n.owner_id = ${o} AND lt.status = 'success'
        AND nullif(n.data->>'summary', '') IS NULL
      LIMIT ${CAP}`,
  },
  {
    key: 'emb_dim_drift',
    label: 'Embedding dimension drift',
    severity: 'high',
    note: 'a vector whose dimension is not 768 — a corner of the brain in an incompatible space, silently returning garbage on similarity search. The key post-migration invariant.',
    query: (o) => sql`
      SELECT id, 'node' AS kind, vector_dims(embedding)::text AS detail
        FROM nodes WHERE owner_id = ${o} AND embedding IS NOT NULL AND vector_dims(embedding) <> 768
      UNION ALL
      SELECT id, 'fact', vector_dims(embedding)::text
        FROM facts WHERE owner_id = ${o} AND embedding IS NOT NULL AND vector_dims(embedding) <> 768
      UNION ALL
      SELECT id, 'entity', vector_dims(embedding)::text
        FROM entities WHERE owner_id = ${o} AND embedding IS NOT NULL AND vector_dims(embedding) <> 768
      LIMIT ${CAP}`,
  },
  {
    key: 'half_indexed',
    label: 'Half-indexed nodes',
    severity: 'medium',
    note: 'summary present but no embedding, or vice-versa — a successful extraction writes both. Exactly one means the index write was interrupted.',
    query: (o) => sql`
      SELECT n.id, n.type::text AS kind,
             CASE WHEN n.embedding IS NULL THEN 'summary, no embedding' ELSE 'embedding, no summary' END AS detail
      FROM nodes n
      WHERE n.owner_id = ${o}
        AND (nullif(n.data->>'summary', '') IS NOT NULL) <> (n.embedding IS NOT NULL)
      LIMIT ${CAP}`,
  },
  {
    key: 'unembedded_facts',
    label: 'Unembedded facts',
    severity: 'medium',
    note: 'a fact with no embedding is invisible to vector retrieval — every fact should be embedded at write time.',
    query: (o) => sql`
      SELECT id, kind::text AS kind, left(content, 60) AS detail
      FROM facts WHERE owner_id = ${o} AND embedding IS NULL LIMIT ${CAP}`,
  },
  {
    key: 'reaper_miss_facts',
    label: 'Reaper-miss facts',
    severity: 'high',
    note: 'episodic/factual facts with no source node — these should have been hard-deleted when their source was (reaper 0059). Sourceless semantic/preference facts are correct and excluded.',
    query: (o) => sql`
      SELECT id, kind::text AS kind, left(content, 60) AS detail
      FROM facts
      WHERE owner_id = ${o} AND source_node_id IS NULL AND kind IN ('episodic', 'factual')
      LIMIT ${CAP}`,
  },
  {
    key: 'duplicate_edges',
    label: 'Duplicate mentioned_in edges',
    severity: 'medium',
    note: 'the same entity → node edge stored more than once — a historical extract appended instead of delete-then-rebuilding. The corpus-wide version of the probe idempotency check.',
    query: (o) => sql`
      SELECT min(id::text) AS id, 'entity_edge' AS kind, (count(*) || '×') AS detail
      FROM entity_edges
      WHERE owner_id = ${o} AND relation = 'mentioned_in'
      GROUP BY source_id, target_id, relation
      HAVING count(*) > 1
      LIMIT ${CAP}`,
  },
  {
    key: 'orphan_entities',
    label: 'Orphan entities',
    severity: 'low',
    note: 'an entity with zero edges and zero facts — reconciliation residue or delete leftovers. Clutter that also skews graph stats.',
    query: (o) => sql`
      SELECT e.id, 'entity' AS kind, e.name AS detail
      FROM entities e
      WHERE e.owner_id = ${o}
        AND NOT EXISTS (SELECT 1 FROM entity_edges ed WHERE ed.source_id = e.id OR ed.target_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.entity_id = e.id)
      LIMIT ${CAP}`,
  },
  {
    key: 'over_merged_entities',
    label: 'Over-merged entities',
    severity: 'low',
    note: 'an entity carrying many aliases — a smell for the reconciler having collapsed distinct people/things (the Don/Jason Schoeman case). Heuristic, not a hard error.',
    query: (o) => sql`
      SELECT id, 'entity' AS kind, (name || ' — ' || coalesce(array_length(aliases, 1), 0) || ' aliases') AS detail
      FROM entities WHERE owner_id = ${o} AND coalesce(array_length(aliases, 1), 0) > 8
      LIMIT ${CAP}`,
  },
  {
    key: 'abandoned_traces',
    label: 'Abandoned traces',
    severity: 'low',
    note: "traces stuck 'running' past the 10-min reap threshold — a process died mid-run. The journey poller reaps these; a non-zero count here flags the rate.",
    query: (o) => sql`
      SELECT id, kind::text AS kind, to_char(started_at, 'MM-DD HH24:MI') AS detail
      FROM traces
      WHERE owner_id = ${o} AND status = 'running' AND started_at < now() - interval '10 minutes'
      LIMIT ${CAP}`,
  },
];

export async function runCorpusAudit(ownerId: string): Promise<AuditReport> {
  const checks: AuditCheck[] = [];
  for (const def of CHECKS) {
    const rows = rowsOf<Row>(await db.execute<Row>(def.query(ownerId)));
    const capped = rows.length >= CAP;
    checks.push({
      key: def.key,
      label: def.label,
      severity: def.severity,
      note: def.note,
      count: rows.length,
      capped,
      ok: rows.length === 0,
      samples: rows.slice(0, 5),
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    checks,
    totalViolations: checks.reduce((s, c) => s + c.count, 0),
  };
}
