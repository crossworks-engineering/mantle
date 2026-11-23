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
 * A long file is read in part, never refused whole (ingest program A2 and
 * C3): the database keeps the first rows up to the import ceiling
 * (TABLE_IMPORT_MAX_ROWS) and the read budget (MANTLE_FILE_DB_CSV_MAX_MB of
 * cell text), the rest is counted, and the write says the cut (`readCuts`,
 * docs/files.md "Read in part"). A CSV is read as a stream, and a workbook
 * past the size check of ./sheet-read.ts too.
 */
import { FILE_TABS_WRITE, type PipelineStep } from '../../contract';
import { readSpreadsheetGrid } from '../../../sheet-grid';
import { fileDbRowKeeper } from '../../../sheet-to-grid';

export const step: PipelineStep = async (req, job) => {
  const keep = fileDbRowKeeper();
  const tabs = await readSpreadsheetGrid(await job.bytes(), req.file?.ext ?? '', keep);
  const readCuts = keep.cut();
  return {
    status: 'ok',
    calls: [
      { call: 'tool', tool: FILE_TABS_WRITE, input: { tabs, ...(readCuts ? { readCuts } : {}) } },
    ],
  };
};
