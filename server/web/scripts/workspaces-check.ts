/**
 * workspaces:check (workspaces plan 7.8): the CLI face of the read-only
 * `workspaces-check` maintenance task. It counts what the grants should never
 * hold now that they are the only truth (migration 0261): grant drift,
 * orphan grants, items without a home, workspaces without a Moderator,
 * assistants not in exactly one workspace, and open links with no `served`
 * key. The query lives in @mantle/db (workspaces-check.ts) and runs in a READ
 * ONLY transaction. Numbers only; no model, no cron.
 *
 * Usage:
 *   pnpm workspaces:check          # the counts
 *   pnpm workspaces:check --json   # the same, machine-readable
 *
 * Exits 0 even when it finds something: it reports, it does not gate.
 */

import { env } from '@mantle/config';
import { closeDb, runWorkspacesCheck, workspacesCheckFindings } from '@mantle/db';

if (!env('DATABASE_URL')) {
  console.error('workspaces-check: DATABASE_URL must be set');
  process.exit(1);
}

async function main() {
  const c = await runWorkspacesCheck();
  if (process.argv.slice(2).includes('--json')) {
    console.log(JSON.stringify({ ...c, findings: workspacesCheckFindings(c) }, null, 2));
    return;
  }
  if (!c.migrated) console.log('[workspaces-check] this brain has no workspaces yet');
  const lines: Array<[string, number]> = [
    ['grant drift (items whose derived columns differ from their grants)', c.grantDrift],
    ['orphan grants (missing item or workspace, or a stale folder row)', c.orphanGrants],
    ['brain items without a home', c.itemsWithoutHome],
    ['workspaces without a Moderator who can sign in', c.workspacesWithoutModerator],
    ['  of which the Admin workspace', c.adminWithoutModerator],
    ['assistants not in exactly one workspace', c.assistantsNotInOneWorkspace],
    ['open links without a served key', c.linksWithoutServed],
  ];
  for (const [label, n] of lines) console.log(`[workspaces-check] ${label}: ${n}`);
  if (c.linksWithoutServed && !c.linksServedInUse) {
    console.log('[workspaces-check] no open link carries the served key yet: not counted');
  }
  const findings = workspacesCheckFindings(c);
  console.log(
    findings ? `[workspaces-check] ${findings} finding(s)` : '[workspaces-check] all clean',
  );
}

main()
  .then(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  })
  .catch((err) => {
    console.error('[workspaces-check] failed:', err);
    process.exit(1);
  });
