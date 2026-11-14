/**
 * The step of `plot-dwf`: an Autodesk DWF plot set to its registry workbook,
 * the tabs Sheets, Layers and Labels (./dwf.ts), with the description of a
 * DWF database. One step, one write call. It runs in the parser job
 * `pipelineRun`.
 *
 * - Not a DWF by its magic (usually a renamed DWFx): `ok` with no tabs, as
 *   the old path gave no sheets. The write spot gives the word `no-rows`.
 * - A DWF with no 2D sheets: the same, no tabs and no description.
 * - A DWF that cannot be opened throws: a failed job, counted, and the file
 *   gets its word after the second count, as before.
 * - Else the three tabs and the description.
 *
 * Only the database read is here. The text for search (the job `text`,
 * ../../../read-document.ts) and the sheet pictures (the job `images`,
 * ../../../dwf-images.ts) stay on their routes and read ./dwf.ts too.
 */
import { FILE_TABS_WRITE, type PipelineStep } from '../../contract';
import { parseDwfToGrids, sniffDwf } from './dwf';

export const step: PipelineStep = async (_req, job) => {
  const bytes = await job.bytes();
  if (!sniffDwf(bytes)) return { status: 'ok' };
  const tabs = await parseDwfToGrids(bytes);
  return {
    status: 'ok',
    calls: [
      {
        call: 'tool',
        tool: FILE_TABS_WRITE,
        input: tabs.length > 0 ? { tabs, description: DWF_DESCRIPTION } : { tabs },
      },
    ],
  };
};

/** What a reader of a DWF database's tabs must know before a query. */
export const DWF_DESCRIPTION =
  `Autodesk DWF plot-set registry. Layers is the cross-sheet layer/circuit` +
  ` registry; Labels is every annotation string with its occurrence count and` +
  ` sheets. Vector geometry is not in this table: read the Source DWG named` +
  ` per row in Sheets for measurements.`;
