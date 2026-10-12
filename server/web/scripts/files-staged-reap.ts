/**
 * Remove the staging files a crash left beside a file create (W8b fix round
 * 1): the CLI face of the `files-staged-reap` maintenance sweep. Only names
 * of the form `.<uuid>.staged.tmp`, an hour old or more, under the files
 * root; never a symlink, a dot folder, or the app, table, spaces or sandbox
 * stores. The rule lives in @mantle/files (sweepStagedLeftovers), shared by
 * the cron worker and this script. File removal only, no database, no model.
 *
 * Usage:
 *   pnpm files-staged:reap           # DRY RUN: counts only, removes nothing
 *   pnpm files-staged:reap --apply   # remove them
 */

import { runFilesStagedReap, summariseFilesStagedReap } from '../lib/maintenance/files-staged-reap';

const apply = process.argv.slice(2).includes('--apply');

async function main() {
  const r = await runFilesStagedReap({ dryRun: !apply });
  console.log(`[files-staged-reap] ${summariseFilesStagedReap(r, !apply)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[files-staged-reap] failed:', err);
    process.exit(1);
  });
