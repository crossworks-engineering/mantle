/**
 * Remove the old store revisions no row points at (workspaces arch A3b,
 * plan 20.3): the CLI face of the `store-sweep` maintenance sweep. Old
 * revisions a flip left and stages whose flip never landed, of items whose
 * row names another file; only once unreferenced on two runs a grace period
 * (an hour) apart and older than it. Files of items with no row, and drafts
 * from before A3b, are reported, never removed. The rule lives in
 * @mantle/content/store-sweep (sweepStores), shared by the cron worker and
 * this script. File removal and one read of the rows: no model, no
 * extraction.
 *
 * Usage:
 *   pnpm store:sweep                        # DRY RUN: counts only, removes nothing
 *   pnpm store:sweep --apply                # remove them
 *   pnpm store:sweep --apply --allow-many   # past the per-run limit (50 files,
 *                                           # or 10% of a store), after a dry run
 *
 * Exit codes: 0 done · 1 crash · 2 a store's guard stopped it (nothing removed
 * there; the line says why).
 */
import { env } from '@mantle/config';
import { closeDb } from '@mantle/db';
import { summariseStoreSweep, sweepStores } from '@mantle/content/store-sweep';

if (!env('DATABASE_URL')) {
  console.error('store-sweep: DATABASE_URL must be set');
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const allowMany = args.includes('--allow-many');

async function main() {
  const r = await sweepStores({ dryRun: !apply, allowMany });
  console.log(`[store-sweep] ${summariseStoreSweep(r, !apply)}`);
  for (const s of r) {
    for (const f of s.noRow) console.log(`  kept, no row: ${s.store} ${f}`);
    for (const f of s.rowFileMissing)
      console.log(`  kept, a row's file is missing: ${s.store} ${f}`);
    for (const f of s.legacy) console.log(`  kept, a draft from before A3b: ${s.store} ${f}`);
  }
  if (r.some((s) => s.aborted)) process.exitCode = 2;
}

main()
  .then(async () => {
    await closeDb().catch(() => {});
    process.exit(process.exitCode ?? 0);
  })
  .catch((err) => {
    console.error('[store-sweep] failed:', err);
    process.exit(1);
  });
