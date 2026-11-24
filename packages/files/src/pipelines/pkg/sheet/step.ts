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
 * A long file in memory is read in part, never refused whole (the ingest
 * program): the database keeps the first rows up to the import ceiling
 * (TABLE_IMPORT_MAX_ROWS) and the read budget (MANTLE_FILE_DB_CSV_MAX_MB of
 * cell text), the rest is counted, and the write says the cut (`readCuts`,
 * docs/files.md "Read in part"). A CSV is read as a stream, and a workbook
 * past the size check of ./sheet-read.ts too.
 *
 * A read of the file's database (`request.spill`) keeps every row of a long
 * file: past what memory takes, its rows go to the rows file of the job
 * (PIPELINE_ROWS_FILE, ../../../sheet-spill.ts) as they are read, and the
 * write names those tabs (`spilled`). Its limits are the import ceiling,
 * the room of the job's scratch space and the step's deadline; a cut is
 * said as above.
 */
import { FILE_TABS_WRITE, type PipelineStep } from '../../contract';
import { readSpreadsheetGrid, type SpillTo } from '../../../sheet-grid';
import { fileDbRowsSpill } from '../../../sheet-spill';
import { fileDbRowKeeper } from '../../../sheet-to-grid';

/** Time kept at the step's end for its write (the answer's JSON). */
const WRITE_RESERVE_MS = 5_000;

export const step: PipelineStep = async (req, job) => {
  const keep = fileDbRowKeeper();
  const to: SpillTo | undefined = req.spill
    ? {
        open: () => fileDbRowsSpill(job.dir, job.deadline - WRITE_RESERVE_MS),
        spilled: [],
      }
    : undefined;
  const tabs = await readSpreadsheetGrid(await job.bytes(), req.file?.ext ?? '', keep, to);
  const readCuts = to?.spill ? to.spill.cut() : keep.cut();
  const spilled = to?.spill ? to.spilled : undefined;
  return {
    status: 'ok',
    calls: [
      {
        call: 'tool',
        tool: FILE_TABS_WRITE,
        input: { tabs, ...(readCuts ? { readCuts } : {}), ...(spilled ? { spilled } : {}) },
      },
    ],
  };
};
