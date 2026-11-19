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
import { PIPELINE_ASK_PAGE_MAX, effectiveOptions, fileDbPaths, keptReaderRun } from '@mantle/files';
import { bookScanPagesOf, bookVisionPagesOf } from './book-pages';
import { readFileDbStamp, readFileRowNow } from './file-database';
import { filePagesOf, pagesText } from './page-passages';
import { SpooledPictures } from './picture-spool';
import { boxPipelines, type BoxPipeline, type BoxPipelines } from './pipeline-registry';
import {
  agentStep,
  isWindowLost,
  pagesReadOf,
  pdfWindowsAt,
  readsInWindows,
  stepFileOf,
  windowJob,
  readerGivesText,
  readerRun,
  readerStandsOver,
  routedRunKey,
  type PipelineRunResult,
} from './pipeline-runner';
import { pipelineOffHere, pipelineStateOf } from './pipeline-state';

export { bookScanPagesOf, readerGivesText };

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
 *  vision, by its name in `bytes`. */
export type BookPagePicture = { file: string; mime: string; caption?: string; page: number };

/** The page pictures of a book (G1), on disk until `drop`. */
export type BookPagePictures = {
  pictures: BookPagePicture[];
  /** The bytes of a picture by its name, read from disk when asked for. */
  bytes: ReadonlyMap<string, Buffer>;
  /** Marked pages that have no picture: a window the parser could not cut
   *  or draw. Counted in the file's pictures left out (G4), never silent. */
  lost: number;
  /** Marked pages left out as they have a picture of these bytes already. */
  had: number;
  /** Remove the pictures from disk: the caller is done. */
  drop(): void;
};

/** The page of a Reader's picture: the Reader says it; else its name
 *  (`page-<NNNNN>.png`, the page of the original file in every window). */
function pageOfPicture(p: { file: string; page?: number }): number | null {
  const page = p.page ?? Number(/page-(\d+)\.(?:png|jpg)$/.exec(p.file)?.[1] ?? NaN);
  return Number.isInteger(page) && page >= 1 ? page : null;
}

/** The Agent that reads a book's marked pages by vision (pdf-page-read): it
 *  claims the kind `book`, gives page text and reads in windows. */
function bookAgentOf(pipelines: BoxPipelines): BoxPipeline | null {
  return (
    pipelines.agents.find(
      (a) =>
        a.match.ext.includes('pdf') &&
        a.match.kind?.includes('book') === true &&
        a.produces.pages === true &&
        readsInWindows(a, 'pdf'),
    ) ?? null
  );
}

/**
 * Draw the pictures of a book's marked pages with the book's Agent step and
 * no model: the step draws a window's
 * marked pages in the parser's pdfjs child before any ask, and the asks are
 * never sent, so this is no paid call. Only the windows that hold the pages
 * are cut (pdfWindowsAt). Each picture is put on disk (`spool`) as it comes,
 * named `drawn-page-<N>.<ext>`. A window the parser cannot cut or draw
 * counts its pages in `lost`; a page the step finds white has no picture
 * and is not lost. A busy parser throws: the extract tries again.
 */
export async function drawBookPages(
  agent: BoxPipeline & { needs: { window: { pages: number; mb: number } } },
  bytes: Buffer,
  sha256: string,
  pages: readonly number[],
  spool: SpooledPictures,
): Promise<{ pictures: BookPagePicture[]; lost: number }> {
  const want = [...new Set(pages)].sort((a, b) => a - b);
  const pictures: BookPagePicture[] = [];
  let lost = 0;
  if (want.length === 0) return { pictures, lost };
  const file = stepFileOf(bytes, 'pdf');
  for await (const w of pdfWindowsAt(bytes, sha256, agent.needs.window, want)) {
    const from = w.part ? w.part.pageFrom : w.from;
    const to = w.part ? w.part.pageTo : w.to;
    const here = want.filter((n) => n >= from && n <= to);
    if (!w.part) {
      lost += here.length;
      continue;
    }
    const { part } = w;
    const read = await windowJob(() =>
      agentStep(
        agent,
        part.bytes,
        file,
        // Every page of the window asked for: the option `pages` caps a
        // run's asks, not what is drawn here.
        { pages: PIPELINE_ASK_PAGE_MAX },
        {
          kind: 'book',
          state: { readerOptions: {}, visionPages: here },
          window: { pageFrom: part.pageFrom, pageTo: part.pageTo, pagesTotal: part.pagesTotal },
        },
      ),
    );
    if (isWindowLost(read) || read.status !== 'ok') {
      lost += here.length;
      continue;
    }
    for (const ask of read.asks) {
      const input = (ask.input ?? {}) as Record<string, unknown>;
      const page = input.page;
      const name = typeof input.picture === 'string' ? input.picture : null;
      const png = name ? read.pictures.get(name) : undefined;
      if (typeof page !== 'number' || !here.includes(page) || !png) continue;
      const jpeg = png[0] === 0xff && png[1] === 0xd8;
      const at = `drawn-page-${page}.${jpeg ? 'jpg' : 'png'}`;
      spool.put(at, png);
      pictures.push({
        file: at,
        mime: jpeg ? 'image/jpeg' : 'image/png',
        caption: `Page ${page}`,
        page,
      });
    }
  }
  return { pictures, lost };
}

/**
 * The page pictures of a book (G1): a picture of each page the Reader
 * marked for vision (its tab Pages, bookVisionPagesOf), but those in
 * `have` (pages with a picture of these bytes already). First the PNGs of
 * the run the database pass of this extract made, kept for the extract
 * (never a new parser job), on disk (the run's spool, runWindowed). A
 * marked page with no picture there (no run is kept: the memo let it go, or
 * the extract is a retry whose database was written before; or the Reader
 * left it out for its answer's budget) is drawn by the book's Agent step,
 * with no model (drawBookPages), so no page picture is lost in silence:
 * what cannot be drawn is `lost`, counted in the file's pictures left out.
 * Null: the file's database was written by no Reader that stands over the
 * core's PDF read and gives pictures.
 */
export async function standingReaderPictures(
  ownerId: string,
  file: { id: string; sha256: unknown },
  bytes: Buffer,
  have: ReadonlySet<number> = new Set(),
): Promise<BookPagePictures | null> {
  if (typeof file.sha256 !== 'string') return null;
  const sha256 = file.sha256;
  const pipelines = await boxPipelines(ownerId);
  const reader = await standingReaderOf(file.id, sha256, pipelines);
  if (!reader || reader.produces.pictures !== true) return null;
  const options = effectiveOptions(reader, (await pipelineStateOf(ownerId, reader)).options);
  const kept = keptReaderRun<PipelineRunResult>(routedRunKey(reader, sha256, 'pdf', options));
  const run = kept ? await kept.catch(() => null) : null;
  const keptBytes: ReadonlyMap<string, Buffer> =
    run?.status === 'ok' ? run.pictures : new Map<string, Buffer>();
  const pictures: BookPagePicture[] = [];
  const pictured = new Set<number>();
  let had = 0;
  for (const p of run?.status === 'ok' ? (run.write?.pictures ?? []) : []) {
    const page = pageOfPicture(p);
    // A picture whose bytes are gone (a spool dropped) is drawn again.
    if (page === null || pictured.has(page) || !keptBytes.has(p.file)) continue;
    pictured.add(page);
    if (have.has(page)) {
      had += 1;
      continue;
    }
    pictures.push({
      file: p.file,
      mime: p.mime,
      ...(p.caption ? { caption: p.caption } : {}),
      page,
    });
  }
  const paths = fileDbPaths(file.id, sha256);
  const marked = paths ? await bookVisionPagesOf(paths.sqlite) : [];
  const missing = marked.filter((n) => !pictured.has(n) && !have.has(n));
  had += marked.filter((n) => !pictured.has(n) && have.has(n)).length;
  const drawn = new SpooledPictures();
  let lost = 0;
  if (missing.length > 0) {
    const agent = bookAgentOf(pipelines);
    if (agent && readsInWindows(agent, 'pdf')) {
      const out = await drawBookPages(agent, bytes, sha256, missing, drawn);
      pictures.push(...out.pictures);
      lost = out.lost;
    } else {
      lost = missing.length;
    }
  }
  pictures.sort((a, b) => a.page - b.page);
  const both: ReadonlyMap<string, Buffer> = {
    get size() {
      return keptBytes.size + drawn.size;
    },
    has: (k: string) => drawn.has(k) || keptBytes.has(k),
    get: (k: string) => drawn.get(k) ?? keptBytes.get(k),
    keys: () => [...keptBytes.keys(), ...drawn.keys()][Symbol.iterator](),
    values: () => [...keptBytes.values(), ...drawn.values()][Symbol.iterator](),
    entries: () => [...keptBytes.entries(), ...drawn.entries()][Symbol.iterator](),
    [Symbol.iterator]: () => [...keptBytes.entries(), ...drawn.entries()][Symbol.iterator](),
    forEach: (fn) => {
      for (const [k, v] of [...keptBytes.entries(), ...drawn.entries()]) fn(v, k, both);
    },
  } as ReadonlyMap<string, Buffer>;
  return {
    pictures,
    bytes: both,
    lost,
    had,
    drop: () => {
      drawn.drop();
      if (keptBytes instanceof SpooledPictures) keptBytes.drop();
    },
  };
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
