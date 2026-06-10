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
  /** Optional uncapped aggregate returning a single `{ oldest, newest }` row
   *  (`YYYY-MM-DD` text) over the SAME predicate — the true age span of the
   *  violations, used to flag sediment vs. a live regression. Omit for checks
   *  with no natural timestamp (e.g. dimension drift across three tables). */
  spanQuery?: (ownerId: string) => SQL;
};

type SpanRow = { oldest: string | null; newest: string | null };

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
    spanQuery: (o) => sql`
      SELECT min(n.created_at)::date::text AS oldest, max(n.created_at)::date::text AS newest
      FROM nodes n
      JOIN LATERAL (
        SELECT t.status FROM traces t
        WHERE t.subject_id = n.id AND t.owner_id = ${o} AND t.kind = 'extractor_run'
        ORDER BY t.started_at DESC LIMIT 1
      ) lt ON true
      WHERE n.owner_id = ${o} AND lt.status = 'success'
        AND nullif(n.data->>'summary', '') IS NULL`,
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
    note: 'summary present but no embedding (an interrupted index write), or embedding present but no summary. Excludes types that opt out of embedding by design (telegram_message) and the no-summary direction for files (an image/binary with no text layer legitimately has no summary — silent_miss covers the real extractor-success-without-summary case). Conversation-digest notes ARE included since 2026-06-10: the summarizer embeds them at insert (find_window cosine-ranks digests), so an un-embedded digest is a real gap — heal with `pnpm -C apps/web backfill:digest-embeddings --apply`.',
    query: (o) => sql`
      SELECT n.id, n.type::text AS kind,
             CASE WHEN n.embedding IS NULL THEN 'summary, no embedding' ELSE 'embedding, no summary' END AS detail
      FROM nodes n
      WHERE n.owner_id = ${o}
        -- Types deliberately NOT vector-embedded, so the summary↔embedding
        -- co-presence invariant doesn't apply: telegram messages (arch §16).
        -- (Digest notes used to be excluded here too — they're embedded at
        -- insert now, so the invariant applies to them again.)
        AND n.type <> 'telegram_message'
        AND (
          -- summary written but embedding missing: a real interrupted index write.
          (nullif(n.data->>'summary', '') IS NOT NULL AND n.embedding IS NULL)
          OR
          -- embedding written but summary missing: a real gap — except files,
          -- where an image/binary with no extractable text correctly has no
          -- summary (silent_miss flags the extractor-succeeded-but-empty case).
          (n.embedding IS NOT NULL AND nullif(n.data->>'summary', '') IS NULL AND n.type <> 'file')
        )
      LIMIT ${CAP}`,
    spanQuery: (o) => sql`
      SELECT min(n.created_at)::date::text AS oldest, max(n.created_at)::date::text AS newest
      FROM nodes n
      WHERE n.owner_id = ${o}
        AND n.type <> 'telegram_message'
        AND (
          (nullif(n.data->>'summary', '') IS NOT NULL AND n.embedding IS NULL)
          OR
          (n.embedding IS NOT NULL AND nullif(n.data->>'summary', '') IS NULL AND n.type <> 'file')
        )`,
  },
  {
    key: 'unembedded_facts',
    label: 'Unembedded facts',
    severity: 'medium',
    note: 'a currently-valid fact with no embedding is invisible to vector retrieval — every live fact should be embedded at write time. Retired facts (valid_to set) are excluded: they are superseded history, never queried, and the re-embed walk skips them too.',
    query: (o) => sql`
      SELECT id, kind::text AS kind, left(content, 60) AS detail
      FROM facts WHERE owner_id = ${o} AND embedding IS NULL AND valid_to IS NULL LIMIT ${CAP}`,
    spanQuery: (o) => sql`
      SELECT min(created_at)::date::text AS oldest, max(created_at)::date::text AS newest
      FROM facts WHERE owner_id = ${o} AND embedding IS NULL AND valid_to IS NULL`,
  },
  {
    key: 'reaper_miss_facts',
    label: 'Reaper-miss facts',
    severity: 'high',
    note: 'RETIRED episodic/factual facts with no source node — superseded history whose source is also gone, which the reaper (0059) should have hard-deleted. CURRENTLY-VALID sourceless facts are deliberately NOT flagged: when a source node is deleted (FK ON DELETE SET NULL), a still-valid fact it produced is real, irreplaceable knowledge — deleting it would lose data, so it is preserved, not reaped. Sourceless semantic/preference facts are correct and excluded entirely.',
    query: (o) => sql`
      SELECT id, kind::text AS kind, left(content, 60) AS detail
      FROM facts
      WHERE owner_id = ${o} AND source_node_id IS NULL AND kind IN ('episodic', 'factual')
        AND valid_to IS NOT NULL
      LIMIT ${CAP}`,
    spanQuery: (o) => sql`
      SELECT min(created_at)::date::text AS oldest, max(created_at)::date::text AS newest
      FROM facts
      WHERE owner_id = ${o} AND source_node_id IS NULL AND kind IN ('episodic', 'factual')
        AND valid_to IS NOT NULL`,
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
    spanQuery: (o) => sql`
      SELECT min(created_at)::date::text AS oldest, max(created_at)::date::text AS newest
      FROM entity_edges e
      WHERE owner_id = ${o} AND relation = 'mentioned_in'
        AND EXISTS (
          SELECT 1 FROM entity_edges d
          WHERE d.owner_id = e.owner_id AND d.relation = 'mentioned_in'
            AND d.source_id = e.source_id AND d.target_id = e.target_id
          GROUP BY d.source_id, d.target_id HAVING count(*) > 1
        )`,
  },
  {
    key: 'orphan_entities',
    label: 'Orphan entities',
    severity: 'low',
    note: 'a NAMELESS, alias-less entity with zero edges and zero facts — true reconciliation residue (a husk left by a merge), useless even for entity_search. A NAMED but disconnected entity (Alan Kay, a project, a place) is real, searchable data — not residue — so it is deliberately NOT flagged; missing mention edges are a graph-completeness gap, not clutter to delete.',
    query: (o) => sql`
      SELECT e.id, 'entity' AS kind, coalesce(nullif(btrim(e.name), ''), '(unnamed)') AS detail
      FROM entities e
      WHERE e.owner_id = ${o}
        AND (e.name IS NULL OR btrim(e.name) = '')
        AND coalesce(array_length(e.aliases, 1), 0) = 0
        AND NOT EXISTS (SELECT 1 FROM entity_edges ed WHERE ed.source_id = e.id OR ed.target_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.entity_id = e.id)
      LIMIT ${CAP}`,
    spanQuery: (o) => sql`
      SELECT min(e.created_at)::date::text AS oldest, max(e.created_at)::date::text AS newest
      FROM entities e
      WHERE e.owner_id = ${o}
        AND (e.name IS NULL OR btrim(e.name) = '')
        AND coalesce(array_length(e.aliases, 1), 0) = 0
        AND NOT EXISTS (SELECT 1 FROM entity_edges ed WHERE ed.source_id = e.id OR ed.target_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.entity_id = e.id)`,
  },
  {
    key: 'over_merged_entities',
    label: 'Over-merged entities',
    severity: 'low',
    note: 'an entity carrying many aliases — a smell for the reconciler having collapsed distinct people/things (the Don/Alex Carter case). Heuristic, not a hard error.',
    query: (o) => sql`
      SELECT id, 'entity' AS kind, (name || ' — ' || coalesce(array_length(aliases, 1), 0) || ' aliases') AS detail
      FROM entities WHERE owner_id = ${o} AND coalesce(array_length(aliases, 1), 0) > 8
      LIMIT ${CAP}`,
    spanQuery: (o) => sql`
      SELECT min(created_at)::date::text AS oldest, max(created_at)::date::text AS newest
      FROM entities WHERE owner_id = ${o} AND coalesce(array_length(aliases, 1), 0) > 8`,
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
    spanQuery: (o) => sql`
      SELECT min(started_at)::date::text AS oldest, max(started_at)::date::text AS newest
      FROM traces
      WHERE owner_id = ${o} AND status = 'running' AND started_at < now() - interval '10 minutes'`,
  },
];

export async function runCorpusAudit(ownerId: string): Promise<AuditReport> {
  const checks: AuditCheck[] = [];
  for (const def of CHECKS) {
    const rows = rowsOf<Row>(await db.execute<Row>(def.query(ownerId)));
    const capped = rows.length >= CAP;
    // Resolve the true age span only when there's something to date — an
    // uncapped aggregate, so the range is accurate even when `count` is floored.
    let oldestAt: string | null = null;
    let newestAt: string | null = null;
    if (rows.length > 0 && def.spanQuery) {
      const span = rowsOf<SpanRow>(await db.execute<SpanRow>(def.spanQuery(ownerId)))[0];
      oldestAt = span?.oldest ?? null;
      newestAt = span?.newest ?? null;
    }
    checks.push({
      key: def.key,
      label: def.label,
      severity: def.severity,
      note: def.note,
      count: rows.length,
      capped,
      ok: rows.length === 0,
      samples: rows.slice(0, 5),
      oldestAt,
      newestAt,
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    checks,
    totalViolations: checks.reduce((s, c) => s + c.count, 0),
  };
}
