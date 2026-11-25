/**
 * The step of `plot-dwf`: an Autodesk DWF or DWFx plot set to its file
 * database, with the description of its kind. One step, one write call. It
 * runs in the parser job `pipelineRun`.
 *
 * The rule of the package: bytes with the DWF magic are a DWF (./dwf.ts),
 * any other bytes are tried as a DWFx (./dwfx.ts). By the bytes, not the
 * name, so a renamed DWFx is read as what it is.
 *
 * - A DWF: the tabs Sheets, Layers and Labels; a DWF with no 2D sheets has
 *   no tabs and no description.
 * - A DWFx: the tabs Sheets and Texts; one with no text and no sheet title
 *   has no tabs and no description.
 * - Neither (not a zip, or a zip with no page): `ok` with no tabs. The
 *   write spot gives the word `no-rows`.
 * - A DWF or DWFx that cannot be opened throws: a failed job, counted, and
 *   the file gets its word after the second count, as before.
 *
 * Only the database read is here. The text for search (the job `text`,
 * ../../../read-document.ts) and the DWF sheet pictures (the job `images`,
 * ../../../dwf-images.ts) stay on their routes and read ./dwf.ts and
 * ./dwfx.ts too.
 */
import { FILE_TABS_WRITE, type PipelineStep } from '../../contract';
import type { ParsedSheet } from '../../../sheet-to-grid';
import { parseDwfToGrids, sniffDwf } from './dwf';
import { dwfxToGrids, parseDwfxStructured } from './dwfx';

export const step: PipelineStep = async (_req, job) => {
  const bytes = await job.bytes();
  if (sniffDwf(bytes)) return write(await parseDwfToGrids(bytes), DWF_DESCRIPTION);
  const dwfx = await parseDwfxStructured(bytes);
  if (!dwfx) return { status: 'ok' };
  return write(dwfxToGrids(dwfx.sheets), DWFX_DESCRIPTION);
};

function write(tabs: ParsedSheet[], description: string) {
  return {
    status: 'ok' as const,
    calls: [
      {
        call: 'tool' as const,
        tool: FILE_TABS_WRITE,
        input: tabs.length > 0 ? { tabs, description } : { tabs },
      },
    ],
  };
}

/** What a reader of a DWF database's tabs must know before a query. */
export const DWF_DESCRIPTION =
  `Autodesk DWF plot-set registry. Layers is the cross-sheet layer/circuit` +
  ` registry; Labels is every annotation string with its occurrence count and` +
  ` sheets. Vector geometry is not in this table: read the Source DWG named` +
  ` per row in Sheets for measurements.`;

/** What a reader of a DWFx database's tabs must know before a query. */
export const DWFX_DESCRIPTION =
  `Autodesk DWFx plot set (XPS). Sheets is one row per sheet, with the source` +
  ` drawing named in it; Texts is every text run on a sheet, in page order` +
  ` (title block, tags, notes). The linework and the page pictures are not in` +
  ` these tabs: read the Source drawing for geometry.`;
