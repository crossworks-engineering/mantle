/**
 * Re-OCR the scanned PDFs that the page-marker bug indexed wrong (fixed in
 * v0.238.2, @mantle/files pdf.ts `parsePdf`). pdf-parse ends every page with
 * a `-- N of M --` marker, text or no text, so before the fix:
 *
 *  - a scan of 2+ pages cleared the 20-char minimum and was indexed as its own
 *    markers (data.text = the markers, a summary of nothing, an embedding);
 *  - a 1-page scan was `body_too_short` (12 chars) and never reached OCR.
 *
 * The fix stops new cases; this remedy is for the old ones. It spends: each
 * node runs the extractor's normal OCR path (the document worker's native PDF
 * read, then the vision worker page by page if that yields nothing), then a
 * summary, an embedding and facts. So the dry run (the default) prints what
 * will run and what it costs, and `--apply` re-queues through the ordinary
 * extract queue in small batches, waiting for each batch to finish before the
 * next. No cron, no trigger, no new path to a model.
 *
 * Output is counts, ids and model names only: safe on a client box.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  contentChunks,
  db,
  getDefaultWorker,
  nodes,
  notifyNodeIngested,
  withDeadlockRetry,
  withHeads,
} from '@mantle/db';
import { BYTE_DERIVED_DATA_KEYS, readFileById } from '@mantle/files';
import { getVisionAdapter, isProviderId } from '@mantle/voice';
import { fallbackCostMicroUsd } from '@mantle/tracing';
import { sleep as stdSleep } from '@mantle/std';
import { fetchProviderModels } from '../model-explorer';

/** The extractor's raster OCR page cap (server/api extract/images.ts
 *  MAX_OCR_PAGES): a document past it is read only to this page. */
export const MAX_OCR_PAGES = 10;

/** pg-boss queue the extractor consumes (server/api extract-queue.ts). */
const EXTRACT_QUEUE = 'mantle.extract';

/** Why a node is a candidate. */
export type RescanKind = 'markers_indexed' | 'stuck_too_short';

export type RescanCandidate = { id: string; kind: RescanKind };

/**
 * Brain-owned PDF file nodes that need OCR:
 *  - `markers_indexed`: `data.text` is nothing but page markers;
 *  - `stuck_too_short`: no embedding, and the last extractor run (or the
 *    terminal-skip stamp) says `body_too_short`.
 * Metadata-only files are never candidates (their content stays out).
 */
export async function findRescanCandidates(): Promise<RescanCandidate[]> {
  const rows = (await db.execute(sql`
    with pdf as (
      select n.id, n.created_at, n.embedding is null as no_emb, n.data
        from ${nodes} n
       where public.mantle_is_brain_space(n.owner_id)
         and n.type = 'file'
         and (lower(coalesce(n.data->>'filename', n.title)) like '%.pdf'
              or n.data->>'mimeType' = 'application/pdf')
         and coalesce(n.data->>'indexing_applied', '') <> 'metadata'
         and coalesce(n.data->>'indexing', '') <> 'metadata'
    ), last_run as (
      select distinct on (t.subject_id) t.subject_id, t.data->>'disposition' as disposition
        from public.traces t
       where t.kind = 'extractor_run' and t.subject_id in (select id from pdf where no_emb)
       order by t.subject_id, t.started_at desc
    )
    select p.id,
           case when p.data->>'text' ~ '^\\s*(--\\s*\\d+ of \\d+\\s*--\\s*)+$'
                then 'markers_indexed' else 'stuck_too_short' end as kind
      from pdf p
      left join last_run l on l.subject_id = p.id
     where p.data->>'text' ~ '^\\s*(--\\s*\\d+ of \\d+\\s*--\\s*)+$'
        or (p.no_emb and (l.disposition = 'body_too_short'
                          or p.data->'extract_skipped'->>'reason' = 'body_too_short'))
     order by p.created_at
  `)) as unknown as RescanCandidate[];
  return rows.map((r) => ({ id: r.id, kind: r.kind }));
}

/** Page counts per candidate, from the bytes (disk or object storage). A file
 *  whose bytes are missing or unreadable counts as `unreadable`: the
 *  extractor would skip it too, at no cost. */
export async function countPages(
  ownerId: string,
  ids: string[],
): Promise<{ pages: Map<string, number>; unreadable: string[] }> {
  const { pdfPageCount } = await import('@mantle/files/pdf');
  const pages = new Map<string, number>();
  const unreadable: string[] = [];
  for (const id of ids) {
    const file = await readFileById({ ownerId, fileId: id }).catch(() => null);
    const n = file ? await pdfPageCount(file.bytes) : null;
    if (n && n > 0) pages.set(id, n);
    else unreadable.push(id);
  }
  return { pages, unreadable };
}

/** USD per 1M tokens, and where the number came from. */
export type ModelPrice = {
  inPerM: number;
  outPerM: number;
  source: 'live catalog' | 'fallback table';
};

/** Price of a model: the provider's live catalog first (OpenRouter publishes
 *  it on every row), then the tracing fallback table. Null when neither knows
 *  it: the estimate then says so rather than guessing. */
export async function priceOf(
  ownerId: string,
  provider: string,
  model: string,
): Promise<ModelPrice | null> {
  if (isProviderId(provider)) {
    const cat = await fetchProviderModels(ownerId, provider);
    const row = cat.models.find((m) => m.id === model);
    if (row?.inputPricePerM !== undefined && row.outputPricePerM !== undefined) {
      return { inPerM: row.inputPricePerM, outPerM: row.outputPricePerM, source: 'live catalog' };
    }
  }
  const inPerM = fallbackCostMicroUsd(model, { input: 1_000_000, output: 0 }) / 1_000_000;
  const outPerM = fallbackCostMicroUsd(model, { input: 0, output: 1_000_000 }) / 1_000_000;
  if (inPerM === 0 && outPerM === 0) return null;
  return { inPerM, outPerM, source: 'fallback table' };
}

/** Tokens per page. From this box's own recent vision calls when it has
 *  enough of them, else a stated assumption. */
export type PageTokens = { in: number; out: number; source: string };

export const ASSUMED_PAGE_TOKENS: PageTokens = {
  in: 1500,
  out: 800,
  source: 'assumed (fewer than 5 vision calls on this box)',
};

export async function pageTokensFromHistory(): Promise<PageTokens> {
  const rows = (await db.execute(sql`
    select count(*)::int as n,
           avg((meta->>'tokensIn')::numeric)::int as tin,
           avg((meta->>'tokensOut')::numeric)::int as tout
      from (select meta from public.trace_steps
             where name = 'extract_vision' and meta->>'ran' = 'true'
               and meta ? 'tokensIn' and meta ? 'tokensOut'
             order by started_at desc limit 200) s
  `)) as unknown as Array<{ n: number; tin: number | null; tout: number | null }>;
  const r = rows[0];
  if (!r || r.n < 5 || !r.tin || !r.tout) return ASSUMED_PAGE_TOKENS;
  return { in: r.tin, out: r.tout, source: `this box's last ${r.n} vision calls` };
}

export type Estimate = {
  /** The extractor's first try: one native-PDF call per document. Null when
   *  the document provider has no native PDF path. */
  native: { calls: number; usd: number | null } | null;
  /** Page-by-page OCR with the vision model, pages capped per document. */
  raster: { calls: number; usd: number | null };
  /** What we expect: native when it exists, else raster. */
  expectedUsd: number | null;
  /** Native ran but read nothing, so every page also went to raster. */
  worstUsd: number | null;
};

/** Pure: price the OCR pass. Summary, embedding and facts after it are a
 *  small fraction on top (one cheap text call per document) and are not in
 *  the number; the CLI says so. */
export function estimateOcrCost(args: {
  pagesPerDoc: number[];
  tokens: PageTokens;
  nativePrice: ModelPrice | null;
  nativeAvailable: boolean;
  visionPrice: ModelPrice | null;
}): Estimate {
  const allPages = args.pagesPerDoc.reduce((a, b) => a + b, 0);
  const rasterPages = args.pagesPerDoc.reduce((a, p) => a + Math.min(p, MAX_OCR_PAGES), 0);
  const usd = (pages: number, price: ModelPrice | null) =>
    price
      ? (pages * (args.tokens.in * price.inPerM + args.tokens.out * price.outPerM)) / 1e6
      : null;
  const native = args.nativeAvailable
    ? { calls: args.pagesPerDoc.length, usd: usd(allPages, args.nativePrice) }
    : null;
  const raster = { calls: rasterPages, usd: usd(rasterPages, args.visionPrice) };
  const expectedUsd = native ? native.usd : raster.usd;
  const worstUsd =
    native && native.usd !== null && raster.usd !== null
      ? native.usd + raster.usd
      : native
        ? null
        : raster.usd;
  return { native, raster, expectedUsd, worstUsd };
}

/** The workers that will run, as the extractor resolves them. */
export async function ocrWorkers(ownerId: string) {
  const doc =
    (await getDefaultWorker(ownerId, 'document')) ?? (await getDefaultWorker(ownerId, 'vision'));
  const vision = await getDefaultWorker(ownerId, 'vision');
  return {
    document: doc
      ? {
          provider: doc.provider,
          model: doc.model,
          native: Boolean(getVisionAdapter(doc.provider)?.extractDocument),
        }
      : null,
    vision: vision ? { provider: vision.provider, model: vision.model } : null,
  };
}

/**
 * Clear what the bad pass left so the extractor reads the file afresh: the
 * byte-derived keys (`data.text` with the markers, the summary, the
 * completion marker, the terminal-skip stamp), the embedding and the chunks.
 * One transaction per node. Facts and relation edges are left for the
 * re-extract, which replaces them the normal way.
 */
export async function clearForRescan(id: string): Promise<void> {
  const keys = [...BYTE_DERIVED_DATA_KEYS, 'extract_skipped'];
  // The node's head first (workspaces plan U1).
  await withDeadlockRetry(() =>
    withHeads([id], 'update', async (tx) => {
      await tx.delete(contentChunks).where(eq(contentChunks.nodeId, id));
      await tx
        .update(nodes)
        .set({
          embedding: null,
          data: sql`coalesce(${nodes.data}, '{}'::jsonb) - ${sql.raw(`array[${keys.map((k) => `'${k}'`).join(',')}]::text[]`)}`,
          updatedAt: new Date(),
        })
        .where(and(eq(nodes.id, id), eq(nodes.type, 'file')));
    }),
  );
}

/** Ids from `ids` that still have an extract job waiting or running. */
async function pendingJobs(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  // No pg-boss schema yet (the agent has never started on this database):
  // nothing can be pending, and the run check alone decides.
  const [reg] = (await db.execute(
    sql`select to_regclass('pgboss.job') is not null as ok`,
  )) as unknown as Array<{ ok: boolean }>;
  if (!reg?.ok) return new Set();
  const rows = (await db.execute(sql`
    select distinct data->>'nodeId' as id from pgboss.job
     where name = ${EXTRACT_QUEUE}
       and state in ('created', 'retry', 'active')
       and data->>'nodeId' in (${sql.join(
         ids.map((i) => sql`${i}`),
         sql`, `,
       )})
  `)) as unknown as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/** Ids from `ids` with an extractor run that started at or after `since`. */
async function ranSince(ids: string[], since: Date): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = (await db.execute(sql`
    select distinct subject_id::text as id from public.traces
     where kind = 'extractor_run' and started_at >= ${since.toISOString()}::timestamptz
       and subject_id::text in (${sql.join(
         ids.map((i) => sql`${i}`),
         sql`, `,
       )})
  `)) as unknown as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

export type BatchOutcome = { done: string[]; timedOut: string[] };

/**
 * Clear and re-queue one batch through the normal path (`node_ingested` →
 * the agent's pg-boss queue, whose own concurrency cap throttles the work),
 * then wait until every node in it has a fresh extractor run and no job left.
 * A node still unfinished at the deadline is reported, never re-sent.
 */
export async function runBatch(
  ids: string[],
  opts: {
    timeoutMs: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** What to do to each node before its notify. Default: `clearForRescan`.
     *  doc-reindex passes a no-op (its nodes have nothing stale to clear). */
    prepare?: (id: string) => Promise<void>;
  },
): Promise<BatchOutcome> {
  const sleep = opts.sleep ?? stdSleep;
  const prepare = opts.prepare ?? clearForRescan;
  const started = new Date();
  for (const id of ids) {
    await prepare(id);
    await notifyNodeIngested(id);
  }
  const deadline = Date.now() + opts.timeoutMs;
  let open = [...ids];
  while (open.length > 0 && Date.now() < deadline) {
    await sleep(opts.pollMs ?? 10_000);
    const [pending, ran] = await Promise.all([pendingJobs(open), ranSince(open, started)]);
    open = open.filter((id) => pending.has(id) || !ran.has(id));
  }
  return { done: ids.filter((id) => !open.includes(id)), timedOut: open };
}

/** Of `ids`, the nodes that now carry an embedding (indexed) and those still
 *  without one (OCR read nothing, or the run failed). Counts only. */
export async function indexedNow(ids: string[]): Promise<{ indexed: number; notIndexed: number }> {
  if (ids.length === 0) return { indexed: 0, notIndexed: 0 };
  const rows = await db
    .select({ id: nodes.id, has: sql<boolean>`${nodes.embedding} is not null` })
    .from(nodes)
    .where(inArray(nodes.id, ids));
  const indexed = rows.filter((r) => r.has).length;
  return { indexed, notIndexed: rows.length - indexed };
}
