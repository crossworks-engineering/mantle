/**
 * Reap dead device tokens: the CLI face of the `device-tokens-reap`
 * maintenance sweep. The rule lives in lib/auth/device-token-reap.ts
 * (reapDeviceTokens), so the cron worker and this script share one
 * definition. Plain SQL, no model.
 *
 * Usage:
 *   pnpm device-tokens:reap           # DRY RUN: counts only, writes nothing
 *   pnpm device-tokens:reap --apply   # delete them
 */

import { env } from '@mantle/config';
import { closeDb } from '@mantle/db';
import { reapDeviceTokens } from '../lib/auth/device-token-reap';

if (!env('DATABASE_URL')) {
  console.error('device-tokens-reap: DATABASE_URL must be set');
  process.exit(1);
}

const apply = process.argv.slice(2).includes('--apply');

async function main() {
  const r = await reapDeviceTokens({ dryRun: !apply });
  if (!apply) {
    console.log(
      `[device-tokens-reap] due: ${r.deleted} token row(s). DRY RUN: pass --apply to reap them`,
    );
    return;
  }
  console.log(`[device-tokens-reap] reaped ${r.deleted} token row(s)`);
}

main()
  .then(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  })
  .catch((err) => {
    console.error('[device-tokens-reap] failed:', err);
    process.exit(1);
  });
