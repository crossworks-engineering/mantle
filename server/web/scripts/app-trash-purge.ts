/**
 * Purge deleted apps past their 30 days in the trash (apps first-class plan,
 * Phase 3), the history of deleted tables (Phase 4), and the work files a
 * crash left in the app and table folders: the CLI face of
 * the `app-trash-purge` maintenance sweep. The rule
 * lives in @mantle/content/app-trash (purgeExpiredDeletedApps), shared by the
 * cron worker and this script. Plain SQL and file removal, no model.
 *
 * Usage:
 *   pnpm app-trash:purge           # DRY RUN: counts only, removes nothing
 *   pnpm app-trash:purge --apply   # remove the history and snapshot files
 */

import { env } from '@mantle/config';
import { closeDb } from '@mantle/db';
import { purgeExpiredDeletedApps, sweepAppFileLeftovers } from '@mantle/content/app-trash';
import { purgeOrphanTableHistory } from '@mantle/content/table-snapshots';

if (!env('DATABASE_URL')) {
  console.error('app-trash-purge: DATABASE_URL must be set');
  process.exit(1);
}

const apply = process.argv.slice(2).includes('--apply');

async function main() {
  const r = await purgeExpiredDeletedApps({ dryRun: !apply });
  const t = await purgeOrphanTableHistory({ dryRun: !apply });
  const left = await sweepAppFileLeftovers({ dryRun: !apply });
  console.log(
    apply
      ? `[app-trash-purge] purged ${r.apps} deleted app(s), the history of ${t.tables} deleted table(s), ${left} leftover work file(s)`
      : `[app-trash-purge] due: ${r.apps} deleted app(s), the history of ${t.tables} deleted table(s), ${left} leftover work file(s). DRY RUN: pass --apply to purge them`,
  );
}

main()
  .then(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  })
  .catch((err) => {
    console.error('[app-trash-purge] failed:', err);
    process.exit(1);
  });
