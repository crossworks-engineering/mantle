/**
 * The step of `sheet`: an Excel workbook (xlsx, xls) or a CSV file to one
 * tab for each sheet with rows. One step, one write call. It runs in the
 * parser job `pipelineRun`, as every package does, so a CSV's database read
 * is a parser job too (it was read in the brain's process before the move).
 *
 * The step is only this: the engine is kit (../../../sheet-grid.ts and the
 * files it uses), shared with the Table import routes, the Table tools and
 * the text read, which call it as before. A workbook is read with exceljs, a
 * legacy binary is converted first, and any other bytes are read as
 * delimited text (parseDelimited), whatever their extension, as the old path
 * did. A file the engine cannot read throws, and the job fails with its word.
 *
 * The early CSV cap stays in the core (parseFileSheets), so a CSV past it
 * costs no job.
 */
import { FILE_TABS_WRITE, type PipelineStep } from '../../contract';
import { readSpreadsheetGrid } from '../../../sheet-grid';

export const step: PipelineStep = async (req, job) => {
  const tabs = await readSpreadsheetGrid(await job.bytes(), req.file?.ext ?? '');
  return { status: 'ok', calls: [{ call: 'tool', tool: FILE_TABS_WRITE, input: { tabs } }] };
};
