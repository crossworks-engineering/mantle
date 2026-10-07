/**
 * Sync the app table exports still marked dirty (apps first-class plan, D8):
 * the CLI face of the `app-export-catch-up` maintenance task. The rule lives
 * in @mantle/content/app-table-exports (syncDirtyAppTableExports). A changed
 * table is committed, and the commit re-indexes it, so this spends; it is
 * not on the nightly cron. The web process resumes the dirty ones at boot.
 *
 * Usage:
 *   pnpm app-export:catch-up           # DRY RUN: counts the dirty apps only
 *   pnpm app-export:catch-up --apply   # sync them (hash-gated)
 */

import { env } from '@mantle/config';
import { closeDb } from '@mantle/db';
import { syncDirtyAppTableExports } from '@mantle/content/app-table-exports';

if (!env('DATABASE_URL')) {
  console.error('app-export-catch-up: DATABASE_URL must be set');
  process.exit(1);
}

const apply = process.argv.slice(2).includes('--apply');

async function main() {
  const r = await syncDirtyAppTableExports({ dryRun: !apply });
  console.log(
    apply
      ? `[app-export-catch-up] ${r.apps} app(s): ${r.synced} synced, ${r.unchanged} unchanged, ${r.errors} failed`
      : `[app-export-catch-up] dirty: ${r.apps} app(s). DRY RUN: pass --apply to sync them`,
  );
}

main()
  .then(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  })
  .catch((err) => {
    console.error('[app-export-catch-up] failed:', err);
    process.exit(1);
  });
