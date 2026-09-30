/**
 * Trim the app access log (client tier audit I4): the CLI face of the
 * `app-access-log-reap` maintenance sweep. The rule lives in
 * @mantle/content app-access-log.ts (reapAppAccessLog), so the cron worker
 * and this script share one definition. Plain SQL, no model.
 *
 * Usage:
 *   pnpm app-access-log:reap           # DRY RUN: counts only, writes nothing
 *   pnpm app-access-log:reap --apply   # delete rows older than 90 days
 */

import { env } from '@mantle/config';
import { closeDb } from '@mantle/db';
import { reapAppAccessLog } from '@mantle/content';

if (!env('DATABASE_URL')) {
  console.error('app-access-log-reap: DATABASE_URL must be set');
  process.exit(1);
}

const apply = process.argv.slice(2).includes('--apply');

async function main() {
  const r = await reapAppAccessLog({ dryRun: !apply });
  if (!apply) {
    console.log(
      `[app-access-log-reap] due: ${r.deleted} row(s). DRY RUN: pass --apply to delete them`,
    );
    return;
  }
  console.log(`[app-access-log-reap] deleted ${r.deleted} row(s)`);
}

main()
  .then(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  })
  .catch((err) => {
    console.error('[app-access-log-reap] failed:', err);
    process.exit(1);
  });
