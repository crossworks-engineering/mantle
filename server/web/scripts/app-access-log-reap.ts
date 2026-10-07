/**
 * Trim the app access log (client tier audit I4) and the contact share
 * trail (share_access_log, migration 0214): the CLI face of the
 * `app-access-log-reap` maintenance sweep. The rules live in
 * @mantle/content app-access-log.ts (reapAppAccessLog) and
 * share-access-log.ts (reapShareAccessLog), so the cron worker and this
 * script share one definition. Plain SQL, no model.
 *
 * Usage:
 *   pnpm app-access-log:reap           # DRY RUN: counts only, writes nothing
 *   pnpm app-access-log:reap --apply   # delete rows older than 90 days
 */

import { env } from '@mantle/config';
import { closeDb } from '@mantle/db';
import { reapAppAccessLog, reapShareAccessLog } from '@mantle/content';

if (!env('DATABASE_URL')) {
  console.error('app-access-log-reap: DATABASE_URL must be set');
  process.exit(1);
}

const apply = process.argv.slice(2).includes('--apply');

async function main() {
  const r = await reapAppAccessLog({ dryRun: !apply });
  const s = await reapShareAccessLog({ dryRun: !apply });
  if (!apply) {
    console.log(
      `[app-access-log-reap] due: ${r.deleted} app row(s), ${s.deleted} contact share row(s). DRY RUN: pass --apply to delete them`,
    );
    return;
  }
  console.log(
    `[app-access-log-reap] deleted ${r.deleted} app row(s), ${s.deleted} contact share row(s)`,
  );
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
