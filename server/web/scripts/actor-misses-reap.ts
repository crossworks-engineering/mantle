/**
 * Trim the actor check's miss log: the CLI face of the `actor-misses-reap`
 * maintenance sweep. The rule lives in lib/maintenance/actor-misses-reap.ts
 * (reapActorMisses), so the cron worker and this script share one
 * definition. Plain SQL, no model.
 *
 * Usage (from server/web):
 *   tsx --env-file-if-exists=./.env.local scripts/actor-misses-reap.ts           # DRY RUN
 *   tsx --env-file-if-exists=./.env.local scripts/actor-misses-reap.ts --apply   # delete them
 */

import { env } from '@mantle/config';
import { closeDb } from '@mantle/db';
import { ACTOR_MISSES_RETENTION_DAYS, reapActorMisses } from '../lib/maintenance/actor-misses-reap';

if (!env('DATABASE_URL')) {
  console.error('actor-misses-reap: DATABASE_URL must be set');
  process.exit(1);
}

const apply = process.argv.slice(2).includes('--apply');

async function main() {
  const r = await reapActorMisses({ dryRun: !apply });
  const days = ACTOR_MISSES_RETENTION_DAYS;
  if (!apply) {
    console.log(
      `[actor-misses-reap] due: ${r.deleted} row(s) older than ${days} days. DRY RUN: pass --apply to reap them`,
    );
    return;
  }
  console.log(`[actor-misses-reap] reaped ${r.deleted} row(s) older than ${days} days`);
}

main()
  .then(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  })
  .catch((err) => {
    console.error('[actor-misses-reap] failed:', err);
    process.exit(1);
  });
