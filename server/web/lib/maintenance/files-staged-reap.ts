/**
 * The `files-staged-reap` maintenance sweep (W8b fix round 1): the staging
 * files a crash left beside a file create. A create stages its bytes under a
 * dot-prefixed `.<uuid>.staged.tmp` in the file's folder and places or drops
 * them within the request (packages/files/src/disk.ts); a process that dies
 * in between leaves the staging file, and the files watcher ignores it.
 *
 * The rule lives in @mantle/files (sweepStagedLeftovers): exact staging
 * names only, an hour old or more, no symlink followed, no dot folder
 * entered. This module adds the stores that must never be walked even when
 * one is mounted inside the files root: the app and table databases, the
 * members' personal files and the sandboxes. Shared by the nightly cron
 * (sweeps.ts) and the script (scripts/files-staged-reap.ts).
 */
import { env } from '@mantle/config';
import { appDbRoot } from '@mantle/content/app-broker';
import { spacesRoot, sweepStagedLeftovers } from '@mantle/files';
import { tableDbRoot } from '@mantle/tabledb';

/** The stores the sweep never walks into, whatever the files root holds. */
export function stagedReapExclusions(): string[] {
  const out = [appDbRoot(), tableDbRoot()];
  try {
    out.push(spacesRoot());
  } catch {
    // No spaces root on this process (production without it): nothing to skip.
  }
  const sandboxes = env('SANDBOXES_DIR')?.trim();
  if (sandboxes) out.push(sandboxes);
  return out;
}

export interface FilesStagedReapResult {
  removed: number;
  skipped: string | null;
}

/** Remove (or, dry, count) the staging files a crash left under the files root. */
export async function runFilesStagedReap(
  opts: { dryRun?: boolean } = {},
): Promise<FilesStagedReapResult> {
  return sweepStagedLeftovers({ exclude: stagedReapExclusions(), dryRun: opts.dryRun });
}

/** One line for the run row. */
export function summariseFilesStagedReap(r: FilesStagedReapResult, dryRun = false): string {
  if (r.skipped) return `skipped: ${r.skipped}`;
  if (r.removed === 0) return 'no leftover staging files';
  return dryRun
    ? `${r.removed} leftover staging file(s) due. DRY RUN: pass --apply to remove them`
    : `removed ${r.removed} leftover staging file(s)`;
}
