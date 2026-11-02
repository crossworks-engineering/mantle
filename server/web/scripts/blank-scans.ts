/**
 * Read again the PDF scans that drew blank before the decoders: the CLI face
 * of lib/maintenance/blank-scans.ts (read its header first). SPENDS on
 * --apply: each file runs the normal OCR path, then a summary, an embedding
 * and facts.
 *
 * Usage:
 *   pnpm blank:scans                               # DRY RUN: counts, codecs, pages, est. USD
 *   pnpm blank:scans --before=2026-11-03           # dry run, only files read before that day
 *   pnpm blank:scans --apply --before=2026-11-03 --limit=3
 *   pnpm blank:scans --apply --before=2026-11-03   # all of them, in batches
 *     --before=<YYYY-MM-DD>  the day this box got v0.400.56 or later (required with --apply)
 *     --limit=<n>            at most n files
 *     --batch=<n>            files queued per batch (default 5)
 *     --batch-timeout=<m>    minutes to wait for a batch (default 30)
 *
 * Prints ids, counts and model names only (safe on a client box). Needs the
 * parser service (page counts) and, for --apply, the agent (server/api): it is
 * the extract queue's only consumer.
 */

import { env } from '@mantle/config';
import { errorMessage } from '@mantle/std';
import { closeDb, resolveSingleOwnerId } from '@mantle/db';
import {
  findBlankCandidates,
  parseBefore,
  prepareReread,
  readBefore,
  scanBytes,
  type BlankCodec,
} from '../lib/maintenance/blank-scans';
import {
  estimateOcrCost,
  indexedNow,
  ocrWorkers,
  pageTokensFromHistory,
  priceOf,
  runBatch,
} from '../lib/maintenance/ocr-rescan';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const limit = flag('limit') ? Math.max(1, Number(flag('limit'))) : null;
const batchSize = Math.max(1, Number(flag('batch') ?? 5));
const batchTimeoutMin = Math.max(1, Number(flag('batch-timeout') ?? 30));
const beforeArg = flag('before');
const before = parseBefore(beforeArg);

const usd = (v: number | null) =>
  v === null ? 'unknown (no price for this model)' : `$${v.toFixed(2)}`;

async function main(): Promise<number> {
  if (beforeArg !== undefined && !before) {
    console.error(`[blank-scans] --before must be a date (YYYY-MM-DD), not '${beforeArg}'`);
    return 2;
  }
  if (apply && !before) {
    console.error(
      '[blank-scans] --apply needs --before=<YYYY-MM-DD>: the day this box got v0.400.56 or later. A file read after that was read right, and is never sent again.',
    );
    return 2;
  }
  const ownerId = env('ALLOWED_USER_ID') || (await resolveSingleOwnerId());
  if (!ownerId) throw new Error('no brain owner (set ALLOWED_USER_ID)');

  const all = await findBlankCandidates();
  const kinds = (list: typeof all) =>
    `no_text ${list.filter((c) => c.kind === 'no_text').length}, ocr_text ${list.filter((c) => c.kind === 'ocr_text').length}`;
  console.log(
    `[blank-scans] candidates (PDFs page OCR read, not sent before): ${all.length} (${kinds(all)})`,
  );
  let chosen = all;
  if (before) {
    chosen = readBefore(all, before);
    console.log(
      `  read before ${before.toISOString().slice(0, 10)}: ${chosen.length}; after it, or with no read time: ${all.length - chosen.length} (left alone)`,
    );
  }
  if (limit) chosen = chosen.slice(0, limit);
  if (chosen.length === 0) return 0;

  const scan = await scanBytes(
    ownerId,
    chosen.map((c) => c.id),
  );
  const byCodec = (c: BlankCodec) =>
    [...scan.hits.values()].filter((h) => h.codecs.includes(c)).length;
  console.log(
    `  bytes searched: ${chosen.length}; name a blank codec: ${scan.hits.size} (JPX ${byCodec('/JPXDecode')}, CCITT ${byCodec('/CCITTFaxDecode')}, JBIG2 ${byCodec('/JBIG2Decode')}); name none: ${scan.misses.length}; missing or unreadable: ${scan.unreadable.length}`,
  );
  if (scan.hits.size === 0) {
    console.log('[blank-scans] nothing to read again on this box.');
    return 0;
  }
  if (!before) {
    const times = chosen
      .filter((c) => scan.hits.has(c.id) && c.readAt)
      .map((c) => c.readAt!.slice(0, 10))
      .sort();
    if (times.length > 0)
      console.log(`  hits were read from ${times[0]} to ${times[times.length - 1]}`);
  }
  const pagesPerDoc = [...scan.hits.values()].map((h) => h.pages);
  console.log(`  pages: ${pagesPerDoc.reduce((a, b) => a + b, 0)} over ${scan.hits.size} file(s)`);

  const workers = await ocrWorkers(ownerId);
  if (!workers.document && !workers.vision) {
    console.log('  no document or vision worker: OCR cannot run here. Nothing to do.');
    return 0;
  }
  const nativePrice = workers.document
    ? await priceOf(ownerId, workers.document.provider, workers.document.model)
    : null;
  const visionPrice = workers.vision
    ? await priceOf(ownerId, workers.vision.provider, workers.vision.model)
    : null;
  const tokens = await pageTokensFromHistory();
  const est = estimateOcrCost({
    pagesPerDoc,
    tokens,
    nativePrice,
    nativeAvailable: Boolean(workers.document?.native),
    visionPrice,
  });
  const priceLine = (p: typeof nativePrice) =>
    p ? `$${p.inPerM}/M in, $${p.outPerM}/M out (${p.source})` : 'no known price';
  if (workers.document) {
    console.log(
      `  document worker: ${workers.document.provider} ${workers.document.model}, native PDF ${workers.document.native ? 'yes' : 'no'}, ${priceLine(nativePrice)}`,
    );
  }
  if (workers.vision) {
    console.log(
      `  vision worker (page OCR): ${workers.vision.provider} ${workers.vision.model}, ${priceLine(visionPrice)}`,
    );
  }
  console.log(`  tokens per page: ${tokens.in} in, ${tokens.out} out (${tokens.source})`);
  if (est.native) console.log(`  native: ${est.native.calls} call(s), ${usd(est.native.usd)}`);
  console.log(`  page OCR: ${est.raster.calls} call(s), ${usd(est.raster.usd)}`);
  console.log(
    `  ESTIMATE: expected ${usd(est.expectedUsd)}, worst case ${usd(est.worstUsd)} (OCR only; summary + embedding add one small text call per file)`,
  );
  console.log(`  ids: ${[...scan.hits.keys()].join(', ')}`);

  if (!apply) {
    console.log(
      '[blank-scans] DRY RUN: pass --apply --before=<the day this box got v0.400.56> (start with --limit=3) to read them again',
    );
    return 0;
  }

  const todo = [...scan.hits.keys()];
  const at = new Date();
  let done: string[] = [];
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    console.log(`[blank-scans] batch ${i / batchSize + 1}: queueing ${batch.length}`);
    const r = await runBatch(batch, {
      timeoutMs: batchTimeoutMin * 60_000,
      prepare: (id) => prepareReread(id, at),
    });
    done = done.concat(r.done);
    if (r.timedOut.length > 0) {
      console.log(
        `[blank-scans] STOPPED: ${r.timedOut.length} file(s) not finished after ${batchTimeoutMin} min (is the agent up? a provider paused?). They are stamped and will not be sent again: ${r.timedOut.join(', ')}`,
      );
      break;
    }
  }
  const result = await indexedNow(done);
  console.log(
    `[blank-scans] finished ${done.length}/${todo.length}: ${result.indexed} indexed, ${result.notIndexed} still without an embedding (see their extractor_run traces)`,
  );
  return 0;
}

main()
  .then(async (code) => {
    await closeDb().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('[blank-scans] failed:', errorMessage(err));
    await closeDb().catch(() => {});
    process.exit(1);
  });
