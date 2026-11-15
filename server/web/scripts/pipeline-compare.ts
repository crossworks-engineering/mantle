/**
 * The `pipeline-compare` task: the CLI face of
 * lib/maintenance/pipeline-compare.ts (read its header first). Manual only,
 * capped, a dry run (the count) unless --apply. Read-only and model-free.
 *
 * Runs a built-in pipeline now, with no write, on each file that has a
 * database, and compares the result with the stored database: the tab
 * names, the columns, the row count and one hash of the rows of each tab.
 * Needs the parser service.
 *
 *   pnpm pipeline:compare --pipeline=<id>                     # DRY RUN, the count
 *   pnpm pipeline:compare --pipeline=<id> --apply             # compare them
 *     --file=<id>[,<id>]  these files only
 *     --folder=<id>       this folder, and below
 *     --limit=<n>         files compared per run (default 100, at most 1000)
 *     --after=<id>        go on after this file id, as the last run printed it
 *
 * Prints counts only (safe on a client box).
 */

import { closeDb } from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { boxPipelinesOfTask } from '../lib/maintenance/dwg-reindex';
import { runPipelineCompare } from '../lib/maintenance/pipeline-compare';

boxPipelinesOfTask()
  .then((pipelines) =>
    runPipelineCompare(process.argv.slice(2), (line) => console.log(line), pipelines),
  )
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('[pipeline-compare] failed:', errorMessage(err));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
