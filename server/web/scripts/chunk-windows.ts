/**
 * Passage windows: build (or clear) the window vectors inside every chunk
 * (docs/recall-eval.md, "Passage windows"; @mantle/embeddings
 * runChunkWindows).
 *
 * DRY RUN by default: counts the chunks with no windows, the windows they
 * need, how many must be embedded (a one-window chunk reuses its chunk
 * vector) and the estimated embedding cost. Nothing is written.
 *
 *   pnpm maintain chunk-windows            dry run: count + cost
 *   pnpm maintain chunk-windows --apply    switch windows on, then embed
 *   pnpm maintain chunk-windows --off      switch windows off (rows kept)
 *   pnpm maintain chunk-windows --clear    switch off and delete every row
 *   --parallel=N                           embed requests in flight (1-32, default 4)
 *
 * `--apply` sets embedding_config.chunk_windows first, so the extractor
 * writes windows for new chunks while this runs; it is resumable (chunks
 * that already have windows are skipped). Manual only: never wire it to a
 * cron or a trigger (cost safety).
 */
import { runChunkWindows, setChunkWindows } from '@mantle/embeddings';
import { env } from '@mantle/config';

const OWNER = env('ALLOWED_USER_ID');
if (!OWNER) {
  console.error('chunk-windows: ALLOWED_USER_ID must be set');
  process.exit(1);
}
const args = new Set(process.argv.slice(2));
let parallel: number | undefined;
for (const a of args) {
  const p = /^--parallel=(\d+)$/.exec(a);
  if (p && Number(p[1]) >= 1 && Number(p[1]) <= 32) {
    parallel = Number(p[1]);
    continue;
  }
  if (!['--apply', '--off', '--clear'].includes(a)) {
    console.error(`chunk-windows: unknown argument ${a} (--parallel takes 1 to 32)`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  if (args.has('--off')) {
    await setChunkWindows(OWNER!, false);
    console.log('[chunk-windows] switched off (window rows kept; --clear deletes them)');
    return;
  }
  if (args.has('--clear')) {
    const r = await runChunkWindows(OWNER!, { clear: true });
    console.log(`[chunk-windows] switched off, ${-r.written} window rows deleted`);
    return;
  }
  const apply = args.has('--apply');
  let last = 0;
  const r = await runChunkWindows(OWNER!, {
    apply,
    parallel,
    onProgress: (done, total) => {
      if (done - last >= 10_000 || done === total) {
        last = done;
        console.log(`[chunk-windows] ${done} / ${total} windows written`);
      }
    },
  });
  console.log(
    `[chunk-windows] ${apply ? 'APPLIED' : 'DRY RUN'}: ${r.chunks} chunks without windows -> ` +
      `${r.windows} windows, ${r.toEmbed} to embed (${r.chars} chars, ~${Math.round(r.chars / 4)} tokens), ` +
      `model ${r.model}, estimated USD ${r.estimatedUsd.toFixed(2)}` +
      (apply
        ? `; ${r.written} rows written, windows switched ON`
        : '; nothing written (--apply runs it)'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[chunk-windows] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
