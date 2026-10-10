/**
 * Re-fold and re-chunk the pages, notes and drawings that embed other items
 * (workspaces plan 5.3, phase W2; lib/maintenance/refold-embeds.ts has the
 * rule). Hand-run only: never wire it to a cron or a trigger.
 *
 *   pnpm maintain refold-embeds                    dry run: counts only
 *   pnpm maintain refold-embeds --go               rewrite text, chunks, vectors
 *   --limit=N                                      the first N candidates
 *   --allow-remote-embedder                        embed on a non-local route
 *
 * Model work: the embedder only (local by default; the run refuses a remote
 * route unless told). No summary, no facts, no extractor notify, no queue
 * job. Output is numbers only.
 */
import { env } from '@mantle/config';
import { closeDb } from '@mantle/db';
import {
  chunkWindowsEnabled,
  embedBatch,
  planChunkWindows,
  resolveEmbeddingConfig,
} from '@mantle/embeddings';
import { refoldEmbeds } from '../lib/maintenance/refold-embeds';

const OWNER = env('ALLOWED_USER_ID');
if (!OWNER) {
  console.error('refold-embeds: ALLOWED_USER_ID must be set');
  process.exit(1);
}
let apply = false;
let allowRemote = false;
let limit: number | undefined;
for (const a of process.argv.slice(2)) {
  const l = /^--limit=(\d+)$/.exec(a);
  if (l && Number(l[1]) > 0) limit = Number(l[1]);
  else if (a === '--go') apply = true;
  else if (a === '--allow-remote-embedder') allowRemote = true;
  else {
    console.error(`refold-embeds: unknown argument ${a}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const cfg = await resolveEmbeddingConfig(OWNER!);
  const routes = [cfg.primary, ...(cfg.backup ? [cfg.backup] : [])];
  const local = routes.every((r) => r.provider === 'local');
  if (apply && !local && !allowRemote) {
    console.error(
      `refold-embeds: the embedder is not local (${routes.map((r) => r.provider).join(', ')}); ` +
        'pass --allow-remote-embedder to embed there anyway',
    );
    process.exit(2);
  }
  const t0 = Date.now();
  const r = await refoldEmbeds(OWNER!, {
    apply,
    limit,
    deps: { embedBatch, windowsEnabled: chunkWindowsEnabled, planWindows: planChunkWindows },
  });
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[refold-embeds] ${apply ? 'APPLIED' : 'DRY RUN'} (embedder ${local ? 'local' : 'remote'}, ${sec} s)\n` +
      `  candidates: page ${r.candidates.page}, note ${r.candidates.note}, draw ${r.candidates.draw}\n` +
      `  marked (old summary set aside): page ${r.marked.page}, note ${r.marked.note}, draw ${r.marked.draw}\n` +
      `  unchanged ${r.unchanged}, empty ${r.empty}, text rewritten ${r.textRewritten}, ` +
      `rechunked ${r.rechunked} (${r.chunks} chunks), node vectors ${r.nodeVectors}, ` +
      `embed texts ${r.embedTexts}` +
      (apply ? '' : '\n  nothing written (--go runs it)'),
  );
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[refold-embeds] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
