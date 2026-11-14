/**
 * The core's part of a PDF read (docs/pipelines.md, "The PDF set"): the
 * router and the reader are packages (`pdf-router`, `drawing-pdf`), run by
 * the parser one step a job (./pipeline-runner.ts). What stays here is what
 * only the core holds:
 *
 * - The decider's ask. The router's step returns one `decider` call for a
 *   file its rules leave unsure; the core checks what the step would send
 *   (pdfKindAskOf), asks, and keeps the answer, so the reader's File tab can
 *   hold it, also a shadow answer that is not used.
 * - The stored state of a PDF's bytes a read again works from
 *   (pdfReadAgainOf: one read, fail closed): the kind and the decision it
 *   keeps, and the stat its write is conditional on. The decision reaches
 *   the reader's first step as its `state` (runPackaged's `opts.state`),
 *   never in `request.kind` alone.
 *
 * The sketch read of a scan is not here: it is a core path of its own
 * (server/api/src/agent/extract/pdf-sketch.ts). Nothing is written here:
 * the caller writes at the one write spot.
 */
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import {
  pdfFileTabOf,
  pdfKindAskOf,
  type PdfKindAsk,
  type PdfKindDecision,
  type PipelineManifest,
} from '@mantle/files';
import { runTableSql } from '@mantle/tabledb';
import { runPackaged, stepFileOf, PipelineRunError, type PipelineAsk } from './pipeline-runner';

/** What a PDF's stored File tab says (pdfFileTabOf). */
export type StoredPdf = NonNullable<ReturnType<typeof pdfFileTabOf>>;

/** How the caller asks the decider about an unsure PDF. Null: no answer,
 *  and the file stays unsure. */
export type PdfDecide = (ask: PdfKindAsk) => Promise<PdfKindDecision | null>;

/** The `File` tab of a PDF's database at `abs`, or null: no database, not a
 *  PDF drawing database, or it went just now. */
export async function storedPdfOf(abs: string): Promise<StoredPdf | null> {
  try {
    const r = await runTableSql(abs, 'SELECT * FROM "File"', { cap: 1 });
    return r.rows[0] ? pdfFileTabOf(r.columns, r.rows[0]) : null;
  } catch {
    return null;
  }
}

/** A file as a conditional write compares it: inode, size and mtime. */
export type FileStamp = { ino: number; size: number; mtimeMs: number };

/**
 * What a read again of a PDF works from (buildFileDatabase, no `parsed`):
 * ONE read of the stored state of these bytes, before the job. It fails
 * CLOSED: what cannot be read is a skip, never "nothing stored".
 *
 * - A database with a sketch read: `sketch` (a read with no model would
 *   lose it).
 * - No database and the word `no-rows`: `not-drawing`. For a PDF that word
 *   is the decider's "document" (a drawing read always has its File tab, so
 *   it never ends in no rows), but the word does not say where it came
 *   from, so any `no-rows` of a PDF is kept: the safe side.
 * - A database whose File tab cannot be read, or a stat or a word that
 *   cannot be read: `kept`.
 * - Else the stored File tab (null: no database) and the stat of the
 *   database (null: none) the write is conditional on.
 */
export async function pdfReadAgainOf(names: {
  sqlite: string;
  none: string;
}): Promise<
  | { skip: 'sketch' | 'not-drawing' | 'kept' }
  | { skip: null; stored: StoredPdf | null; since: FileStamp | null }
> {
  try {
    const at = statSync(names.sqlite, { throwIfNoEntry: false });
    if (!at) {
      const word = await readFile(names.none, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return '';
        throw err;
      });
      if (word.trim() === 'no-rows') return { skip: 'not-drawing' };
      return { skip: null, stored: null, since: null };
    }
    const r = await runTableSql(names.sqlite, 'SELECT * FROM "File"', { cap: 1 });
    const stored = r.rows[0] ? pdfFileTabOf(r.columns, r.rows[0]) : null;
    if (!stored) return { skip: 'kept' };
    if (stored.visionRead) return { skip: 'sketch' };
    return { skip: null, stored, since: { ino: at.ino, size: at.size, mtimeMs: at.mtimeMs } };
  } catch {
    return { skip: 'kept' };
  }
}

/** The state the reader's first step gets from the core: the decision. */
export function readerStateOf(decision: PdfKindDecision | null): Record<string, unknown> {
  return { decision };
}

/**
 * The router's run: the kind of the file, and the decider's answer when the
 * router asked (only with `decide`, for a file its rules leave unsure). A
 * run that names no kind is a failure (PipelineRunError, the word
 * `unreadable`). A typed parser failure throws as for every job.
 */
export async function routePdf(
  router: PipelineManifest,
  bytes: Buffer,
  decide: PdfDecide | undefined,
): Promise<{ kind: string; decision: PdfKindDecision | null }> {
  let decision: PdfKindDecision | null = null;
  const ask: PipelineAsk | undefined = decide
    ? async (call) => {
        const state = call.worker === 'decider' ? pdfKindAskOf(call.input) : null;
        if (!state) return { ok: false, error: 'refused' };
        decision = await decide(state);
        return decision ? { ok: true, output: decision } : { ok: false, error: 'not_available' };
      }
    : undefined;
  const run = await runPackaged(router, bytes, stepFileOf(bytes, 'pdf'), {
    options: {},
    ...(ask ? { ask } : {}),
  });
  if (run.status !== 'ok' || typeof run.kind !== 'string') {
    throw new PipelineRunError(`${router.id} named no kind (${run.status})`);
  }
  return { kind: run.kind, decision };
}
