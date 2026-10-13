/**
 * Remove the store files no row points at (workspaces arch A3b, plan 20.3):
 * the CLI face of the `store-sweep` maintenance sweep. Old revisions a flip
 * left, stages whose flip never landed, a deleted table's files; only once
 * unreferenced on two runs a grace period (an hour) apart and older than
 * it. The rule lives in @mantle/content/store-sweep (sweepStores), shared by
 * the cron worker and this script. File removal and one read of the rows:
 * no model, no extraction.
 *
 * Usage:
 *   pnpm store:sweep           # DRY RUN: counts only, removes nothing
 *   pnpm store:sweep --apply   # remove them
 */
import { env } from '@mantle/config';
import { closeDb } from '@mantle/db';
import { summariseStoreSweep, sweepStores } from '@mantle/content/store-sweep';

if (!env('DATABASE_URL')) {
  console.error('store-sweep: DATABASE_URL must be set');
  process.exit(1);
}

const apply = process.argv.slice(2).includes('--apply');

async function main() {
  const r = await sweepStores({ dryRun: !apply });
  console.log(`[store-sweep] ${summariseStoreSweep(r, !apply)}`);
}

main()
  .then(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  })
  .catch((err) => {
    console.error('[store-sweep] failed:', err);
    process.exit(1);
  });
