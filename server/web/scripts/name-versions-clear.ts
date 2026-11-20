/**
 * Clear the marks the removed name-based version pass left on files: the CLI
 * face of lib/maintenance/name-versions-clear.ts (read its header first).
 * Free: one UPDATE, no model.
 *
 * Usage:
 *   pnpm maintain name-versions-clear            # DRY RUN: counts only
 *   pnpm maintain name-versions-clear --apply    # clear them
 *
 * Prints counts only (safe on a client box).
 */
import { errorMessage } from '@mantle/std';
import { closeDb } from '@mantle/db';
import {
  clearNameVersionMarks,
  countNameVersionMarks,
} from '../lib/maintenance/name-versions-clear';

const apply = process.argv.slice(2).includes('--apply');

async function main(): Promise<number> {
  const before = await countNameVersionMarks();
  console.log(
    `[name-versions-clear] files marked superseded by name (reason 'version', a file in the same folder): to clear ${before.toClear}; other 'version' marks: left ${before.left}`,
  );
  if (before.toClear === 0) return 0;
  if (!apply) {
    console.log('[name-versions-clear] DRY RUN: pass --apply to clear them');
    return 0;
  }
  const cleared = await clearNameVersionMarks();
  const after = await countNameVersionMarks();
  console.log(
    `[name-versions-clear] cleared: ${cleared}; still to clear: ${after.toClear}; left: ${after.left}`,
  );
  return 0;
}

main()
  .then(async (code) => {
    await closeDb().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('[name-versions-clear] failed:', errorMessage(err));
    await closeDb().catch(() => {});
    process.exit(1);
  });
