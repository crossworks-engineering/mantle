/**
 * Page windows of a PDF, cut with qpdf (docs/pipelines.md, "Page windows";
 * docs/parser.md, "Page windows: qpdf and the local OCR"). qpdf (Apache-2.0) reads the page tree with
 * no page decode and no pdfjs, so it takes a file of any size the parser
 * takes: a 600-page scan of 343 MB, past the 256 MB pdfjs opens.
 *
 * The job `pdfSplit` cuts ONE window: the pages `from` to at most
 * `from + pages - 1` as a PDF of their own, of at most `mb` MB. A window
 * past `mb` is cut again with fewer pages (in proportion to its size, at
 * most four times); a single page past `mb` is a window of its own all the
 * same, so no page is ever left out. The answer is the window's bytes
 * (`out.bin`) and `{ pageFrom, pageTo, pagesTotal }` (`meta.json`).
 *
 * A one-page cut for the Scan reader (`fitMb` on `pdfSplit`, and every
 * `qpdfPage`) past what one call may send is drawn again smaller
 * (`fitPage`, cad/pdf_fit.py): a large scanned drawing is read from a
 * picture of fewer dots, not left unread. The answer says the dots an inch
 * it was drawn at (`drawnDpi`) and the size of the cut before (`fromBytes`).
 *
 * One window a job, not every window in one: the parser's scratch space is
 * a tmpfs counted in its memory (1 GB by default), and it holds the body
 * and one window, never the body and all its parts; one window is also one
 * answer under the 96 MB answer cap. The brain sends the file for each
 * window and keeps no part longer than its step.
 *
 * qpdf's exit 3 is "done, with warnings" (a damaged xref it repaired): the
 * window is taken. Any other exit is the file's verdict, `failed`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PIPELINE_ASK_PICTURE_MAX_BYTES } from '@mantle/files/pipelines/contract';
import { CAD_DIR, pythonOf } from './cad';
import { JobFailure } from './job-failure';
import { childEnv, runChild } from './proc';

/** The qpdf binary (Debian's `qpdf` package, in the parser image). */
const QPDF = 'qpdf';
/** The most cuts of one window before the smallest is taken as it is. */
const CUTS_MAX = 4;

function wholeIn(v: unknown, lo: number, hi: number, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
    throw new JobFailure('bad_request', `'${name}' must be a whole number from ${lo} to ${hi}`);
  }
  return v;
}

/** qpdf ended well: 0, or 3 (done, with warnings). */
const fine = (code: number | null) => code === 0 || code === 3;

/** The page count of the PDF at `input`, by qpdf, or null when qpdf cannot
 *  read it. `timeoutMs`: the time left to the job's end. */
export async function qpdfPageCount(
  input: string,
  dir: string,
  timeoutMs: number,
): Promise<number | null> {
  const ended = await runChild(QPDF, ['--show-npages', input], {
    timeoutMs: Math.max(1_000, timeoutMs),
    cwd: dir,
    env: childEnv(dir),
    stdout: true,
  });
  if (!fine(ended.code)) return null;
  const n = Number(ended.stdout.trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Cut the pages `from` to `to` of `input` into `out`. */
async function cut(
  input: string,
  from: number,
  to: number,
  out: string,
  dir: string,
  timeoutMs: number,
): Promise<void> {
  // `--empty --pages`: a new file of those pages only (no outline, no form
  // of the whole), the smallest window. `--` closes the page list.
  const ended = await runChild(
    QPDF,
    ['--empty', '--no-warn', '--deterministic-id', '--pages', input, `${from}-${to}`, '--', out],
    { timeoutMs: Math.max(1_000, timeoutMs), cwd: dir, env: childEnv(dir) },
  );
  if (!fine(ended.code)) {
    const why = ended.timedOut
      ? 'qpdf ran past the job time'
      : ended.spawnError
        ? `qpdf could not start (${ended.spawnError})`
        : `qpdf could not cut pages ${from} to ${to}: ${ended.stderr.trim().slice(-300)}`;
    throw new JobFailure(ended.timedOut ? 'timeout' : 'failed', why);
  }
}

/**
 * The one-page PDF at `file`, past `maxBytes`, drawn again in place as a
 * smaller one (cad/pdf_fit.py: grey, at the highest dpi under
 * PDF_MAX_IMAGE_PIXELS and `maxBytes`). The dpi it was drawn at, or null
 * when it does not fit even at the script's lowest dpi or could not be
 * drawn (the file is then as cut, and the caller says the page is too
 * large). Never throws.
 */
export async function fitPage(
  file: string,
  maxBytes: number,
  dir: string,
  timeoutMs: number,
): Promise<number | null> {
  const fitted = `${file}.fit.pdf`;
  try {
    const ended = await runChild(
      pythonOf(),
      [path.join(CAD_DIR, 'pdf_fit.py'), file, fitted, String(maxBytes)],
      {
        timeoutMs: Math.max(1_000, timeoutMs),
        cwd: dir,
        env: childEnv(dir, { PYTHONDONTWRITEBYTECODE: '1' }),
        stdout: true,
      },
    );
    if (ended.code !== 0) return null;
    const dpi = (JSON.parse(ended.stdout.trim()) as { dpi?: unknown }).dpi;
    if (typeof dpi !== 'number' || !(dpi > 0)) return null;
    if ((await fs.stat(fitted)).size > maxBytes) return null;
    await fs.rename(fitted, file);
    return dpi;
  } catch {
    return null;
  } finally {
    await fs.rm(fitted, { force: true }).catch(() => {});
  }
}

/**
 * The job `pdfSplit`: one window of the body, as the module says. Options:
 * `from` (1-based), `pages` (the most pages) and `mb` (the most MB), and
 * `fitMb`: a one-page window past it is drawn again under it (`fitPage`).
 * A `from` past the last page is a `bad_request`: the brain asks only for
 * pages it was told are there.
 */
export async function runPdfSplitJob(
  opts: Record<string, unknown>,
  p: { input: string; dir: string; outBin: string; meta: string },
  jobEnd: number,
): Promise<void> {
  const from = wholeIn(opts.from, 1, 1_000_000, 'from');
  const pages = wholeIn(opts.pages, 1, 500, 'pages');
  const mb = wholeIn(opts.mb, 1, 64, 'mb');
  const fitMb = opts.fitMb === undefined ? null : wholeIn(opts.fitMb, 1, 64, 'fitMb');
  const left = () => jobEnd - Date.now();
  const total = await qpdfPageCount(p.input, p.dir, left());
  if (total === null) throw new JobFailure('failed', 'qpdf could not read the PDF');
  if (from > total) {
    throw new JobFailure(
      'bad_request',
      `the PDF has ${total} pages, so no window starts at ${from}`,
    );
  }
  const maxBytes = mb * 1024 * 1024;
  let count = Math.min(pages, total - from + 1);
  for (let i = 1; ; i += 1) {
    const to = from + count - 1;
    await cut(p.input, from, to, p.outBin, p.dir, left());
    const { size } = await fs.stat(p.outBin);
    if (size <= maxBytes || count === 1 || i >= CUTS_MAX) {
      const fitBytes = fitMb === null ? null : fitMb * 1024 * 1024;
      const drawnDpi =
        count === 1 && fitBytes !== null && size > fitBytes
          ? await fitPage(p.outBin, fitBytes, p.dir, left())
          : null;
      const bytes = drawnDpi === null ? size : (await fs.stat(p.outBin)).size;
      await fs.writeFile(
        p.meta,
        JSON.stringify({
          pageFrom: from,
          pageTo: to,
          pagesTotal: total,
          bytes,
          ...(drawnDpi === null ? {} : { drawnDpi, fromBytes: size }),
        }),
      );
      return;
    }
    // Fewer pages, in proportion to the size, with a tenth to spare.
    count = Math.max(1, Math.min(count - 1, Math.floor((count * maxBytes * 0.9) / size)));
    await fs.rm(p.outBin, { force: true });
  }
}

/**
 * One page of the PDF at `input` (1-based) as a PDF of its own at `out`
 * (the Scan reader reads a scanned page as a one-page PDF: docs/ai-workers.md,
 * "The Scan reader"), drawn again under what one call may send
 * (PIPELINE_ASK_PICTURE_MAX_BYTES) when the cut is past it (`fitPage`). Its
 * size in bytes, or null when qpdf could not cut it (the page is then left
 * unread, said so). Never throws.
 */
export async function qpdfPage(
  input: string,
  page: number,
  out: string,
  dir: string,
  timeoutMs: number,
): Promise<number | null> {
  if (!Number.isInteger(page) || page < 1) return null;
  try {
    const end = Date.now() + timeoutMs;
    await cut(input, page, page, out, dir, timeoutMs);
    const { size } = await fs.stat(out);
    if (size <= PIPELINE_ASK_PICTURE_MAX_BYTES) return size;
    await fitPage(out, PIPELINE_ASK_PICTURE_MAX_BYTES, dir, end - Date.now());
    return (await fs.stat(out)).size;
  } catch {
    await fs.rm(out, { force: true }).catch(() => {});
    return null;
  }
}

/** The boot smoke's check: qpdf is in the image and answers its version. */
export async function qpdfThere(dir: string): Promise<string> {
  const ended = await runChild(QPDF, ['--version'], {
    timeoutMs: 10_000,
    cwd: dir,
    env: childEnv(dir),
    stdout: true,
  });
  if (ended.code !== 0) throw new Error(`qpdf is not there (${ended.spawnError ?? ended.code})`);
  return ended.stdout.split('\n')[0]?.trim() ?? '';
}
