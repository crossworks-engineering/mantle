/**
 * What each parser job does, run inside a job process (./job.ts): one job,
 * one process, which exits when the job is done. The readers live in
 * packages/files (`@mantle/files/readers/*`); this module only maps a route
 * to a reader and writes its answer to the job's directory.
 *
 * A job writes `out.json` (the JSON routes) or `out.bin` plus `meta.json`
 * (the byte routes). A typed failure throws a {@link JobFailure}; the job
 * process turns any throw into `error.json`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PARSER_JOB_TIMEOUT_MS, type ParserJob } from '@mantle/files/parser-wire';
import { isDocumentTooLarge } from '@mantle/files/readers/read-limit';
import { dwfRenderer, dwgCrop, dwgRender, extractAudio } from './cad';
import { JobFailure } from './job-failure';

export type JobPaths = {
  /** The job's own directory: inputs, outputs, scratch. */
  dir: string;
  /** The file's bytes, as the request carried them. */
  input: string;
  /** The JSON answer (JSON routes). */
  outJson: string;
  /** The byte answer (byte routes), with `meta.json` beside it. */
  outBin: string;
  meta: string;
};

export function jobPaths(dir: string): JobPaths {
  return {
    dir,
    input: path.join(dir, 'in.bin'),
    outJson: path.join(dir, 'out.json'),
    outBin: path.join(dir, 'out.bin'),
    meta: path.join(dir, 'meta.json'),
  };
}

/** The byte routes: their answer is `out.bin`, not `out.json`. */
export const BYTE_JOBS: ReadonlySet<ParserJob> = new Set([
  'extractAudio',
  'thumbnail',
  'visionImage',
]);

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new JobFailure('bad_request', `'${name}' is required`);
  return v;
}

function int(v: unknown, dflt: number, lo: number, hi: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : dflt;
  return Math.min(hi, Math.max(lo, n));
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, JSON.stringify(value));
}

/** Run one job. Throws on failure (see the module note). */
export async function runJob(
  job: ParserJob,
  opts: Record<string, unknown>,
  p: JobPaths,
): Promise<void> {
  const timeoutMs = PARSER_JOB_TIMEOUT_MS[job];
  switch (job) {
    case 'text': {
      const { readDocumentText } = await import('@mantle/files/readers/document');
      const text = await readDocumentText(await fs.readFile(p.input), str(opts.ext, 'ext'));
      return writeJson(p.outJson, { ok: true, text });
    }
    case 'images': {
      const { readEmbeddedImages } = await import('@mantle/files/readers/images');
      const result = await readEmbeddedImages(await fs.readFile(p.input), str(opts.ext, 'ext'), {
        maxImages: int(opts.maxImages, 30, 0, 200),
        ...(typeof opts.dpi === 'number' ? { dpi: int(opts.dpi, 300, 50, 600) } : {}),
        render: dwfRenderer(p.dir, timeoutMs),
      });
      return writeJson(p.outJson, {
        ok: true,
        candidates: result.candidates,
        rejected: result.rejected,
        images: result.images.map((img) => ({
          bytes_base64: img.bytes.toString('base64'),
          ext: img.ext,
          ordinal: img.ordinal,
          width: img.width ?? null,
          height: img.height ?? null,
          location: img.location ?? null,
          altText: img.altText ?? null,
          caption: img.caption ?? null,
          heading: img.heading ?? null,
          essential: img.essential === true,
          provenance: img.provenance ?? null,
        })),
      });
    }
    case 'grid': {
      const ext = str(opts.ext, 'ext').toLowerCase();
      const bytes = await fs.readFile(p.input);
      if (ext === 'xml') {
        const { parseMspdi, sniffMspdi } = await import('@mantle/files/readers/mspdi');
        const plan = sniffMspdi(bytes) ? parseMspdi(bytes) : null;
        return writeJson(p.outJson, {
          ok: true,
          sheets: plan?.sheets ?? [],
          plan: plan
            ? { taskCount: plan.meta.taskCount, summaryCount: plan.meta.summaryCount }
            : null,
        });
      }
      if (ext === 'dwf') {
        const { sniffDwf, parseDwfToGrids } = await import('@mantle/files/readers/dwf');
        const sheets = sniffDwf(bytes) ? await parseDwfToGrids(bytes) : [];
        return writeJson(p.outJson, { ok: true, sheets, plan: null });
      }
      const { readSpreadsheetGrid } = await import('@mantle/files/readers/grid');
      return writeJson(p.outJson, {
        ok: true,
        sheets: await readSpreadsheetGrid(bytes, ext),
        plan: null,
      });
    }
    case 'pdfRasterize': {
      const { rasterizePdfToPngs } = await import('@mantle/files/readers/rasterize');
      const pages = await rasterizePdfToPngs(await fs.readFile(p.input), {
        maxPages: int(opts.maxPages, 10, 1, 200),
      });
      return writeJson(p.outJson, {
        ok: true,
        pages: pages.map((pg) => ({
          pageNumber: pg.pageNumber,
          png_base64: pg.png.toString('base64'),
        })),
      });
    }
    case 'pdfInfo': {
      const { pdfPageCount } = await import('@mantle/files/readers/pdf');
      return writeJson(p.outJson, {
        ok: true,
        pages: await pdfPageCount(await fs.readFile(p.input)),
      });
    }
    case 'pdfUnlock': {
      const { extractPdfTextWithPassword } = await import('@mantle/files/readers/pdf-password');
      const password = typeof opts.password === 'string' ? opts.password : '';
      return writeJson(
        p.outJson,
        await extractPdfTextWithPassword(await fs.readFile(p.input), password),
      );
    }
    case 'dwgRender':
      return dwgRender(p.input, opts, p.dir, p.outJson, timeoutMs);
    case 'dwgCrop':
      return dwgCrop(p.input, opts, p.dir, p.outJson, timeoutMs);
    case 'extractAudio': {
      const meta = await extractAudio(p.input, opts, p.dir, p.outBin, timeoutMs);
      return writeJson(p.meta, meta);
    }
    case 'thumbnail': {
      const { thumbnailJpeg } = await import('@mantle/files/readers/image');
      const mime = str(opts.mimeType, 'mimeType');
      const jpeg = await thumbnailJpeg(
        await fs.readFile(p.input),
        /heic|heif/i.test(mime),
        int(opts.maxDim, 512, 16, 4096),
      );
      await fs.writeFile(p.outBin, jpeg);
      return writeJson(p.meta, { mimeType: 'image/jpeg' });
    }
    case 'visionImage': {
      const mime = str(opts.mimeType, 'mimeType');
      if (!/heic|heif/i.test(mime)) {
        throw new JobFailure('unsupported', `only HEIC/HEIF is converted for vision, not ${mime}`);
      }
      const { heicToJpeg } = await import('@mantle/files/readers/image');
      await fs.writeFile(p.outBin, await heicToJpeg(await fs.readFile(p.input)));
      return writeJson(p.meta, { mimeType: 'image/jpeg' });
    }
  }
}

/** Any throw as the wire's failure. */
export function failureOf(err: unknown): JobFailure {
  if (err instanceof JobFailure) return err;
  if (isDocumentTooLarge(err)) return new JobFailure('too_large', err.message);
  // The PDF readers' size verdict (pdf-open.ts: over 256 MB, or every page
  // too large to render).
  if (err instanceof Error && err.name === 'PdfLimitError') {
    return new JobFailure('too_large', err.message);
  }
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null;
  if (e?.code === 'unsupported' || e?.name === 'UnsupportedFormatError') {
    return new JobFailure('unsupported', String(e?.message ?? 'unsupported format'));
  }
  // A JavaScript allocation the engine refused: past what the job may hold.
  if (err instanceof RangeError && /allocation|Invalid (string|array) length/i.test(err.message)) {
    return new JobFailure(
      'too_large',
      `the document needs more memory than a job may use (${err.message})`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new JobFailure('failed', message.slice(0, 2000) || 'the reader failed');
}
