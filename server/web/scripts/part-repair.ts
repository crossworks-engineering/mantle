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
import {
  findOldParts,
  PART_REPAIR_DEFAULT_LIMIT,
  PART_REPAIR_MAX_LIMIT,
  repairOldPart,
} from '../lib/maintenance/part-repair';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const asked = Number(argv.find((a) => a.startsWith('--limit='))?.split('=')[1]);
const limit = Math.min(asked > 0 ? asked : PART_REPAIR_DEFAULT_LIMIT, PART_REPAIR_MAX_LIMIT);

async function main() {
  const rows = await findOldParts();
  const ready = rows.filter((r) => r.ready);
  const gone = rows.filter((r) => r.gone).length;
  console.log(
    `[part-repair] items: ${rows.length}. ready ${ready.length}, file deleted ${gone}, left alone ${rows.length - ready.length - gone}.`,
  );
  for (const r of ready.slice(0, limit)) {
    if (!apply) {
      console.log(`  would change ${r.type} ${r.id} (file ${r.fileId})`);
      continue;
    }
    await repairOldPart(r);
    console.log(`  changed ${r.type} ${r.id}`);
  }
  if (!apply)
    console.log(`[part-repair] DRY RUN: nothing changed. --apply changes at most ${limit}.`);
}

main()
  .catch((err) => {
    console.error(`[part-repair] ${errorMessage(err).slice(0, 200)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
