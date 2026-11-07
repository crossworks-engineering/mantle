/**
 * Trim the agent UI calls (ui_calls, docs/agent-ui.md): the CLI face of the
 * `ui-calls-reap` maintenance sweep. The rule lives in
 * lib/maintenance/ui-calls-reap.ts (reapUiCalls), so the cron worker and this
 * script share one definition. Plain SQL, no model.
 *
 * Usage:
 *   bun --env-file=./.env.local scripts/ui-calls-reap.ts           # DRY RUN
 *   bun --env-file=./.env.local scripts/ui-calls-reap.ts --apply   # delete them
 */

import { env } from '@mantle/config';
import { closeDb } from '@mantle/db';
import { UI_CALLS_RETENTION_HOURS, reapUiCalls } from '../lib/maintenance/ui-calls-reap';

if (!env('DATABASE_URL')) {
  console.error('ui-calls-reap: DATABASE_URL must be set');
  process.exit(1);
}

const apply = process.argv.slice(2).includes('--apply');

async function main() {
  const r = await reapUiCalls({ dryRun: !apply });
  const hours = UI_CALLS_RETENTION_HOURS;
  if (!apply) {
    console.log(
      `[ui-calls-reap] due: ${r.deleted} row(s) older than ${hours} hours. DRY RUN: pass --apply to reap them`,
    );
    return;
  }
  console.log(`[ui-calls-reap] reaped ${r.deleted} row(s) older than ${hours} hours`);
}

main()
  .then(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  })
  .catch((err) => {
    console.error('[ui-calls-reap] failed:', err);
    process.exit(1);
  });
