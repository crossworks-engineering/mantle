/**
 * Repair folder-share drift: the CLI face of the `share-drift` maintenance
 * sweep (docs/folder-tree.md, "Sharing a folder"). Rows whose stored
 * inherited share differs from what their folders give. The rule lives in
 * @mantle/content/tree share-drift.ts (repairShareDrift), shared by the cron
 * and this script. Plain SQL, no model.
 *
 * Usage:
 *   pnpm share-drift           # DRY RUN: counts only, writes nothing
 *   pnpm share-drift --apply   # repair them
 */

import { env } from '@mantle/config';
import { closeDb } from '@mantle/db';
import { repairShareDrift } from '@mantle/content/tree';

if (!env('DATABASE_URL')) {
  console.error('share-drift: DATABASE_URL must be set');
  process.exit(1);
}

const apply = process.argv.slice(2).includes('--apply');

async function main() {
  const r = await repairShareDrift({ dryRun: !apply });
  const line =
    `${r.drifted} row(s) drifted, ${r.openedTooFar} read more openly than their folders allow; ` +
    `${r.edgesDrifted} embed edge(s) off, ${r.embeddedDrifted} embedded level(s) drifted ` +
    `(${r.embeddedOpenedTooFar} read too openly)`;
  if (!apply) {
    console.log(`[share-drift] ${line}. DRY RUN: pass --apply to repair them`);
    return;
  }
  console.log(`[share-drift] ${line}; repaired ${r.repaired}`);
}

main()
  .then(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  })
  .catch((err) => {
    console.error('[share-drift] failed:', err);
    process.exit(1);
  });
