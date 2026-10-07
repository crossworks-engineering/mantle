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
 *   --parallel=N                           embed calls in flight (1-32, default 4)
 *
 * Each embed call is about 100 windows; memory stays under 2 x parallel x 100
 * vectors whatever the corpus size (measured RSS: docs/embeddings.md). On a
 * box, run it in its own container, not inside mantle_web:
 * scripts/box-maintain.sh <box> chunk-windows --apply --yes
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
  const t0 = Date.now();
  let last = 0;
  let lastAt = t0;
  const r = await runChunkWindows(OWNER!, {
    apply,
    parallel,
    // A line every 10k windows or every minute, whichever comes first, so a
    // log that stops moving is visible as such.
    onProgress: (done, total) => {
      const now = Date.now();
      if (done - last < 10_000 && now - lastAt < 60_000 && done !== total) return;
      last = done;
      lastAt = now;
      const min = (now - t0) / 60_000;
      const rate = min > 0 ? Math.round(done / min) : 0;
      const eta = rate > 0 ? `, about ${Math.ceil((total - done) / rate)} min left` : '';
      console.log(
        `[chunk-windows] ${done} / ${total} windows written (${Math.round((done / total) * 100)}%), ` +
          `${min.toFixed(1)} min, ${rate} windows/min${eta}, rss ${rssMb()} MB`,
      );
    },
  });
  const min = ((Date.now() - t0) / 60_000).toFixed(1);
  console.log(
    `[chunk-windows] ${apply ? 'APPLIED' : 'DRY RUN'}: ${r.chunks} chunks without windows -> ` +
      `${r.windows} windows, ${r.toEmbed} to embed (${r.chars} chars, ~${Math.round(r.chars / 4)} tokens), ` +
      `model ${r.model}, estimated USD ${r.estimatedUsd.toFixed(2)}` +
      (apply
        ? `; ${r.written} rows written in ${min} min (peak rss ${peakRssMb()} MB), windows switched ON`
        : '; nothing written (--apply runs it)'),
  );
}

function rssMb(): number {
  return Math.round(process.memoryUsage.rss() / 1_048_576);
}

function peakRssMb(): number {
  return Math.round(process.resourceUsage().maxRSS / 1024);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[chunk-windows] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
