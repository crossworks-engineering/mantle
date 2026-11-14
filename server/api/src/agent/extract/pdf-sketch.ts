/**
 * Extractor: the sketch read of a scanned drawing. A PDF whose database says
 * it is a scan drawing (kinds `isometric`, `scan`, `other_drawing`:
 * packages/files/src/pdf-kind.ts) has its scan pages read part by part by
 * the owner's vision worker, in place of the whole-page read
 * (./images.ts `ocrIngestPdfNode`). It is the later steps of the reader
 * `drawing-pdf` (a package, docs/pipelines.md, "The PDF set"): its first
 * step cuts each page's text into numbered pieces and packs them into at
 * most 4 pictures (no model), each picture is one vision call this file
 * makes for it, answered `number: text` (packages/files/src/pdf-sketch.ts),
 * and its second step joins the answers into the whole database. What
 * stays here is the test of "due", the start, and the vision ask.
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
  builtinForExt,
  SKETCH_KINDS,
  SKETCH_MAX_PIECES,
  SKETCH_PROMPT,
  fileDbSqlitePath,
  isFileSha256,
  type PipelineCallAnswer,
} from '@mantle/files';
import { buildFileDatabase, parsedFileOfRun } from '@mantle/content/file-database';
import { readPdfSketch, storedPdfOf } from '@mantle/content/pdf-read';
import { pipelineStateOf } from '@mantle/content/pipeline-state';
import { runVisionWorker } from '@mantle/runtime/agent';
import { startTrace, step } from '@mantle/tracing';
import { loadFileBytes } from './file-bytes';

/** Tokens one picture's answer may take, at most, and for each of its
 *  pieces: a short line a piece. The cap of a call follows its pieces, so a
 *  scan that tells the model to write at length cannot buy more. */
const SKETCH_MAX_TOKENS = 8000;
const SKETCH_TOKENS_A_PIECE = 40;
/** The largest packed picture a call sends (the cutter's are a few MB). */
const SKETCH_PICTURE_MAX_BYTES = 16 * 1024 * 1024;

/** A vision call of the reader's step, or null: not that shape. The one
 *  check of what is shown to the model: a PNG, its page and picture, and
 *  the count of its pieces, which sets the answer's cap. */
function visionCallOf(
  input: unknown,
): { png: Buffer; page: number; picture: number; pieces: number } | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const whole = (n: unknown, max: number) =>
    Number.isInteger(n) && (n as number) >= 0 && (n as number) <= max;
  if (typeof o.png !== 'string' || !whole(o.page, 1_000_000) || !whole(o.picture, 16)) return null;
  if (!whole(o.pieces, SKETCH_MAX_PIECES)) return null;
  const png = Buffer.from(o.png, 'base64');
  if (png.length === 0 || png.length > SKETCH_PICTURE_MAX_BYTES) return null;
  return { png, page: o.page as number, picture: o.picture as number, pieces: o.pieces as number };
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
  const file = await storedPdfOf(abs);
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
  const reader = builtinForExt('pdf')!;

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
      const state = await pipelineStateOf(ownerId, reader);
      // A call that did not run (the worker down, a rate limit) stops the
      // read: the pictures after it are not asked. With nothing read, the
      // step writes nothing and a later extract reads it all.
      let stopped = false;
      const ask = async (call: { worker: string; input: unknown }): Promise<PipelineCallAnswer> => {
        const pic = call.worker === 'vision' ? visionCallOf(call.input) : null;
        if (!pic) return { ok: false, error: 'refused' };
        if (stopped) return { ok: false, error: 'not_available' };
        const res = await step(
          {
            name: 'extract_vision',
            kind: 'llm_call',
            input: { page: pic.page, picture: pic.picture, bytes: pic.png.length },
          },
          async (h) => {
            const r = await runVisionWorker({
              ownerId,
              bytes: pic.png,
              mimeType: 'image/png',
              filename: `${filename}#page-${pic.page}-part-${pic.picture}.png`,
              prompt: SKETCH_PROMPT,
              // The answer cap follows the pieces: a thinking model's hidden
              // thinking would fill it and cut the answer off (bench
              // 2026-11-11: 16 of 508 pieces read without this, 431 with it).
              leastThinking: true,
              maxTokens: Math.min(SKETCH_MAX_TOKENS, 200 + SKETCH_TOKENS_A_PIECE * pic.pieces),
            });
            h.setMeta({
              ran: r.ran,
              note: r.note,
              model: r.model,
              page: pic.page,
              textLength: r.text.length,
            });
            return r;
          },
        );
        if (!res.ran) {
          stopped = true;
          return { ok: false, error: 'failed' };
        }
        return { ok: true, output: { text: res.text, model: res.model ?? 'unknown' } };
      };
      // The reader with `asks` on: its first step reads the page facts again
      // and cuts the pieces. A read poorer than the first (a page over its
      // time on a busy parser: another kind, or more pages not read whole)
      // asks nothing and writes nothing, and the next extract tries again;
      // so does a read the model read nothing of.
      const run = await step({ name: 'cut_pieces', kind: 'compute', input: {} }, async (h) => {
        const out = await readPdfSketch(reader, bytes, file, state.options, ask);
        h.setMeta({ status: out.status, written: out.write !== undefined });
        return out;
      });
      if (run.status !== 'ok' || !run.write) return null;

      const built = await step(
        { name: 'file_database', kind: 'compute', input: { sourceFileId: node.id } },
        async (h) => {
          const parsed = parsedFileOfRun(reader, run);
          const out = await buildFileDatabase({
            fileId: node.id,
            ownerId,
            sha256: sha,
            bytes,
            filename,
            parsed:
              parsed.kind === 'sheets' && state.optionsHash
                ? { ...parsed, optionsHash: state.optionsHash }
                : parsed,
          });
          h.setMeta({ ...out });
          return out;
        },
      );
      // The bytes moved on, or the file turned private: its read is not kept
      // and is not its text.
      if (built.status !== 'built') return null;
      return { text: run.write.text ?? '' };
    },
  );
}
