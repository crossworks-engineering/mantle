/**
 * Re-index documentation nodes that lost their summary and node embedding:
 * the CLI face of lib/maintenance/doc-reindex.ts (read its header first).
 * SPENDS on --apply: one extractor model call per doc, then the embeddings.
 *
 * Usage:
 *   pnpm doc:reindex                      # DRY RUN: count, model, est. USD
 *   pnpm doc:reindex --limit=5            # dry run over the first 5 only
 *   pnpm doc:reindex --apply --limit=5    # do 5 first, then look at the result
 *   pnpm doc:reindex --apply              # all of them, in batches
 *     --batch=<n>          nodes queued per batch (default 10)
 *     --batch-timeout=<m>  minutes to wait for a batch (default 30)
 *
 * Prints ids, counts and model names only (safe on a client box). Needs the
 * agent (server/api) running: it is the queue's only consumer.
 */

import { env } from '@mantle/config';
import { closeDb, getDefaultWorker, resolveSingleOwnerId } from '@mantle/db';
import {
  estimateDocReindexCost,
  extractRunHistory,
  findDocReindexCandidates,
} from '../lib/maintenance/doc-reindex';
import { indexedNow, priceOf, runBatch } from '../lib/maintenance/ocr-rescan';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const limit = flag('limit') ? Math.max(1, Number(flag('limit'))) : null;
const batchSize = Math.max(1, Number(flag('batch') ?? 10));
const batchTimeoutMin = Math.max(1, Number(flag('batch-timeout') ?? 30));

const usd = (v: number | null) =>
  v === null ? 'unknown (no run history, no price for this model)' : `$${v.toFixed(2)}`;

async function main() {
  const ownerId = env('ALLOWED_USER_ID') || (await resolveSingleOwnerId());
  if (!ownerId) throw new Error('no brain owner (set ALLOWED_USER_ID)');

  const all = await findDocReindexCandidates();
  const chosen = limit ? all.slice(0, limit) : all;
  console.log(`[doc-reindex] candidates: ${all.length} documentation node(s) with no embedding`);
  if (chosen.length === 0) return;
  if (limit) console.log(`  this run: ${chosen.length}`);

  const worker = await getDefaultWorker(ownerId, 'extractor');
  if (!worker) {
    console.log('  no extractor worker: extraction cannot run here. Nothing to do.');
    return;
  }
  const price = await priceOf(ownerId, worker.provider, worker.model);
  const history = await extractRunHistory();
  const est = estimateDocReindexCost({ count: chosen.length, history, price });
  console.log(
    `  extractor: ${worker.provider} ${worker.model}, ${price ? `$${price.inPerM}/M in, $${price.outPerM}/M out (${price.source})` : 'no known price'}`,
  );
  console.log(
    `  ESTIMATE: expected ${usd(est.expectedUsd)}, worst case ${usd(est.worstUsd)} (${est.basis}; chunk + node embeddings on top, free on a local embedder)`,
  );
  console.log(`  ids: ${chosen.join(', ')}`);

  if (!apply) {
    console.log('[doc-reindex] DRY RUN: pass --apply (start with --limit=5) to re-index them');
    return;
  }

  let done: string[] = [];
  for (let i = 0; i < chosen.length; i += batchSize) {
    const batch = chosen.slice(i, i + batchSize);
    console.log(`[doc-reindex] batch ${i / batchSize + 1}: queueing ${batch.length}`);
    // Nothing to clear: a candidate has no summary or embedding to go stale.
    const r = await runBatch(batch, {
      timeoutMs: batchTimeoutMin * 60_000,
      prepare: async () => {},
    });
    done = done.concat(r.done);
    if (r.timedOut.length > 0) {
      console.log(
        `[doc-reindex] STOPPED: ${r.timedOut.length} node(s) not finished after ${batchTimeoutMin} min (is the agent up? a provider paused?): ${r.timedOut.join(', ')}`,
      );
      break;
    }
  }
  const result = await indexedNow(done);
  console.log(
    `[doc-reindex] finished ${done.length}/${chosen.length}: ${result.indexed} indexed, ${result.notIndexed} still without an embedding (see their extractor_run traces)`,
  );
}

main()
  .then(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('[doc-reindex] failed:', err instanceof Error ? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
