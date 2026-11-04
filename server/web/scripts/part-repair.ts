/**
 * Give old import tables and extracted images their file's home and grants:
 * the CLI face of lib/maintenance/part-repair.ts (read its header first).
 *
 *   pnpm -C server/web part:repair                     # DRY RUN
 *   pnpm -C server/web part:repair --apply --limit=100
 *
 * Prints ids and counts only (safe on a client box). Never deletes anything.
 */
import { closeDb, pgErrorCode } from '@mantle/db';
import { partRepairArgs, runPartRepair } from '../lib/maintenance/part-repair';

const args = partRepairArgs(process.argv.slice(2));

if (!args) {
  console.error('[part-repair] write --limit=<n>, a number above 0. Nothing done.');
  process.exitCode = 2;
  void closeDb();
} else {
  runPartRepair(args, (line) => console.log(line))
    .then((ok) => {
      if (!ok) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(`[part-repair] failed: SQLSTATE ${pgErrorCode(err) ?? 'none'}`);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
