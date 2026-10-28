/**
 * Trim the MCP call log (mcp_calls, Journal v3 J8): the CLI face of the
 * `mcp-calls-reap` maintenance sweep. The rule lives in
 * lib/maintenance/mcp-calls-reap.ts (reapMcpCalls), so the cron worker and this script share
 * one definition. Plain SQL, no model.
 *
 * Usage:
 *   tsx --env-file-if-exists=./.env.local scripts/mcp-calls-reap.ts           # DRY RUN
 *   tsx --env-file-if-exists=./.env.local scripts/mcp-calls-reap.ts --apply   # delete them
 */

import { env } from '@mantle/config';
import { closeDb } from '@mantle/db';
import { MCP_CALLS_RETENTION_DAYS, reapMcpCalls } from '../lib/maintenance/mcp-calls-reap';

if (!env('DATABASE_URL')) {
  console.error('mcp-calls-reap: DATABASE_URL must be set');
  process.exit(1);
}

const apply = process.argv.slice(2).includes('--apply');

async function main() {
  const r = await reapMcpCalls({ dryRun: !apply });
  const days = MCP_CALLS_RETENTION_DAYS;
  if (!apply) {
    console.log(
      `[mcp-calls-reap] due: ${r.deleted} row(s) older than ${days} days. DRY RUN: pass --apply to reap them`,
    );
    return;
  }
  console.log(`[mcp-calls-reap] reaped ${r.deleted} row(s) older than ${days} days`);
}

main()
  .then(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  })
  .catch((err) => {
    console.error('[mcp-calls-reap] failed:', err);
    process.exit(1);
  });
