/**
 * Re-OCR scanned PDFs the page-marker bug indexed wrong: the CLI face of
 * lib/maintenance/ocr-rescan.ts (read its header first). SPENDS on --apply:
 * each node runs the normal read of a scanned PDF (the Scan reader, every
 * page), then a summary and an embedding. Person-started only.
 *
 * Usage:
 *   pnpm ocr:rescan                      # DRY RUN: counts, pages, workers, est. USD
 *   pnpm ocr:rescan --limit=3            # dry run over the first 3 only
 *   pnpm ocr:rescan --apply --limit=3    # do 3 first, then look at the result
 *   pnpm ocr:rescan --apply              # all of them, in batches
 *     --batch=<n>          nodes queued per batch (default 5)
 *     --batch-timeout=<m>  minutes to wait for a batch (default 30)
 *
 * Prints ids, counts and model names only (safe on a client box). Needs the
 * agent (server/api) running: it is the queue's only consumer.
 */

import { env } from '@mantle/config';
import { closeDb, resolveSingleOwnerId } from '@mantle/db';
import {
  countPages,
  findRescanCandidates,
  indexedNow,
  printScanEstimate,
  runBatch,
} from '../lib/maintenance/ocr-rescan';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const limit = flag('limit') ? Math.max(1, Number(flag('limit'))) : null;
const batchSize = Math.max(1, Number(flag('batch') ?? 5));
const batchTimeoutMin = Math.max(1, Number(flag('batch-timeout') ?? 30));

async function main() {
  const ownerId = env('ALLOWED_USER_ID') || (await resolveSingleOwnerId());
  if (!ownerId) throw new Error('no brain owner (set ALLOWED_USER_ID)');

  const all = await findRescanCandidates();
  const chosen = limit ? all.slice(0, limit) : all;
  const byKind = (k: string) => chosen.filter((c) => c.kind === k).length;
  console.log(
    `[ocr-rescan] candidates: ${all.length} (markers_indexed ${all.filter((c) => c.kind === 'markers_indexed').length}, stuck_too_short ${all.filter((c) => c.kind === 'stuck_too_short').length})`,
  );
  if (chosen.length === 0) return;
  if (limit) {
    console.log(
      `  this run: ${chosen.length} (markers_indexed ${byKind('markers_indexed')}, stuck_too_short ${byKind('stuck_too_short')})`,
    );
  }

  const { pages, unreadable } = await countPages(
    ownerId,
    chosen.map((c) => c.id),
  );
  const pagesPerDoc = [...pages.values()];
  const totalPages = pagesPerDoc.reduce((a, b) => a + b, 0);
  console.log(
    `  pages: ${totalPages} over ${pages.size} file(s); ${unreadable.length} file(s) with missing or unreadable bytes (skipped by the extractor, no spend)`,
  );

  if (!(await printScanEstimate(ownerId, pagesPerDoc, (l) => console.log(l)))) return;
  console.log(`  ids: ${chosen.map((c) => c.id).join(', ')}`);

  if (!apply) {
    console.log('[ocr-rescan] DRY RUN: pass --apply (start with --limit=3) to re-OCR them');
    return;
  }

  const todo = chosen.map((c) => c.id).filter((id) => pages.has(id));
  let done: string[] = [];
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    console.log(`[ocr-rescan] batch ${i / batchSize + 1}: queueing ${batch.length}`);
    const r = await runBatch(batch, { timeoutMs: batchTimeoutMin * 60_000 });
    done = done.concat(r.done);
    if (r.timedOut.length > 0) {
      console.log(
        `[ocr-rescan] STOPPED: ${r.timedOut.length} node(s) not finished after ${batchTimeoutMin} min (is the agent up? a provider paused?): ${r.timedOut.join(', ')}`,
      );
      break;
    }
  }
  const result = await indexedNow(done);
  console.log(
    `[ocr-rescan] finished ${done.length}/${todo.length}: ${result.indexed} indexed, ${result.notIndexed} still without an embedding (see their extractor_run traces)`,
  );
}

main()
  .then(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('[ocr-rescan] failed:', err instanceof Error ? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
