/**
 * Purge the private personal items of logins deactivated for 30 days or more
 * (member logins plan 6.4): the CLI face of the `space-purge` maintenance
 * sweep. The rule lives in @mantle/content member-space-purge.ts, so the cron
 * worker and this script share one definition.
 *
 * Team-shared and submitted items are kept: an admin accepts or discards them
 * from Team admin > Review. Counts only, never titles.
 *
 * Usage:
 *   pnpm space:purge           # DRY RUN: report only, writes nothing
 *   pnpm space:purge --apply   # delete them, rows and bytes
 */

import { env } from '@mantle/config';
import { SPACE_PURGE_GRACE_DAYS, findSpacePurge, purgeDeactivatedSpaces } from '@mantle/content';

if (!env('DATABASE_URL')) {
  console.error('space-purge: DATABASE_URL must be set');
  process.exit(1);
}

const apply = process.argv.slice(2).includes('--apply');

async function main() {
  const due = await findSpacePurge();
  if (due.length === 0) {
    console.log(`[space-purge] nothing past the ${SPACE_PURGE_GRACE_DAYS}-day grace: all clean`);
    return;
  }
  const items = due.reduce((n, d) => n + d.items, 0);
  console.log(`[space-purge] ${items} private item(s) in ${due.length} space(s) are due`);
  if (!apply) {
    console.log('[space-purge] DRY RUN: pass --apply to delete them');
    return;
  }
  const r = await purgeDeactivatedSpaces();
  if (r.skipped) {
    console.log(`[space-purge] skipped: ${r.skipped}`);
    return;
  }
  console.log(
    `[space-purge] purged ${r.items} item(s) in ${r.spaces} space(s); ${r.emptied} emptied`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[space-purge] failed:', err);
    process.exit(1);
  });
