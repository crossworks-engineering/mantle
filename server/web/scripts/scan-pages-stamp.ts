/**
 * Stamp the read cut `scan_pages` on PDF files whose sketch read left scan
 * pages not read: the CLI face of lib/maintenance/scan-pages-stamp.ts (read
 * its header first). Free: no model, no queue.
 *
 * Usage:
 *   pnpm maintain scan-pages-stamp            # DRY RUN: counts only
 *   pnpm maintain scan-pages-stamp --apply    # stamp them
 *
 * Prints counts only (safe on a client box).
 */
import { errorMessage } from '@mantle/std';
import { closeDb } from '@mantle/db';
import { stampScanPages } from '../lib/maintenance/scan-pages-stamp';

const apply = process.argv.slice(2).includes('--apply');

async function main(): Promise<number> {
  const c = await stampScanPages(apply);
  console.log(
    `[scan-pages-stamp] PDF files with no scan_pages cut: ${c.pdfs}; with a sketch read: ${c.sketched}; read in part: ${c.partial}; no drawing File tab read (not a drawing database, or busy now): ${c.unreadable}; stamped: ${c.stamped}`,
  );
  if (!apply && c.partial > 0) {
    console.log('[scan-pages-stamp] DRY RUN: pass --apply to stamp them');
  }
  return 0;
}

main()
  .then(async (code) => {
    await closeDb().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('[scan-pages-stamp] failed:', errorMessage(err));
    await closeDb().catch(() => {});
    process.exit(1);
  });
