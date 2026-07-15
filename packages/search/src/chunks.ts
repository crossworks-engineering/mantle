/**
 * Chunk-level retrieval (Phase 4). Where `searchNodes` ranks whole nodes,
 * this finds the most relevant *passage* inside a long page / file / email,
 * joined back to its node for title/type/scope. Caller supplies a precomputed
 * query embedding so this package stays dependency-light (no embeddings dep).
 *
 * Two modes, mirroring `searchNodes`:
 *  - **hybrid** (when `q` is set): weighted RRF of the salience-adjusted
 *    vector pool and an FTS pool over `content_chunks.search_tsv`. Vector is
 *    the spine; FTS is a down-weighted booster that rescues exact-term
 *    queries — the recall audit caught a coined term present verbatim in 6
 *    chunks that pure vector search twice declared absent.
 *  - **vector-only** (no `q`): the original behaviour, unchanged.
 */
import { and, asc, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import { contentChunks, db, nodes } from '@mantle/db';
import { withHnswPool } from './hnsw';
import { grantUnionFilter, pgArrayLiteral } from './pg';
import { applyRescueFloor, fuseRrf } from './rrf';

/** Salience down-weight strength (see @mantle/search index). Tunable via env. */
const SALIENCE_LAMBDA = Number(process.env.MANTLE_SALIENCE_LAMBDA ?? 0.15);

export type ChunkHit = {
  nodeId: string;
  nodeTitle: string;
  nodeType: string;
  ordinal: number;
  headingPath: string | null;
  text: string;
  /** Cosine distance — lower = closer. */
  distance: number;
};

export type ChunkSearchOptions = {
  ownerId: string;
  embedding: number[];
  /**
   * The query TEXT. When set, ranking goes hybrid: weighted RRF of the vector
   * pool and a full-text pool, so an exact rare token (error code, field name,
   * coined term) is findable even when it embeds poorly. Without it the
   * original pure-vector ranking runs — callers that have no query string
   * (federation's embedding-only wire format) keep their behaviour.
   */
  q?: string;
  /** Vector vs FTS weight in the hybrid blend, 0..1. Default 0.7 — vector-led,
   *  same rationale as searchNodes (equal-weight fusion regresses; FTS only
   *  breaks ties / rescues exact-term queries). */
  semanticWeight?: number;
  /** Restrict to an ltree branch prefix (e.g. "pages"). */
  branch?: string;
  limit?: number;
  /** Drop chunks from system-seeded docs (origin='system'). The responder's
   *  auto-context sets this so Mantle's own documentation isn't injected as "your
   *  content"; the explicit search_chunks tool leaves it off (docs are findable). */
  excludeSystemOrigin?: boolean;
  /**
   * Hard allowlist of parent node ids — passages are strictly a subset. Used by
   * the federation surface to search exactly the peer's granted set
   * (`peer_shares`). An empty array matches nothing (safe default).
   */
  nodeIds?: string[];
  /**
   * Grant-union allowlist: passages whose parent node satisfies (id ∈ ids) OR
   * (type ∈ types). Carries the peer's explicit node grants plus its standing
   * category grants (`peer_share_scopes`) as one query-time predicate. Both
   * arrays empty ⇒ matches nothing (safe default).
   */
  nodeIdsOrTypes?: { ids: string[]; types: string[] };
};

export async function searchChunks(opts: ChunkSearchOptions): Promise<ChunkHit[]> {
  const vec = JSON.stringify(opts.embedding);
  const limit = opts.limit ?? 10;
  // Candidate pool for the salience re-rank, same sizing as searchNodes.
  const pool = Math.min(Math.max(limit * 5, 50), 200);
  // Node-side scope filters shared by both ranking arms. Embedding presence is
  // NOT part of the shared scope: the vector arm requires it, but the FTS arm
  // must still find a chunk whose embed failed (keyword is its only signal).
  const scope: SQL[] = [eq(contentChunks.ownerId, opts.ownerId)];
  if (opts.branch) scope.push(sql`${nodes.path} <@ ${opts.branch}::ltree`);
  if (opts.excludeSystemOrigin) scope.push(sql`(${nodes.data}->>'origin') is distinct from 'system'`);
  if (opts.nodeIds)
    scope.push(sql`${contentChunks.nodeId} = any(${pgArrayLiteral(opts.nodeIds)}::uuid[])`);
  if (opts.nodeIdsOrTypes) scope.push(grantUnionFilter(contentChunks.nodeId, opts.nodeIdsOrTypes));

  const q = opts.q?.trim();

  // ── Vector-only path (no query text): original behaviour, unchanged. ──────
  // Rank by salience-adjusted distance so a bulk/marketing email's passages
  // can't outrank real content; the returned `distance` stays raw cosine. The
  // adjustment is applied by re-ranking an index-eligible bare-distance pool —
  // adjusting the scan's ORDER BY itself would disqualify the HNSW index and
  // full-scan the chunk table at scale (see hnsw.ts). Join filters stay inside
  // the inner query so iterative scan keeps walking until the pool is full.
  if (!q) {
    const conds = [...scope, isNotNull(contentChunks.embedding)];
    const rows = (await withHnswPool(pool, (tx) =>
      tx.execute(sql`
        select node_id, node_title, node_type, ordinal, heading_path, text, dist from (
          select ${contentChunks.nodeId} as node_id, ${nodes.title} as node_title,
                 ${nodes.type} as node_type, ${contentChunks.ordinal} as ordinal,
                 ${contentChunks.headingPath} as heading_path, ${contentChunks.text} as text,
                 ${nodes.salience} as salience,
                 ${contentChunks.embedding} <=> ${vec}::vector as dist
          from ${contentChunks}
          inner join ${nodes} on ${nodes.id} = ${contentChunks.nodeId}
          where ${and(...conds)}
          order by ${contentChunks.embedding} <=> ${vec}::vector
          limit ${pool}
        ) c
        order by dist + ${SALIENCE_LAMBDA} * (1 - salience)
        limit ${limit}
      `),
    )) as unknown as RawChunkRow[];
    return rows.map(toChunkHit);
  }

  // ── Hybrid path: fuse the vector pool with an FTS pool via weighted RRF. ──
  // Same recipe/constants as searchNodes (vector spine, FTS booster). Both
  // arms return chunk IDs only; the winners are hydrated once, in fused order.
  const wVec = opts.semanticWeight ?? 0.7;
  const wFts = 1 - wVec;

  const vectorRows = (await withHnswPool(pool, (tx) =>
    tx.execute(sql`
      select id from (
        select ${contentChunks.id} as id, ${nodes.salience} as salience,
               ${contentChunks.embedding} <=> ${vec}::vector as dist
        from ${contentChunks}
        inner join ${nodes} on ${nodes.id} = ${contentChunks.nodeId}
        where ${and(...scope, isNotNull(contentChunks.embedding))}
        order by ${contentChunks.embedding} <=> ${vec}::vector
        limit ${pool}
      ) c
      order by dist + ${SALIENCE_LAMBDA} * (1 - salience)
      limit ${pool}
    `),
  )) as unknown as Array<{ id: string }>;

  const ftsRows = await db
    .select({ id: contentChunks.id })
    .from(contentChunks)
    .innerJoin(nodes, eq(nodes.id, contentChunks.nodeId))
    .where(and(...scope, sql`${contentChunks.searchTsv} @@ plainto_tsquery('english', ${q})`))
    .orderBy(sql`ts_rank(${contentChunks.searchTsv}, plainto_tsquery('english', ${q})) desc`)
    .limit(pool);

  const ftsIds = ftsRows.map((r) => r.id);
  const fused = fuseRrf(
    [
      { ids: vectorRows.map((r) => r.id), weight: wVec },
      { ids: ftsIds, weight: wFts },
    ],
    limit,
  );
  // Down-weighted RRF can't lift an FTS-only hit into a small cut when the
  // vector pool is full (see applyRescueFloor) — guarantee the top keyword
  // matches a tail slot so the exact-term rescue actually happens.
  const topIds = applyRescueFloor(fused, ftsIds, limit);
  if (topIds.length === 0) return [];

  // Hydrate the winners. `distance` stays raw cosine; an FTS-only rescue whose
  // embedding is missing reports 1.0 (the "no vector signal" ceiling) so
  // downstream cutoffs treat it conservatively rather than crashing on null.
  const hydrated = (await db.execute(sql`
    select ${contentChunks.id} as id, ${contentChunks.nodeId} as node_id,
           ${nodes.title} as node_title, ${nodes.type} as node_type,
           ${contentChunks.ordinal} as ordinal,
           ${contentChunks.headingPath} as heading_path, ${contentChunks.text} as text,
           coalesce(${contentChunks.embedding} <=> ${vec}::vector, 1) as dist
    from ${contentChunks}
    inner join ${nodes} on ${nodes.id} = ${contentChunks.nodeId}
    where ${contentChunks.id} = any(${pgArrayLiteral(topIds)}::uuid[])
  `)) as unknown as Array<RawChunkRow & { id: string }>;
  const byId = new Map(hydrated.map((r) => [r.id, r]));
  return topIds
    .map((id) => byId.get(id))
    .filter((r): r is RawChunkRow & { id: string } => Boolean(r))
    .map(toChunkHit);
}

type RawChunkRow = {
  node_id: string;
  node_title: string;
  node_type: string;
  ordinal: number;
  heading_path: string | null;
  text: string;
  dist: number;
};

const toChunkHit = (r: RawChunkRow): ChunkHit => ({
  nodeId: r.node_id,
  nodeTitle: r.node_title,
  nodeType: r.node_type,
  ordinal: r.ordinal,
  headingPath: r.heading_path,
  text: r.text,
  // postgres-js returns numerics as numbers here, but coalesce(...) can come
  // back as a string on some driver paths — normalize defensively.
  distance: typeof r.dist === 'number' ? r.dist : Number(r.dist),
});

// ─── Section reading (the rung between a passage and the whole file) ──────────
//
// `searchChunks` finds WHERE an answer lives (a few scattered passages);
// `file_read`/`node_read` load the ENTIRE document. The gap between them is the
// expensive one: when the answer turns on a full procedure/clause/table, the
// model — wanting complete, in-order context — has only "the whole file" to
// reach for, which overflows the tool-result ceiling, spills, and gets re-sent
// every loop iteration (the dominant token sink, see docs/recall-eval.md). This
// fills the gap: read one SECTION in full and in order, at section cost. The
// chunk index already carries `ordinal` + `heading_path`, so it's a plain query.
// Selection + assembly are factored out as pure functions so they unit-test
// without a DB (house style: the DB wrapper is verified live).

/** A contiguous run of passages under one heading — the outline a reader uses
 *  to decide what to read next. */
export type SectionRange = {
  heading: string | null;
  fromOrdinal: number;
  toOrdinal: number;
  passages: number;
};

/** Group consecutive same-heading, contiguous-ordinal passages into ranges
 *  (pure). Two non-adjacent runs that happen to share a heading stay separate
 *  ranges — each is independently readable by its ordinal span. */
export function buildSectionOutline(
  chunks: ReadonlyArray<{ ordinal: number; heading: string | null }>,
): SectionRange[] {
  const out: SectionRange[] = [];
  for (const c of chunks) {
    const last = out[out.length - 1];
    if (last && last.heading === c.heading && c.ordinal === last.toOrdinal + 1) {
      last.toOrdinal = c.ordinal;
      last.passages += 1;
    } else {
      out.push({ heading: c.heading, fromOrdinal: c.ordinal, toOrdinal: c.ordinal, passages: 1 });
    }
  }
  return out;
}

/** Pick the passages a section request selects (pure): by `heading` substring
 *  (case-insensitive) OR by an ordinal range. Returns them in ordinal order, or
 *  an error string when the selector matches nothing / is absent. */
export function selectSectionChunks<T extends { ordinal: number; heading: string | null }>(
  chunks: ReadonlyArray<T>,
  sel: { heading?: string; fromOrdinal?: number; toOrdinal?: number },
): T[] | { error: string } {
  const heading = sel.heading?.trim();
  if (heading) {
    const needle = heading.toLowerCase();
    const hits = chunks.filter((c) => (c.heading ?? '').toLowerCase().includes(needle));
    if (hits.length === 0)
      return {
        error: `no passage under a heading matching "${heading}" — call read_section with only node_id to see the outline of available headings`,
      };
    return [...hits].sort((a, b) => a.ordinal - b.ordinal);
  }
  const hasRange = typeof sel.fromOrdinal === 'number' || typeof sel.toOrdinal === 'number';
  if (hasRange) {
    const a0 = typeof sel.fromOrdinal === 'number' ? sel.fromOrdinal : (sel.toOrdinal as number);
    const b0 = typeof sel.toOrdinal === 'number' ? sel.toOrdinal : (sel.fromOrdinal as number);
    const [lo, hi] = a0 <= b0 ? [a0, b0] : [b0, a0];
    const hits = chunks.filter((c) => c.ordinal >= lo && c.ordinal <= hi);
    if (hits.length === 0)
      return {
        error: `no passages in ordinal range ${lo}..${hi} — call read_section with only node_id to see valid ordinals`,
      };
    return [...hits].sort((a, b) => a.ordinal - b.ordinal);
  }
  return {
    error: 'no selector — pass heading or from_ordinal/to_ordinal, or call with only node_id for the outline',
  };
}

/** Assemble selected passages into one heading-delimited string, capped on a
 *  character budget so a section read can't recreate a whole-file dump (pure).
 *  Reports `nextOrdinal` to continue from when the cap truncates. */
export function assembleSection<
  T extends { ordinal: number; heading: string | null; text: string },
>(selected: ReadonlyArray<T>, maxChars: number): {
  text: string;
  taken: T[];
  truncated: boolean;
  nextOrdinal: number | null;
} {
  const cap = Math.max(2000, Math.min(maxChars, 60000));
  const taken: T[] = [];
  let used = 0;
  let truncated = false;
  for (const c of selected) {
    if (taken.length > 0 && used + c.text.length > cap) {
      truncated = true;
      break;
    }
    taken.push(c);
    used += c.text.length;
  }
  const parts: string[] = [];
  let prevHeading: string | null | undefined;
  for (const c of taken) {
    if (c.heading && c.heading !== prevHeading) parts.push(`## ${c.heading}`);
    parts.push(c.text);
    prevHeading = c.heading;
  }
  const nextOrdinal = truncated ? (selected[taken.length]?.ordinal ?? null) : null;
  return { text: parts.join('\n\n'), taken, truncated, nextOrdinal };
}

export type ReadSectionOptions = {
  ownerId: string;
  nodeId: string;
  heading?: string;
  fromOrdinal?: number;
  toOrdinal?: number;
  maxChars?: number;
};

export type ReadSectionResult =
  | {
      mode: 'outline';
      node: { id: string; title: string; type: string };
      totalPassages: number;
      totalChars: number;
      sections: SectionRange[];
    }
  | {
      mode: 'section';
      node: { id: string; title: string; type: string };
      heading: string | null;
      ordinals: [number, number];
      passages: number;
      text: string;
      truncated: boolean;
      nextOrdinal: number | null;
    }
  | { error: string };

/** Default character cap for a section read — matches the ~22k-char auto-inject
 *  budget (8 chunks) so a section is comparable, not a back-door whole-file dump. */
const SECTION_DEFAULT_MAX_CHARS = 24000;

/**
 * Read one section of a chunked document. With no selector returns the OUTLINE
 * (heading ranges) so the caller can navigate; with `heading` or an ordinal
 * range returns that section assembled in order, capped. Owner-scoped.
 */
export async function readSection(opts: ReadSectionOptions): Promise<ReadSectionResult> {
  const [node] = await db
    .select({ id: nodes.id, title: nodes.title, type: sql<string>`${nodes.type}` })
    .from(nodes)
    .where(and(eq(nodes.id, opts.nodeId), eq(nodes.ownerId, opts.ownerId)))
    .limit(1);
  if (!node) return { error: 'node not found' };

  const all = await db
    .select({
      ordinal: contentChunks.ordinal,
      heading: contentChunks.headingPath,
      text: contentChunks.text,
    })
    .from(contentChunks)
    .where(and(eq(contentChunks.nodeId, opts.nodeId), eq(contentChunks.ownerId, opts.ownerId)))
    .orderBy(asc(contentChunks.ordinal));
  if (all.length === 0)
    return {
      error:
        'no indexed passages for this node — it may be short or not yet extracted; use file_read/node_read for the full text',
    };

  const hasSelector =
    !!opts.heading?.trim() ||
    typeof opts.fromOrdinal === 'number' ||
    typeof opts.toOrdinal === 'number';
  if (!hasSelector) {
    return {
      mode: 'outline',
      node,
      totalPassages: all.length,
      totalChars: all.reduce((n, c) => n + c.text.length, 0),
      sections: buildSectionOutline(all),
    };
  }

  const sel = selectSectionChunks(all, {
    heading: opts.heading,
    fromOrdinal: opts.fromOrdinal,
    toOrdinal: opts.toOrdinal,
  });
  if ('error' in sel) return sel;
  const asm = assembleSection(sel, opts.maxChars ?? SECTION_DEFAULT_MAX_CHARS);
  const first = asm.taken[0];
  const last = asm.taken[asm.taken.length - 1];
  // assembleSection always takes ≥1 of a non-empty selection; this guard is for
  // the type-checker (and degrades cleanly if that invariant ever changes).
  if (!first || !last) return { error: 'no passages selected' };
  return {
    mode: 'section',
    node,
    heading: opts.heading?.trim() || null,
    ordinals: [first.ordinal, last.ordinal],
    passages: asm.taken.length,
    text: asm.text,
    truncated: asm.truncated,
    nextOrdinal: asm.nextOrdinal,
  };
}
