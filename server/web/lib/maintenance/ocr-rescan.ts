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
 * node runs the extractor's normal read of a scanned PDF (the Scan reader,
 * page by page, every page: server/api extract/images.ts `ocrIngestPdfNode`;
 * vision only for a page mostly a figure), then a summary, an embedding and
 * facts. So the dry run (the default) prints what will run and what it
 * costs, and `--apply` re-queues through the ordinary extract queue in small
 * batches, waiting for each batch to finish before the next. Person-started
 * only: no cron, no trigger, no new path to a model.
 *
 * Output is counts, ids and model names only: safe on a client box.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  contentChunks,
  db,
  getDefaultWorker,
  nodes,
  markContentChanged,
  withDeadlockRetry,
  withHeads,
} from '@mantle/db';
import {
  keptReadCuts,
  BYTE_DERIVED_DATA_KEYS,
  parserPdfPageCount,
  readFileById,
} from '@mantle/files';
import { getVisionAdapter, isProviderId } from '@mantle/voice';
import { SCAN_READER_ENGINE } from '@mantle/runtime/agent';
import { fallbackCostMicroUsd } from '@mantle/tracing';
import { sleep as stdSleep } from '@mantle/std';
import { fetchProviderModels } from '../model-explorer';

/** The Scan reader's price of a page (mistral-ocr, $2 per 1,000 pages, plus
 *  the small text model behind it: $0.00203 billed a page on the scan bench,
 *  2026-11-19), and in the US region ($2.20 per 1,000). Not in any model
 *  catalog: the engine's fee is OpenRouter's, per page. */
export const SCAN_READER_PAGE_USD = 0.00203;
export const SCAN_READER_PAGE_USD_MAX = 0.0022;

/** The pg-boss queues the extractor consumes (server/api extract-queue.ts):
 *  the main queue and the heavy and book lanes, where a drawing's or a
 *  book's job goes on from it, so a job there is still pending. */
const EXTRACT_QUEUES = ['mantle.extract', 'mantle.extract.heavy', 'mantle.extract.book'];

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
  const pages = new Map<string, number>();
  const unreadable: string[] = [];
  for (const id of ids) {
    const file = await readFileById({ ownerId, fileId: id }).catch(() => null);
    // Counted by the parser service: a PDF is never opened in this process.
    const n = file ? await parserPdfPageCount(file.bytes).catch(() => null) : null;
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
  /** The Scan reader, one call a page, every page (a white page costs
   *  nothing, so this is the most). Null when the brain has no Scan reader:
   *  nothing is read, the pages stay unread. */
  scan: { calls: number; usd: number } | null;
  /** What we expect: every page by the Scan reader. */
  expectedUsd: number | null;
  /** Every page also a figure, described by vision (one more call a page),
   *  at the US price of the engine. Unknown when vision has no price. */
  worstUsd: number | null;
};

/** Pure: price the read of the pages. Summary, embedding and facts after it
 *  are a small fraction on top (one cheap text call per document) and are
 *  not in the number; the CLI says so. */
export function estimateOcrCost(args: {
  pagesPerDoc: number[];
  tokens: PageTokens;
  scanReader: boolean;
  visionPrice: ModelPrice | null;
}): Estimate {
  const pages = args.pagesPerDoc.reduce((a, b) => a + b, 0);
  if (!args.scanReader) return { scan: null, expectedUsd: null, worstUsd: null };
  const scan = { calls: pages, usd: pages * SCAN_READER_PAGE_USD };
  const p = args.visionPrice;
  const vision = p
    ? (pages * (args.tokens.in * p.inPerM + args.tokens.out * p.outPerM)) / 1e6
    : null;
  return {
    scan,
    expectedUsd: scan.usd,
    worstUsd: vision === null ? null : pages * SCAN_READER_PAGE_USD_MAX + vision,
  };
}

/** The workers that will run, as the extractor resolves them: the Scan
 *  reader (usable: its provider has a PDF parser engine) and vision (a page
 *  mostly a figure). */
export async function ocrWorkers(ownerId: string) {
  const scan = await getDefaultWorker(ownerId, 'scan_reader');
  const vision = await getDefaultWorker(ownerId, 'vision');
  return {
    scanReader:
      scan && typeof getVisionAdapter(scan.provider)?.parsePdf === 'function'
        ? { provider: scan.provider, model: scan.model, engine: SCAN_READER_ENGINE }
        : null,
    vision: vision ? { provider: vision.provider, model: vision.model } : null,
  };
}

/**
 * The dry run's lines of the workers and the price, one form for every
 * remedy that reads scanned PDFs again (ocr-rescan, blank-scans), printed
 * with `log`. False when nothing can read them here (no Scan reader).
 */
export async function printScanEstimate(
  ownerId: string,
  pagesPerDoc: number[],
  log: (line: string) => void,
): Promise<boolean> {
  const usd = (v: number | null) =>
    v === null ? 'unknown (no price for this model)' : `$${v.toFixed(2)}`;
  const workers = await ocrWorkers(ownerId);
  if (!workers.scanReader) {
    log(
      '  no Scan reader (an OpenRouter key and the Scan reader worker): scanned pages cannot be read here. Nothing to do.',
    );
    return false;
  }
  const visionPrice = workers.vision
    ? await priceOf(ownerId, workers.vision.provider, workers.vision.model)
    : null;
  const tokens = await pageTokensFromHistory();
  const est = estimateOcrCost({ pagesPerDoc, tokens, scanReader: true, visionPrice });
  const per1000 = (v: number) => `$${(v * 1000).toFixed(2)}`;
  log(
    `  Scan reader: ${workers.scanReader.provider} ${workers.scanReader.engine} (text model ${workers.scanReader.model}), ${per1000(SCAN_READER_PAGE_USD)} per 1,000 pages (${per1000(SCAN_READER_PAGE_USD_MAX)} in the US region)`,
  );
  const visionLine = workers.vision
    ? `  vision worker (a page mostly a figure only): ${workers.vision.provider} ${workers.vision.model}, ${visionPrice ? `$${visionPrice.inPerM}/M in, $${visionPrice.outPerM}/M out (${visionPrice.source})` : 'no known price'}; tokens per page ${tokens.in} in, ${tokens.out} out (${tokens.source})`
    : '  no vision worker: a page mostly a figure stays unread';
  log(visionLine);
  log(`  Scan reader: ${est.scan?.calls ?? 0} call(s), every page, ${usd(est.expectedUsd)}`);
  log(
    `  ESTIMATE: expected ${usd(est.expectedUsd)}, worst case ${usd(est.worstUsd)} (every page a figure; the read only, a white page costs nothing; summary + embedding add one small text call per file, the decider's check about $0.0003 a page where the brain has one)`,
  );
  return true;
}

/**
 * Clear what the bad pass left so the extractor reads the file afresh: the
 * byte-derived keys (`data.text` with the markers, the summary, the
 * completion marker, the terminal-skip stamp), the embedding and the chunks.
 * One transaction per node. Facts and relation edges are left for the
 * re-extract, which replaces them the normal way. `stamp` keys are written in
 * the same transaction (blank-scans marks a file it sent). `onlyIf` is checked
 * by the same UPDATE: a node it no longer fits is left as it is, and the
 * answer is false (nothing cleared, nothing announced).
 */
export async function clearForRescan(
  id: string,
  opts: { stamp?: Record<string, string>; onlyIf?: SQL } = {},
): Promise<boolean> {
  // The text of the Agents' tabs stays: the bytes and their tabs do not
  // change, and the re-extract queues no Agent run to write it again. So
  // does the Reader pipeline's stamp: this rebuilds no database. The
  // read's cuts stay whole while one the next read does not say again is
  // among them (an Agent's, the picture gate's: keptReadCuts), else they go
  // with the read.
  const keys = [
    ...BYTE_DERIVED_DATA_KEYS.filter((k) => k !== 'agent_text' && k !== 'pipeline_read'),
    'extract_skipped',
  ];
  // The node's head first (workspaces plan U1).
  return withDeadlockRetry(() =>
    withHeads([id], 'update', async (tx) => {
      const [file] = await tx
        .update(nodes)
        .set({
          data: sql`(coalesce(${nodes.data}, '{}'::jsonb) - array[${sql.join(
            keys.map((k) => sql`${k}`),
            sql`, `,
          )}]::text[]) || ${keptReadCuts()} || ${JSON.stringify(opts.stamp ?? {})}::jsonb`,
          updatedAt: new Date(),
        })
        .where(and(eq(nodes.id, id), eq(nodes.type, 'file'), opts.onlyIf))
        .returning({ id: nodes.id });
      if (!file) return false;
      await tx.delete(contentChunks).where(eq(contentChunks.nodeId, id));
      // As if its bytes were new: the vector goes too, announced when this
      // transaction commits (markContentChanged).
      await markContentChanged(tx, { id, type: 'file' }, ['content']);
      return true;
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
     where name in (${sql.join(
       EXTRACT_QUEUES.map((q) => sql`${q}`),
       sql`, `,
     )})
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

export type BatchOutcome = {
  done: string[];
  timedOut: string[];
  /** Nodes `prepare` left alone (it answered false): never queued. */
  skipped: string[];
};

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
    /** What to do to each node: reset it and announce it. Default:
     *  `clearForRescan` (markContentChanged announces). doc-reindex passes
     *  `resignalNode` (its nodes have nothing stale to clear). An answer of
     *  false means the node was left alone: it is not waited for. */
    prepare?: (id: string) => Promise<void | boolean>;
  },
): Promise<BatchOutcome> {
  const sleep = opts.sleep ?? stdSleep;
  const prepare = opts.prepare ?? ((id: string) => clearForRescan(id));
  const started = new Date();
  const sent: string[] = [];
  const skipped: string[] = [];
  for (const id of ids) {
    if ((await prepare(id)) === false) skipped.push(id);
    else sent.push(id);
  }
  const deadline = Date.now() + opts.timeoutMs;
  let open = [...sent];
  while (open.length > 0 && Date.now() < deadline) {
    await sleep(opts.pollMs ?? 10_000);
    const [pending, ran] = await Promise.all([pendingJobs(open), ranSince(open, started)]);
    open = open.filter((id) => pending.has(id) || !ran.has(id));
  }
  return { done: sent.filter((id) => !open.includes(id)), timedOut: open, skipped };
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
