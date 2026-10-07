/**
 * Stop extractor loops on nodes with nothing to read: the CLI face of
 * @mantle/db extract-skip-backfill.ts. Stamps `data.extract_skipped` on brain
 * nodes whose last extractor run was a content verdict, so the boot drain and
 * the provider recovery drain stop re-queuing them. Plain SQL, no model.
 * Prints counts and ids only (safe on a client box).
 *
 * Usage:
 *   pnpm extract:skip-stamp           # DRY RUN: counts only, writes nothing
 *   pnpm extract:skip-stamp --apply   # stamp them
 */

import { env } from '@mantle/config';
import { backfillTerminalSkips, closeDb } from '@mantle/db';

if (!env('DATABASE_URL')) {
  console.error('extract-skip-stamp: DATABASE_URL must be set');
  process.exit(1);
}

const apply = process.argv.slice(2).includes('--apply');

async function main() {
  const r = await backfillTerminalSkips({ dryRun: !apply });
  if (r.stamped === 0) {
    console.log('[extract-skip-stamp] nothing to stamp');
    return;
  }
  for (const [kind, n] of Object.entries(r.byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind}: ${n}`);
  }
  console.log(`  sample ids: ${r.sampleIds.join(', ')}`);
  if (!apply) {
    console.log(
      `[extract-skip-stamp] ${r.stamped} node(s) to stamp. DRY RUN: pass --apply to stamp them`,
    );
    return;
  }
  console.log(`[extract-skip-stamp] stamped ${r.stamped} node(s)`);
}

main()
  .then(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  })
  .catch((err) => {
    console.error('[extract-skip-stamp] failed:', err);
    process.exit(1);
  });
