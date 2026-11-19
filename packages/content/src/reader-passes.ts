/**
 * The text and the pictures of a file from its Reader (docs/pipelines.md,
 * "Text and pictures from every Reader"). The caller asks only where the
 * core has no reader of its own for that pass: the text pass when the
 * extension has no text route (`parserRouteForExt(ext) === 'none'`), the
 * picture pass when the extension is not one the core reads pictures of. So
 * the core's text and pictures always stand where it has them.
 *
 * The rule, once for both passes: the box's Reader of the extension
 * (boxPipelines) gives a pass it names in `produces` (`text`, with no core
 * text route: readerGivesText; `pictures`),
 * unless it is off in the file's home workspace (pipelineOffHere, the one
 * test the database pass makes too). Its run is the one the database pass
 * made, kept for the extract (readerRun), so the three passes cost one job.
 * No model is asked: the run is model-free.
 */
import { effectiveOptions, keptReaderRun } from '@mantle/files';
import { readFileDbStamp, readFileRowNow } from './file-database';
import { filePagesOf, pagesText } from './page-passages';
import { boxPipelines, type BoxPipelines } from './pipeline-registry';
import {
  pagesReadOf,
  readerGivesText,
  readerRun,
  readerStandsOver,
  routedRunKey,
  type PipelineRunResult,
} from './pipeline-runner';
import { pipelineOffHere, pipelineStateOf } from './pipeline-state';

export { readerGivesText };

export type ReaderPass = 'text' | 'pictures';

/**
 * The run of the Reader of this file for one pass, or null when no Reader
 * of the box gives that pass for the extension, or it is off where the file
 * lives. Nothing runs until the caller calls it with the bytes. `fileId`:
 * the file whose home workspace the off list is read for (null: a file with
 * no row yet, on in every workspace).
 */
export async function readerPassOf(
  ownerId: string,
  fileId: string | null,
  ext: string,
  pass: ReaderPass,
): Promise<((bytes: Buffer) => Promise<PipelineRunResult>) | null> {
  const reader = (await boxPipelines(ownerId)).readerFor(ext);
  if (!reader) return null;
  if (pass === 'text' ? !readerGivesText(reader, ext) : reader.produces.pictures !== true)
    return null;
  const state = await pipelineStateOf(ownerId, reader);
  const home = fileId ? ((await readFileRowNow(fileId, ownerId))?.home ?? null) : null;
  if (pipelineOffHere(state, home)) return null;
  const options = effectiveOptions(reader, state.options);
  return (bytes) => readerRun(reader, bytes, ext, options);
}

/** The text of a Reader's run: its write's `text` when it ended `ok`, else
 *  ''. A failed run throws, as for any document. */
export async function readerTextOf(
  run: (bytes: Buffer) => Promise<PipelineRunResult>,
  bytes: Buffer,
): Promise<string> {
  const r = await run(bytes);
  return r.status === 'ok' ? (r.write?.text ?? '') : '';
}

/** The Reader that wrote the database of a file at these bytes, when it
 *  stands over the core's PDF read (readerStandsOver), or null. */
async function standingReaderOf(fileId: string, sha256: string, pipelines: BoxPipelines) {
  const stamp = await readFileDbStamp(fileId, sha256);
  const reader = stamp ? pipelines.byId(stamp.pipeline_id) : null;
  return reader && readerStandsOver(reader) ? reader : null;
}

/** Whether a PDF's database at these bytes was written by a Reader that
 *  stands over the core's PDF read (a book): the picture pass leaves its
 *  pages to that Reader (server/api/src/agent/extract/images.ts). */
export async function readerStandsOverFile(
  ownerId: string,
  fileId: string,
  sha256: unknown,
): Promise<boolean> {
  if (typeof sha256 !== 'string') return false;
  return (await standingReaderOf(fileId, sha256, await boxPipelines(ownerId))) !== null;
}

/** One page picture of a book (G1): the PNG of a page its Reader left to
 *  vision, by its name in the run's `pictures`. */
export type BookPagePicture = { file: string; mime: string; caption?: string; page: number };

/**
 * The page pictures of a book (G1): the PNG of each page the Reader marked
 * for vision, from the run the database pass of this extract made, kept for
 * the extract (never a new parser job). Their bytes are on disk (the run's
 * spool, runWindowed). Null: the file's database was written by no Reader
 * that stands over the core's PDF read, or no run is kept (a read again of
 * a file whose database is there: its pictures were saved by the read that
 * made it).
 */
export async function standingReaderPictures(
  ownerId: string,
  file: { id: string; sha256: unknown },
): Promise<{ pictures: BookPagePicture[]; bytes: ReadonlyMap<string, Buffer> } | null> {
  if (typeof file.sha256 !== 'string') return null;
  const pipelines = await boxPipelines(ownerId);
  const reader = await standingReaderOf(file.id, file.sha256, pipelines);
  if (!reader || reader.produces.pictures !== true) return null;
  const options = effectiveOptions(reader, (await pipelineStateOf(ownerId, reader)).options);
  const kept = keptReaderRun<PipelineRunResult>(routedRunKey(reader, file.sha256, 'pdf', options));
  const run = kept ? await kept.catch(() => null) : null;
  if (run?.status !== 'ok' || !run.write?.pictures) return null;
  const pictures: BookPagePicture[] = [];
  for (const p of run.write.pictures) {
    // The page of the original file: the Reader says it; else its name
    // (`page-<NNNNN>.png`, the page of the original file in every window).
    const page = p.page ?? Number(/page-(\d+)\.(?:png|jpg)$/.exec(p.file)?.[1] ?? NaN);
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) continue;
    pictures.push({
      file: p.file,
      mime: p.mime,
      ...(p.caption ? { caption: p.caption } : {}),
      page,
    });
  }
  return { pictures, bytes: run.pictures };
}

/** The text of a file whose Reader stands over the core's PDF read, and
 *  the pages it read when it read in windows. */
export type StandingText = { text: string; pages?: { read: number; total: number } };

/**
 * The Reader's text of a PDF whose database a Reader that stands over the
 * core's PDF read wrote (P2, readerStandsOver: it claims the router's kinds
 * and says `produces.text`; a book). Then the core reads no text of its
 * own, runs no native read and no OCR, and stamps no `document_unreadable`
 * (server/api/src/agent/extract/load-body.ts). Null: the file's database
 * was written by no such Reader, or the Reader gave no text.
 *
 * Where the text comes from, in order, never a new parser job: the run the
 * database pass of this extract made, kept (routedReaderRun); else, for a
 * Reader that says `produces.pages`, its pages in the database, joined
 * (`## Page N` before each). The pages read come from the run, else from
 * the database's `_meta`.
 */
export async function standingReaderText(
  ownerId: string,
  file: { id: string; sha256: unknown },
  ext: string,
): Promise<StandingText | null> {
  if (ext !== 'pdf' || typeof file.sha256 !== 'string') return null;
  const pipelines = await boxPipelines(ownerId);
  const reader = await standingReaderOf(file.id, file.sha256, pipelines);
  if (!reader) return null;
  const options = effectiveOptions(reader, (await pipelineStateOf(ownerId, reader)).options);
  const kept = keptReaderRun<PipelineRunResult>(routedRunKey(reader, file.sha256, ext, options));
  const run = kept ? await kept.catch(() => null) : null;
  if (run?.status === 'ok' && run.write?.text) {
    return {
      text: run.write.text,
      ...(run.windows
        ? { pages: { read: pagesReadOf(run.windows), total: run.windows.pagesTotal } }
        : {}),
    };
  }
  if (reader.produces.pages !== true) return null;
  const pages = await filePagesOf({ id: file.id, ownerId, sha256: file.sha256 }, pipelines);
  if (!pages || pages.pages.length === 0) return null;
  return { text: pagesText(pages.pages), ...(pages.read ? { pages: pages.read } : {}) };
}
