/**
 * Rebuild the auto-import workbook of DWG/DXF files in place: the CLI face
 * of lib/maintenance/dwg-reindex.ts (read its header first). The table keeps
 * its id, grants, placement, title and tags; its tabs and description are
 * rebuilt from a fresh sidecar pass. Manual only, scoped, capped.
 *
 * Usage:
 *   pnpm dwg:reindex --file=<file id>[,<file id>]     # DRY RUN: what would be rebuilt
 *   pnpm dwg:reindex --folder=<folder id>             # dry run over a folder (and below)
 *   pnpm dwg:reindex --folder=<id> --apply            # rebuild, at most --limit tables
 *     --limit=<n>      tables per run (default 10, at most 50)
 *     --keep-edits     a table edited after its import: snapshot it, then rebuild
 *     --resummarize    let the commit run the extractor's full pass (one model
 *                      call per table); default keeps the summary (no model pass)
 *                      except for a table whose old description said it has no
 *                      vector geometry (that summary is rewritten, one call each)
 *     --again          include tables already rebuilt (or imported with the
 *                      geometry tabs); by default a run skips them, so repeated
 *                      capped runs reach the rest of the scope
 *
 * Prints ids and counts only (safe on a client box). Needs the media sidecar
 * (the DWG parse) and the agent (server/api) running for the re-index.
 */

import { closeDb } from '@mantle/db';
import { errorMessage } from '@mantle/std';
import {
  clampLimit,
  decide,
  findReindexCandidates,
  needsResummary,
  rebuildOne,
  scopeProblem,
} from '../lib/maintenance/dwg-reindex';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const keepEdits = argv.includes('--keep-edits');
const resummarize = argv.includes('--resummarize');
const again = argv.includes('--again');
const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const limit = clampLimit(flag('limit') ? Number(flag('limit')) : null);
const scope = {
  fileIds: (flag('file') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  ...(flag('folder') ? { folderId: flag('folder')!.trim() } : {}),
};

async function main() {
  const problem = scopeProblem(scope);
  if (problem) {
    console.log(`[dwg-reindex] ${problem}. Nothing done.`);
    process.exitCode = 2;
    return;
  }
  const found = await findReindexCandidates(scope, limit, { again });
  const cut = found.length > limit;
  const chosen = found.slice(0, limit);
  console.log(
    `[dwg-reindex] candidates in scope: ${chosen.length}${cut ? ` (cut at --limit=${limit}; run again for the rest)` : ''}${again ? '' : ' (tables already rebuilt are skipped; --again includes them)'}`,
  );
  if (chosen.length === 0) return;
  for (const c of chosen) {
    const d = decide(c, { keepEdits });
    const has = c.tabs.includes('Segments') ? 'has the bones tabs' : 'no bones tabs';
    const plan =
      d.action === 'refuse'
        ? `refuse (${d.reason})`
        : d.snapshotFirst
          ? 'snapshot, then rebuild'
          : 'rebuild';
    console.log(`  ${c.tableId} (file ${c.fileId}, v${c.version}, ${has}): ${plan}`);
  }
  const rewrite = chosen.filter((c) => needsResummary(c.description, null, { resummarize })).length;
  console.log(
    `  summary: ${resummarize ? 'the full extractor pass runs (one model call per table)' : `kept (no model pass; the vector and profile are rebuilt), except ${rewrite} table${rewrite === 1 ? '' : 's'} whose old description says no vector geometry: rewritten (one model call each)`}`,
  );
  if (!apply) {
    console.log('[dwg-reindex] DRY RUN: pass --apply to rebuild them');
    return;
  }
  const counts = { rebuilt: 0, refused: 0, failed: 0 };
  for (const c of chosen) {
    const r = await rebuildOne(c, { keepEdits, resummarize });
    counts[r.result] += 1;
    if (r.result === 'rebuilt') {
      console.log(
        `  ${r.tableId}: rebuilt as v${r.version} (${r.tabs.length} tabs${r.snapshot ? `, snapshot ${r.snapshot} first` : ''}${r.resummarized ? ', summary rewritten' : ''})`,
      );
    } else {
      console.log(`  ${r.tableId}: ${r.result}: ${r.reason}`);
    }
  }
  console.log(
    `[dwg-reindex] done: ${counts.rebuilt} rebuilt, ${counts.refused} refused, ${counts.failed} failed`,
  );
}

main()
  .catch((err) => {
    console.error('[dwg-reindex] failed:', errorMessage(err));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
