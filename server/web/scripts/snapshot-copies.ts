/**
 * The author's read-only snapshot copies of accepted items
 * (lib/snapshot-copies.ts has the rule). Also run at boot after the
 * workspaces migration. Hand-run only: never wire it to a cron or a trigger.
 *
 *   pnpm maintain snapshot-copies          dry run: counts only
 *   pnpm maintain snapshot-copies --go     make the missing copies
 *
 * No LLM work, no extractor notify, no queue job. Output is numbers only.
 */
import { closeDb } from '@mantle/db';
import { makeSnapshotCopies } from '../lib/snapshot-copies';

let apply = false;
for (const a of process.argv.slice(2)) {
  if (a === '--go') apply = true;
  else {
    console.error(`snapshot-copies: unknown argument ${a}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const r = await makeSnapshotCopies({ dryRun: !apply });
  const skipped = Object.entries(r.skipped)
    .map(([why, n]) => `${why} ${n}`)
    .join(', ');
  console.log(
    `[snapshot-copies] ${apply ? 'APPLIED' : 'DRY RUN'}: wanted ${r.wanted}, made ${r.made}, ` +
      `already ${r.already}, skipped ${skipped || '0'}, accepted rows cleared ${r.acceptedRowsCleared}` +
      (apply ? '' : '\n  nothing written (--go runs it)'),
  );
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[snapshot-copies] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
