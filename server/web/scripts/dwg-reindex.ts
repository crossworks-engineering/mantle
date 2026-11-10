/**
 * The `dwg-reindex` task: the CLI face of lib/maintenance/dwg-reindex.ts (read
 * its headers first). Manual only, capped, a dry run unless --apply.
 *
 * Database mode, the default. Builds a table-type file's read-only database from
 * its bytes. No model, no Table. Needs the parser service, and a writable files
 * folder: on a box, scripts/box-maintain.sh --files-writable.
 *
 *   pnpm dwg:reindex                                  # DRY RUN over the whole box
 *   pnpm dwg:reindex --file=<id>[,<id>] --apply       # build these
 *   pnpm dwg:reindex --folder=<id> --apply            # this folder, and below
 *     --limit=<n>     files read per run (default 100, at most 1000)
 *     --after=<id>    go on after this file id, as the last run printed it
 *     --again         also replace a file's word (.none)
 *   pnpm dwg:reindex --orphans [--apply]              # list, and only then remove:
 *                     names with no live row, of other bytes, of a private row,
 *                     and .build-* past the hour
 *   pnpm dwg:reindex --count [--file=... | --folder=...]
 *                     rows per tab, old Table against database. Exits 1 on a
 *                     difference. Run it in the web container.
 *
 * Table mode, by name only. Rebuilds the auto-import workbook of DWG/DXF/DGN files in
 * place; it needs the agent (server/api) for the re-index, and it can pay.
 *
 *   pnpm dwg:reindex --table --file=<id>[,<id>]       # DRY RUN
 *   pnpm dwg:reindex --table --folder=<id> --apply --may-spend
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
 * Prints ids and counts only (safe on a client box).
 */

import { closeDb } from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { runDwgReindex } from '../lib/maintenance/dwg-reindex';

runDwgReindex(process.argv.slice(2), (line) => console.log(line))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('[dwg-reindex] failed:', errorMessage(err));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
