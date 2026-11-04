/**
 * Give old import tables and extracted images their file's home and grants:
 * the CLI face of lib/maintenance/part-repair.ts (read its header first).
 *
 *   pnpm -C server/web part:repair                     # DRY RUN
 *   pnpm -C server/web part:repair --apply --limit=100
 *
 * Prints ids and counts only (safe on a client box). Never deletes anything.
 */
import { closeDb } from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { runPartRepair } from '../lib/maintenance/part-repair';

const argv = process.argv.slice(2);
const limit = Number(argv.find((a) => a.startsWith('--limit='))?.split('=')[1]) || 0;

runPartRepair({ apply: argv.includes('--apply'), limit }, (line) => console.log(line))
  .then((ok) => {
    if (!ok) process.exitCode = 1;
  })
  .catch((err) => {
    console.error(`[part-repair] ${errorMessage(err).slice(0, 200)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
