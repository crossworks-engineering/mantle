/**
 * Re-save every P&ID (`pid`) canvas on this box through the checks a save
 * runs: the CLI face of lib/maintenance/pid-canvas-resave.ts (read its
 * header first). Run once per box after the release that brought the
 * image check seals (DWG bones phase 6).
 *
 * Usage:
 *   pnpm pid:resave                 # DRY RUN: counts what would change
 *   pnpm pid:resave --apply         # write them (each a new revision)
 *     --limit=<n>                   # at most n canvases this run
 *
 * No model, no re-index, no trigger: free. Prints counts only (safe on a
 * client box).
 */

import { closeDb } from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { resavePidCanvases } from '../lib/maintenance/pid-canvas-resave';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const limitArg = argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
const limit = limitArg ? Math.max(1, Math.floor(Number(limitArg)) || 1) : null;

async function main() {
  const c = await resavePidCanvases({ apply, limit });
  console.log(
    `[pid-canvas-resave] ${apply ? 'done' : 'DRY RUN'}: ${c.canvases} pid canvas${c.canvases === 1 ? '' : 'es'} read${c.cut ? ` (cut at --limit=${limit}; run again for the rest)` : ''}; ${c.changed} ${apply ? 'written again' : 'would be written again'}, ${c.unchanged} already as a save writes them, ${c.refused} a save would refuse (left as they are), ${c.moved} saved meanwhile (left for the next run)`,
  );
  if (!apply && c.changed) console.log('[pid-canvas-resave] pass --apply to write them');
}

main()
  .catch((err) => {
    console.error('[pid-canvas-resave] failed:', errorMessage(err));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
