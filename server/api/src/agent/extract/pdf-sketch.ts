/**
 * Extractor: the sketch read of a scanned drawing. A PDF whose database says
 * it is a scan drawing (kinds `isometric`, `scan`, `other_drawing`:
 * packages/files/src/pdf-kind.ts) has its scan pages read part by part by
 * the owner's vision worker, in place of the whole-page read
 * (./images.ts `ocrIngestPdfNode`): the parser cuts each page's text into
 * numbered pieces and packs them into at most 4 pictures (`/pdf/pieces`, no
 * model), and each picture is one vision call that answers `number: text`
 * (packages/files/src/pdf-sketch.ts).
 *
 * What it gives: rows in the file's database (`Texts`, `Tags`, `Lines` with
 * `Source` `ocr`, and `Gaps`), written over the database of the same bytes,
 * and the text of the scan as markdown, which the caller takes as the
 * file's text.
 *
 * Every scan page of the file is read: a batch of SKETCH_BATCH_PAGES pages
 * a parser job, each batch asked before the next is cut, all in this one
 * extract. Nothing is left out in silence: a page not read whole (past the
 * per-file cap SKETCH_MAX_PAGES, not reached in the read's time, after a
 * call that did not run, or not cut) is stated in `Pages` (`Vision status`)
 * and `File` (`Scan pages not read`, and why), and the file is read in part
 * (the cut `scan_pages`, so the coverage counts it as not read in full).
 *
 * Cost. It runs inside an admitted extract only, after the extract's cost
 * guard (`llmWorkAllowed`), for at most SKETCH_MAX_PAGES (500) pages of a
 * file and 4 pictures a page, each call within the box's spend caps (a day
 * cap is a wait). No page is started once the vision calls have taken the
 * read's share of the job's time (SKETCH_TIME_SHARE of the box's extract
 * time budget; cutting pages is not counted, so every read again reads on):
 * the pages left are stated (`time`), never asked by anything that starts
 * by itself. A long file's cut can take a job past its budget: the queue
 * then tries it again, and the try again finds the read written, or pays
 * for no picture read (the answer cache).
 *
 * When it runs. One time for a file and its bytes: the database's `File`
 * tab holds `Vision read`, and a database that has it is not read again,
 * but for one that left scan pages not read on a node with no text: a
 * person's read again of a file read in part (file_reindex drops its text
 * for it). That read asks only for the pictures it has no kept answer of:
 * the answers a sketch read kept are taken whatever the read-again stamp
 * (an empty answer is not kept as one). A retry of the
 * extract after the text was stored finds the text, and does not read again.
 * A copy of the file is another file, with its own database and its own
 * read. When the worker reads no picture at all (none is wired, or every
 * call failed), nothing is written, and the next extract of the file tries
 * again. Two calls in a row that fail stop the read: those pictures and
 * the ones after them are stated (`Gaps`, `not_read`) and are not asked
 * again in this read; one picture that fails alone is stated, and the read
 * goes on.
 *
 * The order is for money (docs/pipelines.md, "The PDF set"). The page facts
 * (`/pdf/drawing`) are read before the first vision call. The pieces
 * (`/pdf/pieces`) are cut a batch at a time, so a later batch's cut runs
 * after paid calls: every paid answer is kept as it comes (@mantle/db
 * answer-cache.ts), so a parser busy in a later batch only makes the
 * extract try again, and the try again pays for none of the pictures read.
 * After the last vision call only code in this process and the one write
 * run. That is why this is a core path that uses the reader's kit, and not
 * steps of the package `drawing-pdf`.
 */
import { createHash } from 'node:crypto';
import { getDefaultWorker, llmWorkAllowed, nodes } from '@mantle/db';
import { withAnswerCache } from '@mantle/db/answer-cache';
import { resolveEmbeddingConfig } from '@mantle/embeddings';
import { resolveExtractionTimeBudget } from '@mantle/embeddings/extraction-concurrency';
import {
  SKETCH_BATCH_PAGES,
  SKETCH_KINDS,
  SKETCH_MAX_PAGES,
  SKETCH_PROMPT,
  SKETCH_TIME_SHARE,
  fileDbSqlitePath,
  isFileSha256,
  isParserError,
  parserPdfDrawing,
  parserPdfPieces,
  pdfDrawingSheets,
  pagesNotReadWhole,
  pdfReadPoorer,
  sketchMarkdown,
  sketchPageNone,
  sketchPageRead,
  sketchPagesOf,
  titleBlockOf,
  withPageKinds,
  type PdfKind,
  type PdfPageKind,
  type SketchPagePieces,
  type SketchRead,
} from '@mantle/files';
import { noteReadCut } from '@mantle/files/read-cut-sink';
import { buildFileDatabase, readFileRowNow } from '@mantle/content/file-database';
import { sketchStateOf, storedPageKindsOf, storedPdfOf } from '@mantle/content/pdf-read';
import { boxPipelines } from '@mantle/content/pipeline-registry';
import { pipelineOffHere, pipelineStateOf } from '@mantle/content/pipeline-state';
import { runVisionWorker } from '@mantle/runtime/agent';
import { callThroughWaits, ProviderWaitError } from '@mantle/std';
import { startTrace, step } from '@mantle/tracing';
import { loadFileBytes } from './file-bytes';

/** Tokens one picture's answer may take, at most, and for each of its
 *  pieces: a short line a piece. The cap of a call follows its pieces, so a
 *  scan that tells the model to write at length cannot buy more. */
const SKETCH_MAX_TOKENS = 8000;
const SKETCH_TOKENS_A_PIECE = 40;

/** The read's time: its share of the box's extract time budget (the saved
 *  setting, MANTLE_EXTRACT_EXPIRE_MIN, then 60 minutes), in ms. */
async function sketchTimeMs(ownerId: string): Promise<number> {
  const cfg = await resolveEmbeddingConfig(ownerId).catch(() => null);
  return resolveExtractionTimeBudget(cfg?.extractionTimeBudgetMinutes) * 60_000 * SKETCH_TIME_SHARE;
}

/**
 * Whether the database of the node's bytes holds a sketch read that left
 * scan pages not read, or its File tab cannot be read now (fail closed):
 * the extract's one check before any other read of a PDF with no text on
 * its node. Such a node lost its text to a person's read again (file_reindex,
 * pdfTextKeptOf: the same rule, sketchStateOf), so a sketch read that did
 * not run now must not be replaced by a text-layer, native or whole-page
 * read: the extract fails and is tried again.
 */
export async function sketchPagesLeftOn(node: typeof nodes.$inferSelect): Promise<boolean> {
  const sha = (node.data as Record<string, unknown> | null)?.sha256;
  if (!isFileSha256(sha)) return false;
  const abs = await fileDbSqlitePath(node.id, sha);
  if (!abs) return false;
  const state = await sketchStateOf(abs);
  return state === 'left' || state === 'unknown';
}

/**
 * The sketch read of one PDF file node, when it is due: the file has a
 * database for its bytes that says a sketch kind and holds no vision read,
 * or one that left scan pages not read while the node holds no text.
 * Null when it is not due or could not run (nothing was written and nothing
 * was paid for, but for calls that failed); else the text of the scan, ''
 * when the model read none.
 */
export async function sketchIngestPdfNode(
  node: typeof nodes.$inferSelect,
  ownerId: string,
): Promise<{ text: string } | null> {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const sha = data.sha256;
  if (!isFileSha256(sha)) return null;
  const abs = await fileDbSqlitePath(node.id, sha);
  if (!abs) return null;
  const file = await storedPdfOf(abs);
  if (!file || !(SKETCH_KINDS as readonly string[]).includes(file.kind)) return null;
  // Read before: due again only for pages it left that a read again can
  // read (scanPagesLeft, the rule of sketchStateOf), on a node whose text is
  // gone (a person's read again). Its text on the node is that read's: a
  // retry of the extract never reads on top of it.
  const hasText = typeof data.text === 'string' && data.text.trim() !== '';
  if (file.visionRead && (file.scanPagesLeft === 0 || hasText)) return null;
  // The page types of its tab Pages (the router's part 2): the database is
  // written whole below, so they are put in again. A tab that cannot be
  // read is no sketch read now (before any spend): a paid page answer is
  // never written over.
  let pageKinds: PdfPageKind[];
  try {
    pageKinds = storedPageKindsOf(abs);
  } catch {
    return null;
  }
  // The reader's off list (docs/pipelines.md, "Where a pipeline runs"): the
  // sketch read starts by itself, so it honours off. It is read before every
  // gate that leads to spend: where `drawing-pdf` is off in the file's home
  // workspace the read is not due, and nothing is asked, paid or written.
  // The same state gives the read its options below. A file row that is
  // gone is not due either.
  const state = await pipelineStateOf(ownerId, (await boxPipelines(ownerId)).readerFor('pdf')!);
  const now = await readFileRowNow(node.id, ownerId);
  if (!now || pipelineOffHere(state, now.home)) return null;
  // No model work for this file, or no vision worker to ask: no parser work
  // either.
  if (!(await llmWorkAllowed(node.id))) return null;
  if (!(await getDefaultWorker(ownerId, 'vision'))) return null;
  const loaded = await loadFileBytes(node);
  if (!loaded || createHash('sha256').update(loaded.bytes).digest('hex') !== sha) return null;
  const { bytes, filename } = loaded;

  return startTrace(
    {
      kind: 'photo_ingest',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      data: { source: 'extractor', mode: 'pdf_sketch', filename },
    },
    async () => {
      // The box's options of the reader (the title block), so the rows of
      // this read and the stamp follow them as an upload's do.
      const titleBlock = titleBlockOf(state.options);
      // No page is started once the vision calls have taken this: the read's
      // share of the job's time. Cutting pages is not counted, so a read
      // again, which cuts every page again and takes the kept answers, always
      // gets its share for the pages left.
      const budget = await sketchTimeMs(ownerId);
      // The page facts again (the parser, no model): the database is written
      // whole, so it needs them beside the read.
      const drawing = await step(
        { name: 'read_drawing', kind: 'compute', input: {} },
        async (h) => {
          const d = await parserPdfDrawing(bytes, titleBlock);
          h.setMeta({ pages: d.numPages });
          return d;
        },
      );
      const { pages, pastCap } = sketchPagesOf(drawing, file.kind as PdfKind);
      if (pages.length === 0) return null;
      // The database is written again from THIS read of the page facts. A
      // read poorer than the first (a page over its time on a busy parser:
      // another kind, or more pages not read whole) must not replace the
      // first: nothing is asked and nothing is written, and the next extract
      // tries again.
      if (
        pdfReadPoorer({ rulesKind: drawing.kind, notReadWhole: pagesNotReadWhole(drawing) }, file)
      ) {
        return null;
      }

      // `model`: the model that read a picture, null while none has.
      // `stopped`: two calls in a row that did not run (the worker down, a
      // rate limit) stop the read: the pictures after them are not asked;
      // one picture the provider refuses alone never stops the pages after
      // it (`failed`: calls in a row that did not run). With nothing read,
      // nothing is written and a later extract reads it all. `spent`: ms in
      // vision calls, against the read's share of the time.
      const run = { model: null as string | null, stopped: false, spent: 0, failed: 0 };
      const late = () => run.spent >= budget;
      const read: SketchRead['pages'] = [];
      /** The answers of one page's pictures, in order; null for a picture
       *  with no answer (its call did not run, or the read stopped). */
      const askPage = async (page: SketchPagePieces): Promise<(string | null)[]> => {
        const answers: (string | null)[] = [];
        for (const [k, png] of page.pictures.entries()) {
          if (run.stopped) {
            answers.push(null);
            continue;
          }
          const t0 = Date.now();
          const res = await step(
            {
              name: 'extract_vision',
              kind: 'llm_call',
              input: { page: page.page, picture: k + 1, bytes: png.length },
            },
            async (h) => {
              // A short "not now" of the provider is waited through here, so
              // the pictures read before it are not paid again
              // (@mantle/std callThroughWaits).
              const r = await callThroughWaits(
                () =>
                  runVisionWorker({
                    ownerId,
                    bytes: png,
                    mimeType: 'image/png',
                    filename: `${filename}#page-${page.page}-part-${k + 1}.png`,
                    prompt: SKETCH_PROMPT,
                    // The answer cap follows the pieces: a thinking model's hidden
                    // thinking would fill it and cut the answer off (bench
                    // 2026-11-11: 16 of 508 pieces read without this, 431 with it).
                    leastThinking: true,
                    // A provider that failed (a timeout) is asked one time more
                    // before the read stops: the pictures after a stop are lost.
                    tries: 2,
                    maxTokens: Math.min(
                      SKETCH_MAX_TOKENS,
                      200 +
                        SKETCH_TOKENS_A_PIECE * page.pieces.filter((x) => x.picture === k).length,
                    ),
                  }),
                (a) => a.wait,
              );
              h.setMeta({
                ran: r.ran,
                note: r.note,
                model: r.model,
                page: page.page,
                textLength: r.text.length,
              });
              return r;
            },
          );
          // Still "not now": the whole read waits in the queue
          // (extract-queue.ts), never written with pictures left unread.
          // The pictures read before it are kept answers (@mantle/db
          // answer-cache.ts): the try again pays for none of them twice.
          run.spent += Date.now() - t0;
          if (res.wait) throw new ProviderWaitError(res.wait, 'vision');
          if (res.ran) {
            run.model = res.model ?? 'unknown';
            run.failed = 0;
          } else if (++run.failed >= 2) {
            run.stopped = true;
          }
          answers.push(res.ran ? res.text : null);
        }
        return answers;
      };
      // This read's kept answers are taken also on a person's read again
      // (the scope's `since` left out): a read again of a file read in part
      // asks only for the pictures it has no kept answer of (a picture is
      // the same bytes when its page is cut again, and its key names the
      // model and the prompt). The wait's chain (`from`) and the keep's mark are the
      // job's, as in any scope.
      await withAnswerCache(
        async () => {
          // A batch of pages a parser job, each batch asked before the next
          // is cut: only one batch's pictures are held. The next batch starts
          // at the first page whose pictures did not fit in the job's answer
          // (`over_budget`: the parser takes no more after it), so only a
          // page over the budget by itself stays unread.
          let at = 0;
          while (at < pages.length) {
            const batch = pages.slice(at, at + SKETCH_BATCH_PAGES);
            if (run.stopped || late()) {
              for (const n of batch) {
                read.push(sketchPageNone(n, run.stopped ? 'not_read' : 'time'));
              }
              at += batch.length;
              continue;
            }
            let pieces: SketchPagePieces[];
            try {
              pieces = await step(
                {
                  name: 'cut_pieces',
                  kind: 'compute',
                  input: { first: batch[0], pages: batch.length },
                },
                async (h) => {
                  const out = await parserPdfPieces(bytes, batch);
                  h.setMeta({
                    pages: batch.length,
                    past_cap: pastCap.length,
                    pictures: out.reduce((n, p) => n + p.pictures.length, 0),
                    pieces: out.reduce((n, p) => n + p.pieces.length, 0),
                  });
                  return out;
                },
              );
            } catch (err) {
              // Before any picture is read, or a parser busy for now: thrown,
              // as before (a busy parser tries the extract again, and the
              // pictures read are kept answers). A batch the parser refused
              // after others were read is stated, and the read goes on.
              if (run.model === null || !isParserError(err) || err.retryable) throw err;
              for (const n of batch) read.push(sketchPageNone(n, 'no_picture'));
              at += batch.length;
              continue;
            }
            // Pages whose pictures did not fit after the pages before them
            // (`over_budget`) start the next batch; a first page so is
            // stated, alone.
            const over = pieces.findIndex((p) => p.status === 'over_budget');
            const taken = over < 0 ? pieces.length : Math.max(over, 1);
            at += taken;
            for (const page of pieces.slice(0, taken)) {
              // A page the parser could not cut keeps its own status.
              if (!run.stopped && page.status === 'ok' && late()) {
                read.push(sketchPageNone(page.page, 'time'));
                continue;
              }
              read.push(sketchPageRead(page, await askPage(page)));
            }
          }
        },
        null,
        node.id,
      );

      // No picture was read by the model: nothing to store. A read again
      // that read fewer pages whole than the read before (a call failed
      // early) writes nothing either: the first read stands, and the
      // extract is tried again (load-body: the pages are left).
      const model = run.model;
      if (model === null) return null;
      if (read.filter((p) => p.status === 'ok').length < file.scanPagesRead) return null;
      // Past here: no parser job, no model call before the write. The rows
      // are made in this process, and the one write is buildFileDatabase
      // with `parsed` (it reads nothing). Only after the write, with `Vision
      // read` set, may the build's `after` pipelines run their jobs.

      const sketch: SketchRead = { model, pages: read, pagesPastCap: pastCap, titleBlock };
      const built = await step(
        { name: 'file_database', kind: 'compute', input: { sourceFileId: node.id } },
        async (h) => {
          const written = pdfDrawingSheets(
            drawing,
            file.decision,
            sketch,
            // The stored kind stays the file's kind, as on a read again.
            file.kind as PdfKind,
          );
          // The page types put back, with their note (withPageKinds).
          const { sheets, description } = withPageKinds(written, pageKinds);
          const out = await buildFileDatabase({
            fileId: node.id,
            ownerId,
            sha256: sha,
            bytes,
            filename,
            parsed: {
              kind: 'sheets',
              sheets,
              description,
              ...(state.optionsHash ? { optionsHash: state.optionsHash } : {}),
            },
          });
          h.setMeta({ ...out });
          return out;
        },
      );
      // The bytes moved on, or the file turned private: its read is not kept
      // and is not its text.
      if (built.status !== 'built') return null;
      // A scan page not read whole makes the file partial (the read's cut,
      // docs/files.md "Read in part"): File and Pages say which and why.
      const pagesRead = read.filter((p) => p.status === 'ok').length;
      noteReadCut('scan_pages', {
        what: 'pages',
        read: pagesRead,
        total: read.length + pastCap.length,
        ...(pastCap.length > 0 ? { limit: SKETCH_MAX_PAGES } : {}),
      });
      return { text: sketchMarkdown(drawing, sketch) };
    },
  );
}
