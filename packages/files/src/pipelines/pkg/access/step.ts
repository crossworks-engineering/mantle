/**
 * The step of `access`: a Microsoft Access database (`.accdb`, `.mdb`) to
 * one tab per table, the description of an Access database and the file's
 * text (./access.ts). One step, one write call. It runs in the parser job
 * `pipelineRun`. The core has no text route for these types, so this
 * Reader's text is the file's text (docs/pipelines.md, "Text and pictures
 * from every Reader").
 *
 * - A file with a password: a write with no tabs (the database is the word
 *   `no-rows`), a short text that says it is locked, and the cut
 *   `access_password` with the reason.
 * - A file mdb-reader cannot read throws: a failed job, and the file gets
 *   its word (document_unreadable), as for any reader.
 * - A long file is read in part, never refused whole: the keeper of a file
 *   database read (fileDbRowKeeper) keeps the first rows, the rest is
 *   counted, and the cut is said.
 */
import { FILE_TABS_WRITE, type PipelineStep } from '../../contract';
import { fileDbRowKeeper } from '../../../sheet-to-grid';
import { lockedText, readAccess } from './access';

/** Time kept at the step's end for its write (the answer's JSON). */
const WRITE_RESERVE_MS = 5_000;

export const step: PipelineStep = async (req, job) => {
  const ext = (req.file?.ext ?? '').toLowerCase() === 'mdb' ? 'mdb' : 'accdb';
  const read = readAccess(
    await job.bytes(),
    ext,
    fileDbRowKeeper(),
    job.deadline - WRITE_RESERVE_MS,
  );
  if (read.locked) {
    return {
      status: 'ok',
      calls: [
        {
          call: 'tool',
          tool: FILE_TABS_WRITE,
          input: {
            tabs: [],
            text: lockedText(ext),
            readCuts: { access_password: { what: 'tables', read: 0 } },
          },
        },
      ],
    };
  }
  return {
    status: 'ok',
    calls: [
      {
        call: 'tool',
        tool: FILE_TABS_WRITE,
        input: {
          tabs: read.tabs,
          description: read.description,
          text: read.text,
          ...(Object.keys(read.readCuts).length > 0 ? { readCuts: read.readCuts } : {}),
        },
      },
    ],
  };
};
