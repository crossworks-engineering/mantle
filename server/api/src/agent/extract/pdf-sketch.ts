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
 * Cost. It runs inside an admitted extract only, after the extract's cost
 * guard (`llmWorkAllowed`), for at most 10 pages of a file and 4 pictures a
 * page: 40 vision calls a file at most. It runs once for a file's bytes: the
 * database's `File` tab holds `Vision read`, and a database that has it is
 * not read again. When the worker reads no picture at all (none is wired, or
 * every call failed), nothing is written, and the next extract of the file
 * tries again. A call that fails after others ran stops the read: that
 * picture and the ones after it are stated (`Gaps`, `not_read`) and are not
 * asked again.
 */
import { createHash } from 'node:crypto';
import { getDefaultWorker, llmWorkAllowed, nodes } from '@mantle/db';
import {
  SKETCH_KINDS,
  SKETCH_PROMPT,
  fileDbSqlitePath,
  isFileSha256,
  parserPdfDrawing,
  parserPdfPieces,
  pdfDrawingSheets,
  pdfFileTabOf,
  pagesNotReadWhole,
  sketchMarkdown,
  sketchPageRead,
  sketchPagesOf,
  type PdfKind,
  type SketchRead,
} from '@mantle/files';
import { buildFileDatabase } from '@mantle/content/file-database';
import { runTableSql } from '@mantle/tabledb';
import { runVisionWorker } from '@mantle/runtime/agent';
import { startTrace, step } from '@mantle/tracing';
import { loadFileBytes } from './file-bytes';

/** Tokens one picture's answer may take, at most, and for each of its
 *  pieces: a short line a piece. The cap of a call follows its pieces, so a
 *  scan that tells the model to write at length cannot buy more. */
const SKETCH_MAX_TOKENS = 8000;
const SKETCH_TOKENS_A_PIECE = 40;

/** The `File` tab of a PDF's database (`pdfFileTabOf`), or null: not a PDF
 *  drawing database, or it went just now. */
async function readFileTab(abs: string) {
  try {
    const r = await runTableSql(abs, 'SELECT * FROM "File"', { cap: 1 });
    return r.rows[0] ? pdfFileTabOf(r.columns, r.rows[0]) : null;
  } catch {
    return null;
  }
}

/**
 * The sketch read of one PDF file node, when it is due: the file has a
 * database for its bytes that says a sketch kind and holds no vision read.
 * Null when it is not due or could not run (nothing was written and nothing
 * was paid for, but for calls that failed); else the text of the scan, ''
 * when the model read none.
 */
export async function sketchIngestPdfNode(
  node: typeof nodes.$inferSelect,
  ownerId: string,
): Promise<{ text: string } | null> {
  const sha = (node.data as Record<string, unknown> | null)?.sha256;
  if (!isFileSha256(sha)) return null;
  const abs = await fileDbSqlitePath(node.id, sha);
  if (!abs) return null;
  const file = await readFileTab(abs);
  if (!file || file.visionRead || !(SKETCH_KINDS as readonly string[]).includes(file.kind)) {
    return null;
  }
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
      // The page facts again (the parser, no model): the database is written
      // whole, so it needs them beside the read.
      const cut = await step({ name: 'cut_pieces', kind: 'compute', input: {} }, async (h) => {
        const drawing = await parserPdfDrawing(bytes);
        const { pages, pastCap } = sketchPagesOf(drawing, file.kind as PdfKind);
        const pieces = pages.length > 0 ? await parserPdfPieces(bytes, pages) : [];
        h.setMeta({
          pages: pages.length,
          past_cap: pastCap.length,
          pictures: pieces.reduce((n, p) => n + p.pictures.length, 0),
          pieces: pieces.reduce((n, p) => n + p.pieces.length, 0),
        });
        return { drawing, pieces, pastCap };
      });
      if (!cut.pieces.some((p) => p.pictures.length > 0)) return null;
      // The database is written again from THIS read of the page facts. A
      // read poorer than the first (a page over its time on a busy parser:
      // another kind, or more pages not read whole) must not replace the
      // first: nothing is asked and nothing is written, and the next extract
      // tries again.
      if (
        cut.drawing.kind !== file.rulesKind ||
        pagesNotReadWhole(cut.drawing) > file.notReadWhole
      ) {
        return null;
      }

      let model: string | null = null;
      // A call that did not run (the worker down, a rate limit) stops the
      // read: the pictures after it are not asked. With nothing read,
      // nothing is written and a later extract reads it all.
      let stopped = false;
      const read: SketchRead['pages'] = [];
      for (const page of cut.pieces) {
        const answers: (string | null)[] = [];
        for (const [k, png] of page.pictures.entries()) {
          if (stopped) {
            answers.push(null);
            continue;
          }
          const res = await step(
            {
              name: 'extract_vision',
              kind: 'llm_call',
              input: { page: page.page, picture: k + 1, bytes: png.length },
            },
            async (h) => {
              const r = await runVisionWorker({
                ownerId,
                bytes: png,
                mimeType: 'image/png',
                filename: `${filename}#page-${page.page}-part-${k + 1}.png`,
                prompt: SKETCH_PROMPT,
                // The answer cap follows the pieces: a thinking model's hidden
                // thinking would fill it and cut the answer off (bench
                // 2026-11-11: 16 of 508 pieces read without this, 431 with it).
                leastThinking: true,
                maxTokens: Math.min(
                  SKETCH_MAX_TOKENS,
                  200 + SKETCH_TOKENS_A_PIECE * page.pieces.filter((x) => x.picture === k).length,
                ),
              });
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
          if (res.ran) model = res.model ?? 'unknown';
          else stopped = true;
          answers.push(res.ran ? res.text : null);
        }
        read.push(sketchPageRead(page, answers));
      }
      // No picture was read by the model: nothing to store.
      if (model === null) return null;

      const sketch: SketchRead = { model, pages: read, pagesPastCap: cut.pastCap };
      const built = await step(
        { name: 'file_database', kind: 'compute', input: { sourceFileId: node.id } },
        async (h) => {
          const { sheets, description } = pdfDrawingSheets(cut.drawing, file.decision, sketch);
          const out = await buildFileDatabase({
            fileId: node.id,
            ownerId,
            sha256: sha,
            bytes,
            filename,
            parsed: { kind: 'sheets', sheets, description },
          });
          h.setMeta({ ...out });
          return out;
        },
      );
      // The bytes moved on, or the file turned private: its read is not kept
      // and is not its text.
      if (built.status !== 'built') return null;
      return { text: sketchMarkdown(cut.drawing, sketch) };
    },
  );
}
