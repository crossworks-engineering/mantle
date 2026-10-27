/**
 * Re-save every P&ID (`pid`) canvas on this box through the checks a save
 * runs: the CLI face of lib/maintenance/pid-canvas-resave.ts (read its
 * header first). Run once per box after the release that brought the
 * image check seals (DWG bones phase 6).
 *
 * Usage:
 *   pnpm pid:resave                 # DRY RUN: counts what would change
 *   pnpm pid:resave --apply         # write them (each a new revision)
 *     --limit <n> (or --limit=<n>)  # at most n canvases this run
 *
 * Any other argument is refused (exit 2): a mistyped flag never runs.
 *
 * No model, no re-index, no trigger: free. Prints counts only (safe on a
 * client box).
 */

import { closeDb } from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { parseResaveArgs, resavePidCanvases } from '../lib/maintenance/pid-canvas-resave';

async function main() {
  const args = parseResaveArgs(process.argv.slice(2));
  if ('error' in args) {
    console.error(`[pid-canvas-resave] ${args.error}`);
    process.exitCode = 2;
    return;
  }
  const { apply, limit } = args;
  const c = await resavePidCanvases({ apply, limit });
  console.log(
    `[pid-canvas-resave] ${apply ? 'done' : 'DRY RUN'}: ${c.canvases} pid canvas${c.canvases === 1 ? '' : 'es'} read${c.cut ? ` (cut at --limit=${limit}; run again for the rest)` : ''}; ${c.changed} ${apply ? 'written again' : 'would be written again'}, ${c.unchanged} already as a save writes them, ${c.refused} a save would refuse (left as they are), ${c.moved} saved meanwhile (left for the next run); ${c.posters} poster${c.posters === 1 ? '' : 's'} ${apply ? 'cleared' : 'would be cleared'} (a Page embed shows no snapshot until the canvas's next look)`,
  );
  if (!apply && (c.changed || c.posters))
    console.log('[pid-canvas-resave] pass --apply to write them');
}

main()
  .catch((err) => {
    console.error('[pid-canvas-resave] failed:', errorMessage(err));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
