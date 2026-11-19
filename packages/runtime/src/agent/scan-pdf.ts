/**
 * A scanned PDF read page by page with the Scan reader (docs/ai-workers.md,
 * "The Scan reader", "Scanned PDFs outside a book"): the core's read of a PDF
 * with no text layer (server/api extract/images.ts `ocrIngestPdfNode`, and
 * the maintenance `ocr-rescan` that runs it again) and a PDF attached in chat
 * (./attachments.ts). Owner decisions 2026-11-19: every scanned page is the
 * Scan reader's ("quality is of too much importance, let's hit the worker
 * always"), with no local OCR and no vision backup; vision only describes a
 * page the engine finds mostly a figure. Photos, screenshots and drawings
 * keep vision (they never come here).
 *
 * Every page is read: no page cap (the standing rule, everything uploaded is
 * consumed in full). The file goes in page windows (pdfWindows, qpdf: any
 * size), and each window is first marked with no model by the book reader's
 * own Reader `pdf-pages` (pdf_pages.py): a page with a text layer is its text,
 * a white page is blank (no paid call for it), and a scanned page gets its
 * line count by the ink bands of its picture (`Lines`), the free evidence of
 * the Scan reader's check. Each scanned page is then cut as a one-page PDF
 * (qpdf) and read by the Scan reader, one paid call a page (two only when
 * the provider gave no answer at all: runScanReader `tries: 2`).
 *
 * The verdict of a read is the book path's, one function for both
 * (scanVerdictOf, also in server/api pipeline-ask.ts): judged good, the
 * page's text; judged bad, the page is `unread` (never a second paid read);
 * mostly a figure (a picture link and under FIGURE_TEXT_MAX_CHARS
 * characters), one vision call describes it from the page's picture. Where
 * no free rule finds fault but `unverified` (no local OCR vouches for any
 * read), the decider's `scan_read_check` is asked with the page's picture.
 *
 * Honest: each page comes back with how it was read (`text`, `blank`,
 * `scan_reader`, `vision`) or `unread` and why (ScanUnreadReason). A page
 * the parser could not cut, one past the send limit, a provider that failed:
 * each is said, never dropped in silence.
 *
 * Money: the parser's work of a window (its cut, its marks, its pages' cuts)
 * is done before the window's first paid call, so a busy parser fails the
 * caller's job (the extract is retried) with no page of that window paid
 * for. What a window paid for is handed to `onWindow` as it ends, so the
 * caller keeps it (the extract: on the node) and a retry starts after it
 * (`startPage`, `known`). A picture drawn after a paid call (a figure, the
 * check) that the parser cannot draw just now is no throw: the page is
 * unread (figure) or the free rule stands (check).
 */
import {
  BUILTIN_PIPELINES,
  PIPELINE_ASK_PICTURE_MAX_BYTES,
  parserPdfSplit,
  parserRasterizePdf,
  type FileTabsWriteInput,
  type PipelineManifest,
} from '@mantle/files';
import {
  isWindowLost,
  pdfWindows,
  runPackaged,
  windowJob,
  type PdfWindowPart,
} from '@mantle/content/pipeline-runner';
import { SCAN_WHY, VISION_METHOD } from '@mantle/content/book-pages';
import {
  SCAN_UNREAD_REASONS,
  scanUnreadSentence,
  type ScanUnreadReason,
} from '@mantle/files/read-cut';
import { checkScanRead } from '@mantle/decisions';
import { step } from '@mantle/tracing';
import { errorMessage } from '@mantle/std';
import { runScanReader, type ScanReaderResult } from './scan-reader';
import { runVisionWorker } from './attachments';

/** Under this many characters (not spaces) with a figure found, a scanned
 *  page is mostly a figure: vision describes it (the book reader's old rule
 *  for a figure page, TEXT_MIN_CHARS). */
export const FIGURE_TEXT_MAX_CHARS = 40;

/** A window of a scanned PDF: its pages are marked, cut and read before the
 *  next is cut, and kept (onWindow) as it ends. Small, so a retry after a
 *  crash pays for at most one window again. */
export const SCAN_WINDOW = { pages: 20, mb: 32 } as const;

/** Pages of one window read at once (the scan bench, 2026-11-19: 4 calls
 *  in parallel, 3.7 to 5.0 s a page). */
export const SCAN_PAGES_AT_ONCE = 4;

/** How a page was read. */
export type ScanPageMethod = 'text' | 'blank' | 'scan_reader' | 'vision' | 'unread';

/** Why a page is unread: @mantle/files read-cut.ts (the file status says
 *  them in one sentence, scanUnreadSentence). */
export { SCAN_UNREAD_REASONS, scanUnreadSentence, type ScanUnreadReason };

/** One page of a scanned PDF and how it was read. */
export type ScanPage = {
  page: number;
  method: ScanPageMethod;
  /** Its text (empty for a blank or unread page). */
  text: string;
  /** Unread: why. */
  why?: ScanUnreadReason;
};

/** The verdict of one Scan reader read (the book path's and this file's). */
export type ScanVerdict = {
  verdict: 'good' | 'bad' | 'figure';
  /** The decider's answer, when it was asked. */
  check?: { faithful: number; mode: string; used: boolean };
};

/**
 * The verdict of a Scan reader read that ran: `figure` when the engine
 * found a picture and next to no text (vision describes it); else the free
 * check's (`out.quality`), with the decider's `scan_read_check` asked where
 * its answer can matter (no reason, or `unverified` alone): in shadow only
 * logged, live its answer stands for the free rule's. `picture`: the page's picture for
 * the decider, drawn only when it is asked (null: no answer, the rule
 * stands). A check that throws is no answer.
 */
export async function scanVerdictOf(
  ownerId: string,
  out: Pick<ScanReaderResult, 'text' | 'pictures' | 'quality'>,
  picture: () => Promise<{ bytes: Buffer; mimeType: string } | null>,
  check: typeof checkScanRead = checkScanRead,
): Promise<ScanVerdict> {
  if (out.pictures > 0 && out.text.replace(/\s/g, '').length < FIGURE_TEXT_MAX_CHARS) {
    return { verdict: 'figure' };
  }
  let good = out.quality.ok;
  let asked: ScanVerdict['check'];
  // A read the free rules judge good, or bad only as `unverified`: no
  // local OCR vouches for it, so the decider is asked (a read bad for any
  // other reason stays bad, whatever it says).
  if (out.quality.reasons.every((r) => r === 'unverified')) {
    const pic = await picture().catch(() => null);
    const c = pic
      ? await check(ownerId, { picture: pic.bytes, mimeType: pic.mimeType, text: out.text }).catch(
          () => null,
        )
      : null;
    if (c) {
      asked = { faithful: Math.round(c.faithful * 1000) / 1000, mode: c.mode, used: c.used };
      if (c.used) good = c.passes;
    }
  }
  return { verdict: good ? 'good' : 'bad', ...(asked ? { check: asked } : {}) };
}

/** The Reader `pdf-pages` (the book reader), run with no model on a window
 *  for its page marks. */
const PDF_PAGES = (BUILTIN_PIPELINES as readonly PipelineManifest[]).find(
  (p) => p.id === 'pdf-pages',
)!;

/** One page as the Reader marked it. */
export type PageMark = {
  page: number;
  method: string;
  why: string | null;
  lines: number | null;
  text: string;
};

/** The page marks of a Reader's write (its tab Pages), by page. Pure. */
export function pageMarksOf(write: FileTabsWriteInput | undefined): Map<number, PageMark> {
  const out = new Map<number, PageMark>();
  const tab = write?.tabs.find((t) => t.name === 'Pages');
  if (!tab) return out;
  const col = (name: string) => tab.columns.findIndex((c) => c.name === name);
  const iPage = col('Page');
  const iMethod = col('Method');
  if (iPage < 0 || iMethod < 0) return out;
  const cell = (row: readonly unknown[], name: string): unknown => {
    const i = col(name);
    return i < 0 ? null : row[i];
  };
  for (const row of tab.rows) {
    const page = Number(row[iPage]);
    if (!Number.isInteger(page) || page < 1) continue;
    const why = cell(row, 'Why');
    const lines = cell(row, 'Lines');
    const text = cell(row, 'Text');
    out.set(page, {
      page,
      method: String(row[iMethod] ?? ''),
      why: typeof why === 'string' ? why : null,
      lines: typeof lines === 'number' && Number.isInteger(lines) && lines >= 0 ? lines : null,
      text: typeof text === 'string' ? text : '',
    });
  }
  return out;
}

/** What the read needs from outside: the parser and the workers, stand-ins
 *  in a test. */
export type ScanPdfDeps = {
  marks(
    part: PdfWindowPart,
    file: { sha256: string; size: number },
  ): Promise<Map<number, PageMark>>;
  cut(part: PdfWindowPart, page: number): Promise<Buffer>;
  draw(pdf: Buffer): Promise<{ bytes: Buffer; mimeType: string } | null>;
  scan: typeof runScanReader;
  vision: typeof runVisionWorker;
  check: typeof checkScanRead;
  windows: typeof pdfWindows;
};

const defaultDeps: ScanPdfDeps = {
  marks: async (part, file) => {
    const run = await runPackaged(
      PDF_PAGES,
      part.bytes,
      { name: 'file.pdf', ext: 'pdf', size: file.size, sha256: file.sha256 },
      {
        options: { tables: false },
        kind: 'book',
        window: { pageFrom: part.pageFrom, pageTo: part.pageTo, pagesTotal: part.pagesTotal },
      },
    );
    const write = run.status === 'ok' ? run.write : undefined;
    return pageMarksOf(write);
  },
  cut: async (part, page) => {
    const one = await parserPdfSplit(part.bytes, {
      from: page - part.pageFrom + 1,
      pages: 1,
      mb: 64,
    });
    return one.bytes;
  },
  draw: async (pdf) => {
    const [p] = await parserRasterizePdf(pdf, { maxPages: 1 });
    return p ? { bytes: p.png, mimeType: p.mime } : null;
  },
  // Called through, not taken at load: ./attachments.ts imports this module.
  scan: (o) => runScanReader(o),
  vision: (o) => runVisionWorker(o),
  check: (o, p, s) => checkScanRead(o, p, s),
  windows: (...a) => pdfWindows(...a),
};

/** At most `n` of `jobs` at once, the answers in order. */
async function inTurn<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < jobs.length; i = next++) out[i] = await jobs[i]!();
  };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
  return out;
}

export type ScanPdfResult = {
  /** Every page from `startPage` on, in order. */
  pages: ScanPage[];
  /** The pages of the file. */
  pagesTotal: number;
  /** A Scan reader or vision call answered (a page read, or read badly). */
  ran: boolean;
  /** The model of the last page read by a model, for the record. */
  model: string | null;
};

/**
 * Read a scanned PDF page by page (see the module note). Throws a parser
 * error the caller handles (busy, a file qpdf cannot open, password) only
 * before a window's first paid call. `deadline` (ms since the epoch): a page
 * not started by then is `unread`, `time` (a chat turn's budget).
 */
export async function readScannedPdf(opts: {
  ownerId: string;
  bytes: Buffer;
  sha256: string;
  filename: string;
  /** The first page to read (a read that kept pages before goes on). */
  startPage?: number;
  /** The page count, when a read before learnt it. */
  pagesTotal?: number;
  deadline?: number;
  /** Each window's pages, as it ends. */
  onWindow?: (pages: ScanPage[], pagesTotal: number) => Promise<void>;
  deps?: Partial<ScanPdfDeps>;
}): Promise<ScanPdfResult> {
  const d: ScanPdfDeps = { ...defaultDeps, ...opts.deps };
  const all: ScanPage[] = [];
  let total = opts.pagesTotal ?? 0;
  let ran = false;
  let model: string | null = null;
  const late = () => opts.deadline !== undefined && Date.now() >= opts.deadline;
  const unread = (from: number, to: number, why: ScanUnreadReason): ScanPage[] =>
    Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => ({
      page: from + i,
      method: 'unread' as const,
      text: '',
      why,
    }));

  for await (const w of d.windows(
    opts.bytes,
    opts.sha256,
    SCAN_WINDOW,
    opts.startPage ?? 1,
    opts.pagesTotal,
  )) {
    if (late()) {
      // The pages from here on are not read in this turn: said, never cut
      // in silence.
      const from = w.part ? w.part.pageFrom : w.from;
      total = w.part ? w.part.pagesTotal : w.pagesTotal;
      all.push(...unread(from, total, 'time'));
      break;
    }
    if (!w.part) {
      total = w.pagesTotal;
      const lost = unread(w.from, w.to, 'not_cut');
      all.push(...lost);
      await opts.onWindow?.(lost, total);
      continue;
    }
    const part = w.part;
    total = part.pagesTotal;
    // The parser's work of the window first, before any paid call: its
    // marks (the Reader failing is no throw: every page is read with no
    // line count), then each scanned page's cut.
    const marks = await windowJob(() =>
      step({ name: 'scan_marks', kind: 'compute', input: { from: part.pageFrom } }, async (h) => {
        const m = await d.marks(part, { sha256: opts.sha256, size: opts.bytes.length });
        h.setMeta({ pages: m.size, to: part.pageTo });
        return m;
      }),
    );
    const marked = isWindowLost(marks) ? new Map<number, PageMark>() : marks;
    const cuts = new Map<number, Buffer | ScanUnreadReason>();
    const window: ScanPage[] = [];
    for (let n = part.pageFrom; n <= part.pageTo; n += 1) {
      const m = marked.get(n);
      if (m?.method === 'text') {
        window.push({ page: n, method: 'text', text: m.text.trim() });
        continue;
      }
      if (m?.method === 'blank') {
        window.push({ page: n, method: 'blank', text: '' });
        continue;
      }
      // A scanned page, a page the Reader could not draw (`failed`), or no
      // mark at all: the Scan reader reads it (it needs no drawing).
      const pdf = await windowJob(() => d.cut(part, n));
      cuts.set(
        n,
        isWindowLost(pdf)
          ? 'not_cut'
          : pdf.length > PIPELINE_ASK_PICTURE_MAX_BYTES
            ? 'too_large'
            : pdf,
      );
      window.push({ page: n, method: 'unread', text: '' });
    }

    const jobs = window.map((pg) => async (): Promise<ScanPage> => {
      const pdf = cuts.get(pg.page);
      if (pdf === undefined) return pg;
      if (typeof pdf === 'string') return { ...pg, why: pdf };
      if (late()) return { ...pg, why: 'time' };
      // The line count of a page the Reader marked for the Scan reader; none
      // for a page it could not draw or did not mark (the check is then
      // made without it).
      const m = marked.get(pg.page);
      const lines = m?.method === VISION_METHOD && m.why === SCAN_WHY ? m.lines : null;
      return readPage(opts.ownerId, opts.filename, pg.page, pdf, lines, d, (r, mdl) => {
        if (r) ran = true;
        if (mdl) model = mdl;
      });
    });
    const read = await inTurn(jobs, SCAN_PAGES_AT_ONCE);
    all.push(...read);
    await opts.onWindow?.(read, total);
  }
  return { pages: all, pagesTotal: total, ran, model };
}

/** One scanned page, as a one-page PDF: the Scan reader, its verdict, and
 *  vision for a figure. Never throws for a provider or a picture. */
async function readPage(
  ownerId: string,
  filename: string,
  page: number,
  pdf: Buffer,
  lines: number | null,
  d: ScanPdfDeps,
  saw: (ran: boolean, model: string | null) => void,
): Promise<ScanPage> {
  const unreadAs = (why: ScanUnreadReason): ScanPage => ({ page, method: 'unread', text: '', why });
  // The page's picture, drawn once when the check or a figure needs it.
  let drawn: Promise<{ bytes: Buffer; mimeType: string } | null> | undefined;
  const picture = () => (drawn ??= d.draw(pdf).catch(() => null));

  const read = await step(
    {
      name: 'extract_scan_reader',
      kind: 'llm_call',
      input: { page, mime: 'application/pdf', bytes: pdf.length },
    },
    async (h) => {
      const out = await d.scan({
        ownerId,
        pdf,
        ...(lines !== null ? { expectedLines: lines } : {}),
        tries: 2,
      });
      if (!out.attempted) {
        h.setSkipped('no_scan_reader');
        h.setMeta({ page, note: out.note });
        return { out, verdict: null };
      }
      saw(out.ran, out.model);
      if (!out.ran) {
        h.setError(out.note ?? 'no answer');
        h.setMeta({ page, model: out.model, engine: out.engine });
        return { out, verdict: null };
      }
      const v = await scanVerdictOf(ownerId, out, picture, d.check);
      h.setMeta({
        page,
        model: out.model,
        engine: out.engine,
        textLength: out.text.length,
        pictures: out.pictures,
        quality: out.quality.reasons,
        judged: v.verdict,
        ...(v.check ? { check: v.check } : {}),
      });
      return { out, verdict: v.verdict };
    },
  );
  if (!read.out.attempted) return unreadAs('no_scan_reader');
  if (!read.verdict) return unreadAs('failed');
  if (read.verdict === 'bad') return unreadAs('bad_read');
  if (read.verdict === 'good') return { page, method: 'scan_reader', text: read.out.text };

  // Mostly a figure: one vision call describes it from the page's picture.
  const pic = await picture();
  if (!pic) return unreadAs('failed');
  const seen = await step(
    {
      name: 'extract_vision',
      kind: 'llm_call',
      input: { page, mime: pic.mimeType, bytes: pic.bytes.length, figure: true },
    },
    async (h) => {
      const r = await d
        .vision({
          ownerId,
          bytes: pic.bytes,
          mimeType: pic.mimeType,
          filename: `${filename}#page-${page}.${pic.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`,
        })
        .catch((err: unknown) => ({
          ran: false,
          text: '',
          note: errorMessage(err),
          model: null,
        }));
      h.setMeta({ ran: r.ran, note: r.note, model: r.model, page, textLength: r.text.length });
      return r;
    },
  );
  saw(seen.ran, seen.model);
  return seen.text.trim() ? { page, method: 'vision', text: seen.text.trim() } : unreadAs('failed');
}

/** The text of the pages read, each under a `[Page N]` line when the file
 *  has more than one page. Pure. */
export function scanTextOf(pages: readonly ScanPage[], pagesTotal: number): string {
  return pages
    .filter((p) => p.text.trim() !== '')
    .map((p) => (pagesTotal > 1 ? `[Page ${p.page}]\n${p.text.trim()}` : p.text.trim()))
    .join('\n\n')
    .trim();
}

/** The pages read (a page with nothing to read, blank, counts as read) and
 *  the unread by why. Pure. */
export function scanCountsOf(pages: readonly ScanPage[]): {
  read: number;
  unread: Partial<Record<ScanUnreadReason, number>>;
} {
  const unread: Partial<Record<ScanUnreadReason, number>> = {};
  let read = 0;
  for (const p of pages) {
    if (p.method === 'unread') {
      const why = p.why ?? 'failed';
      unread[why] = (unread[why] ?? 0) + 1;
    } else read += 1;
  }
  return { read, unread };
}
