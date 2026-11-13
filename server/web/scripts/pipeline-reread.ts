/**
 * The `pipeline-reread` task: the CLI face of
 * lib/maintenance/pipeline-reread.ts (read its header first). Manual only,
 * capped, a dry run unless --apply.
 *
 * Reads again the files a built-in pipeline read at an older version, or
 * before stamps, and builds their databases. No model, no extract job, no
 * Table. Needs the parser service, and a writable files folder: on a box,
 * scripts/box-maintain.sh --files-writable.
 *
 *   pnpm pipeline:reread --pipeline=<id>                       # DRY RUN, whole box
 *   pnpm pipeline:reread --pipeline=<id> --apply               # read them
 *     --file=<id>[,<id>]  these files only
 *     --folder=<id>       this folder, and below
 *     --limit=<n>         files read per run (default 100, at most 1000)
 *     --after=<id>        go on after this file id, as the last run printed it
 *
 * Prints ids and counts only (safe on a client box).
 */

import { closeDb } from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { runPipelineReread } from '../lib/maintenance/pipeline-reread';

runPipelineReread(process.argv.slice(2), (line) => console.log(line))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('[pipeline-reread] failed:', errorMessage(err));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
