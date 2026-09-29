/**
 * Reap old client sign-in code rows (client logins audit B21): the CLI face
 * of the `client-codes-reap` maintenance sweep. The rule lives in
 * @mantle/content client-codes.ts (reapClientSigninCodes), so the cron
 * worker and this script share one definition. Plain SQL, no model.
 *
 * Usage:
 *   pnpm client-codes:reap           # DRY RUN: counts only, writes nothing
 *   pnpm client-codes:reap --apply   # delete and blank them
 */

import { env } from '@mantle/config';
import { closeDb } from '@mantle/db';
import { reapClientSigninCodes } from '@mantle/content';

if (!env('DATABASE_URL')) {
  console.error('client-codes-reap: DATABASE_URL must be set');
  process.exit(1);
}

const apply = process.argv.slice(2).includes('--apply');

async function main() {
  const r = await reapClientSigninCodes({ dryRun: !apply });
  const line = `${r.deleted} code row(s), ${r.skipsDeleted} skip row(s), ${r.ipsCleared} address(es)`;
  if (!apply) {
    console.log(`[client-codes-reap] due: ${line}. DRY RUN: pass --apply to reap them`);
    return;
  }
  console.log(`[client-codes-reap] reaped ${line}`);
}

main()
  .then(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  })
  .catch((err) => {
    console.error('[client-codes-reap] failed:', err);
    process.exit(1);
  });
