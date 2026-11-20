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
 *
 * The provider's "not now" (a rate limit, no credit, busy: @mantle/std
 * provider-wait.ts): a short one is waited through on the page
 * (callThroughWaits), so the read goes on with nothing paid twice. Still
 * "not now": the read stops there, its page and every page after it are
 * `unread`, `failed` (not final), and the result carries the `wait`. The
 * pages read before it are already kept (`share`, `onWindow`), and every
 * paid answer is kept by the gateway as it comes (@mantle/db
 * answer-cache.ts, in the extract queue's jobs), so the caller's try again
 * (the extract queue's wait) pays for no page twice.
 *
 * A page whose keep did not reach the node (the node gone, of other bytes,
 * or holding a whole read) makes the read moot: it stops there (`moot`),
 * with no wait. A book's pending figure (scan-share.ts FIGURE_PENDING) is
 * read by its vision call only, whoever reads it.
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
  pdfWindowsAt,
  runPackaged,
  windowJob,
  type PdfWindowPart,
  type PdfWindowStep,
} from '@mantle/content/pipeline-runner';
import { SCAN_WHY, VISION_METHOD } from '@mantle/content/book-pages';
import {
  SCAN_UNREAD_REASONS,
  scanUnreadSentence,
  type ScanUnreadReason,
} from '@mantle/files/read-cut';
import { checkScanRead } from '@mantle/decisions';
import { step } from '@mantle/tracing';
import {
  callThroughWaits,
  errorMessage,
  PROVIDER_WAIT_IN_JOB_MS,
  type ProviderWait,
} from '@mantle/std';
import { runScanReader, type ScanReaderResult } from './scan-reader';
import { runVisionWorker, type VisionResult } from './attachments';
import type { ScanShareHooks } from './scan-share';

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
  /** The page windows: every page (`needed` null), or those that hold the
   *  pages `needed`. */
  windows(
    bytes: Buffer,
    sha256: string,
    window: { pages: number; mb: number },
    needed: readonly number[] | null,
  ): AsyncGenerator<PdfWindowStep>;
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
  windows: (bytes, sha256, window, needed) =>
    needed === null
      ? pdfWindows(bytes, sha256, window)
      : pdfWindowsAt(bytes, sha256, window, needed),
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

/** Why a page is unread that a later read may cure with no page paid for
 *  twice: no Scan reader yet, no answer, a page not cut, no time. A read
 *  that kept its pages (`done`) reads these again; every other page is
 *  final (read, blank, read badly, too large, a figure not described). */
export const SCAN_RETRY_REASONS: ReadonlySet<ScanUnreadReason> = new Set([
  'no_scan_reader',
  'failed',
  'not_cut',
  'time',
]);

/** Whether a page is final: read, or unread for good (a later read of the
 *  same bytes would pay for it again to no end). */
export function scanPageFinal(p: Pick<ScanPage, 'method' | 'why'>): boolean {
  return p.method !== 'unread' || !SCAN_RETRY_REASONS.has(p.why ?? 'failed');
}

export type ScanPdfResult = {
  /** Every page but those `done`, in order. */
  pages: ScanPage[];
  /** The pages of the file. */
  pagesTotal: number;
  /** A Scan reader or vision call answered (a page read, or read badly). */
  ran: boolean;
  /** The model of the last page read by a model, for the record. */
  model: string | null;
  /** The file's bytes were read whole by another reader meanwhile (its
   *  final read is on the node): this read stopped, and takes that one. */
  readBefore?: true;
  /** The provider said "not now" and the read stopped there: the pages
   *  from it on are unread (`failed`, not final). */
  wait?: ProviderWait;
  /** A page's keep did not reach the node (the node gone, of other bytes,
   *  or holding a whole read): the read stopped there, with no wait. */
  moot?: true;
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
  /** The pages a read before kept as final (scanPageFinal): not read
   *  again, nor returned. Needs `pagesTotal`. */
  done?: ReadonlySet<number>;
  /** The page count, when a read before learnt it. */
  pagesTotal?: number;
  deadline?: number;
  /** Each window's pages, as it ends. */
  onWindow?: (pages: ScanPage[], pagesTotal: number) => Promise<void>;
  /** The reads shared with the other readers of the same upload
   *  (./scan-share.ts); none: this read is alone. */
  share?: ScanShareHooks;
  /** The pauses a page waits through a short "not now" (callThroughWaits).
   *  Default: the queue's in-job pauses, none with a `deadline` (a person
   *  waits for the turn). */
  waitPauses?: readonly number[];
  deps?: Partial<ScanPdfDeps>;
}): Promise<ScanPdfResult> {
  const d: ScanPdfDeps = { ...defaultDeps, ...opts.deps };
  const all: ScanPage[] = [];
  let total = opts.pagesTotal ?? 0;
  let ran = false;
  let model: string | null = null;
  let wait: ProviderWait | undefined;
  let moot = false;
  const pauses = opts.waitPauses ?? (opts.deadline !== undefined ? [] : PROVIDER_WAIT_IN_JOB_MS);
  const waits: ScanWaits = {
    pauses,
    held: () => wait !== undefined || moot,
    onWait: (w) => {
      wait ??= w;
    },
    onMoot: () => {
      moot = true;
    },
  };
  // A moot read has no wait: nothing is tried again for it.
  const stopOut = () => (moot ? { moot: true as const } : wait ? { wait } : {});
  const late = () => opts.deadline !== undefined && Date.now() >= opts.deadline;
  const unread = (from: number, to: number, why: ScanUnreadReason): ScanPage[] =>
    Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => ({
      page: from + i,
      method: 'unread' as const,
      text: '',
      why,
    }));

  const done = opts.pagesTotal !== undefined ? (opts.done ?? null) : null;
  const needed =
    done === null
      ? null
      : Array.from({ length: opts.pagesTotal! }, (_, i) => i + 1).filter((n) => !done.has(n));
  if (needed !== null && needed.length === 0) {
    return { pages: [], pagesTotal: opts.pagesTotal!, ran, model };
  }
  const todo = (n: number) => done === null || !done.has(n);

  for await (const w of d.windows(opts.bytes, opts.sha256, SCAN_WINDOW, needed)) {
    if (late()) {
      // The pages from here on are not read in this turn: said, never cut
      // in silence.
      const from = w.part ? w.part.pageFrom : w.from;
      total = w.part ? w.part.pagesTotal : w.pagesTotal;
      all.push(...unread(from, total, 'time').filter((p) => todo(p.page)));
      break;
    }
    if (!w.part) {
      total = w.pagesTotal;
      const lost = unread(w.from, w.to, 'not_cut').filter((p) => todo(p.page));
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
    const free: ScanPage[] = [];
    const scanned: number[] = [];
    for (let n = part.pageFrom; n <= part.pageTo; n += 1) {
      if (!todo(n)) continue;
      const m = marked.get(n);
      if (m?.method === 'text') free.push({ page: n, method: 'text', text: m.text.trim() });
      else if (m?.method === 'blank') free.push({ page: n, method: 'blank', text: '' });
      // A scanned page, a page the Reader could not draw (`failed`), or no
      // mark at all: the Scan reader reads it (it needs no drawing).
      else scanned.push(n);
    }

    // The shared reads (./scan-share.ts): the pages another reader of the
    // same upload kept are taken, those it holds are waited for, the rest
    // are this read's to pay for. Each paid page is claimed before its call.
    const got = new Map<number, ScanPage>();
    let todoScan = scanned;
    for (let round = 0; todoScan.length > 0; round += 1) {
      const claim = opts.share
        ? await opts.share.claim(todoScan)
        : { kept: new Map<number, ScanPage>(), mine: todoScan, theirs: new Map<number, number>() };
      if (claim.final) {
        return { pages: all, pagesTotal: total, ran, model, readBefore: true };
      }
      for (const [n, p] of claim.kept) got.set(n, p);
      // Each page is kept (and its claim ended) as its read ends, so a
      // reader waiting for it has it then, not at the window's end.
      const share = opts.share;
      const keep = share ? (p: ScanPage) => share.keep([p], total) : undefined;
      // Each page is claimed again just before its paid call: a window's
      // claim may end while its first pages wait out a "not now", and a
      // page another reader took meanwhile is theirs (waited for below),
      // never paid twice.
      const renew = share
        ? async (n: number): Promise<ScanPage | number | 'figure' | null> => {
            const c = await share.claim([n]);
            if (c.mine.includes(n)) return c.figures?.has(n) ? 'figure' : null;
            return c.kept.get(n) ?? c.theirs.get(n) ?? null;
          }
        : undefined;
      const read = await readMine(
        claim.mine,
        part,
        marked,
        d,
        opts,
        late,
        keep,
        (r, mdl) => {
          if (r) ran = true;
          if (mdl) model = mdl;
        },
        waits,
        renew,
      );
      for (const p of read.pages) got.set(p.page, p);
      for (const [n, until] of read.theirs) claim.theirs.set(n, until);
      if (claim.theirs.size === 0 || !opts.share) break;
      // The provider said "not now" (or the read is moot): the held pages
      // are not waited for; they stay the other reader's.
      if (wait || moot) {
        for (const n of claim.theirs.keys()) {
          got.set(n, { page: n, method: 'unread', text: '', why: 'failed' });
        }
        break;
      }
      // Held by another reader: wait for its pages, to the end of its claim
      // (or this read's time). A page whose claim ended unkept (its reader
      // died, or left it to be read again) is claimed again, at most twice.
      const until = Math.min(opts.deadline ?? Infinity, Math.max(...claim.theirs.values()));
      const waited = await opts.share.wait([...claim.theirs.keys()], until);
      for (const [n, p] of waited) got.set(n, p);
      todoScan = [...claim.theirs.keys()].filter((n) => !got.has(n));
      if (late() || round >= 2) {
        // Not kept in time: a chat turn says so (`time`); the extract leaves
        // them to its read again (`failed`, not final).
        const why: ScanUnreadReason = late() ? 'time' : 'failed';
        for (const n of todoScan) got.set(n, { page: n, method: 'unread', text: '', why });
        break;
      }
    }
    if (opts.share && free.length > 0 && !moot && !(await opts.share.keep(free, total))) {
      moot = true;
    }
    const window = [...free, ...got.values()].sort((x, y) => x.page - y.page);
    all.push(...window);
    await opts.onWindow?.(window, total);
    // Moot: the node no longer takes this read. Stopped, with no wait.
    if (moot) break;
    if (wait) {
      // The provider said "not now": no page after it is sent. Said, never
      // cut in silence; a try again reads them.
      all.push(...unread(part.pageTo + 1, total, 'failed').filter((p) => todo(p.page)));
      break;
    }
  }
  return { pages: all, pagesTotal: total, ran, model, ...stopOut() };
}

/** The stops across one read: the pauses a page waits through, whether
 *  the read already holds (a wait or a moot read: no page is sent after
 *  it), and where a page's wait, or a keep that did not reach the node, is
 *  told. */
type ScanWaits = {
  pauses: readonly number[];
  held: () => boolean;
  onWait: (wait: ProviderWait) => void;
  onMoot: () => void;
};

/** The pages a read claimed: each cut (parser work, before any paid call:
 *  a busy parser throws here with nothing of them paid), then read, 4 at
 *  once. `renew` claims a page again just before its call: null, still this
 *  read's; `figure`, this read's and a book's pending figure (only its
 *  vision call is left); a page, kept by another reader meanwhile (taken,
 *  no call); a time, held by another reader until then (no call: in
 *  `theirs`). */
async function readMine(
  mine: readonly number[],
  part: PdfWindowPart,
  marked: ReadonlyMap<number, PageMark>,
  d: ScanPdfDeps,
  opts: { ownerId: string; filename: string; sha256: string },
  late: () => boolean,
  keep: ((p: ScanPage) => Promise<boolean>) | undefined,
  saw: (ran: boolean, model: string | null) => void,
  waits: ScanWaits,
  renew?: (n: number) => Promise<ScanPage | number | 'figure' | null>,
): Promise<{ pages: ScanPage[]; theirs: Map<number, number> }> {
  const theirs = new Map<number, number>();
  const cuts = new Map<number, Buffer | ScanUnreadReason>();
  for (const n of mine) {
    const pdf = await windowJob(() => d.cut(part, n));
    cuts.set(
      n,
      isWindowLost(pdf)
        ? 'not_cut'
        : pdf.length > PIPELINE_ASK_PICTURE_MAX_BYTES
          ? 'too_large'
          : pdf,
    );
  }
  const one = async (n: number): Promise<ScanPage | null> => {
    const pg: ScanPage = { page: n, method: 'unread', text: '' };
    const pdf = cuts.get(n)!;
    if (typeof pdf === 'string') return { ...pg, why: pdf };
    if (late()) return { ...pg, why: 'time' };
    // The provider said "not now" to a page before, or the read is moot:
    // not sent (a try again reads it).
    if (waits.held()) return { ...pg, why: 'failed' };
    const held = renew ? await renew(n) : null;
    if (typeof held === 'number') {
      theirs.set(n, held);
      return null;
    }
    const m = marked.get(n);
    const lines = m?.method === VISION_METHOD && m.why === SCAN_WHY ? m.lines : null;
    const at = { ownerId: opts.ownerId, filename: opts.filename, sha256: opts.sha256, page: n };
    if (held === 'figure') return readPage(at, pdf, lines, d, saw, waits, true);
    if (held) {
      taken.add(n);
      return held;
    }
    // The line count (`lines`) of a page the Reader marked for the Scan
    // reader; none for a page it could not draw or did not mark (the check
    // is then made without it).
    return readPage(at, pdf, lines, d, saw, waits, false);
  };
  // The pages another reader kept meanwhile: taken, not kept again.
  const taken = new Set<number>();
  const jobs = mine.map((n) => async (): Promise<ScanPage | null> => {
    const p = await one(n);
    // A keep that did not reach the node: the read is moot, stopped.
    if (p && !taken.has(n) && keep && !(await keep(p))) waits.onMoot();
    return p;
  });
  const pages = (await inTurn(jobs, SCAN_PAGES_AT_ONCE)).filter((p): p is ScanPage => p !== null);
  return { pages, theirs };
}

/** One scanned page, as a one-page PDF: the Scan reader, its verdict, and
 *  vision for a figure (`figureOnly`: a book's pending figure, whose Scan
 *  reader read is made; only the vision call). Never throws for a provider
 *  or a picture. Each paid call names the page (its file's sha256 and
 *  number) for its kept answer: a page cut again may be other bytes. */
async function readPage(
  at: { ownerId: string; filename: string; sha256: string; page: number },
  pdf: Buffer,
  lines: number | null,
  d: ScanPdfDeps,
  saw: (ran: boolean, model: string | null) => void,
  waits: ScanWaits,
  figureOnly: boolean,
): Promise<ScanPage> {
  const { ownerId, page } = at;
  const input = `${at.sha256}#page-${page}`;
  const unreadAs = (why: ScanUnreadReason): ScanPage => ({ page, method: 'unread', text: '', why });
  // The page's picture, drawn once when the check or a figure needs it.
  let drawn: Promise<{ bytes: Buffer; mimeType: string } | null> | undefined;
  const picture = () => (drawn ??= d.draw(pdf).catch(() => null));
  if (!figureOnly) {
    const read = await scanPage(ownerId, page, pdf, lines, input, d, saw, waits, picture);
    if (!read.out.attempted) return unreadAs('no_scan_reader');
    if (!read.out.ran && read.out.wait) {
      waits.onWait(read.out.wait);
      return unreadAs('failed');
    }
    if (!read.verdict) return unreadAs('failed');
    if (read.verdict === 'bad') return unreadAs('bad_read');
    if (read.verdict === 'good') return { page, method: 'scan_reader', text: read.out.text };
  }
  return describeFigure(at, input, d, saw, waits, picture);
}

/** The Scan reader's read of one page and its verdict (scanVerdictOf), in
 *  its trace step. A short "not now" is waited through on the page. */
async function scanPage(
  ownerId: string,
  page: number,
  pdf: Buffer,
  lines: number | null,
  input: string,
  d: ScanPdfDeps,
  saw: (ran: boolean, model: string | null) => void,
  waits: ScanWaits,
  picture: () => Promise<{ bytes: Buffer; mimeType: string } | null>,
) {
  return step(
    {
      name: 'extract_scan_reader',
      kind: 'llm_call',
      input: { page, mime: 'application/pdf', bytes: pdf.length },
    },
    async (h) => {
      // A throw (not the provider's: runScanReader answers those) is no
      // answer: the window's other pages stand and are kept. A short "not
      // now" is waited through on this page.
      const scanOnce = () =>
        d
          .scan({
            ownerId,
            pdf,
            ...(lines !== null ? { expectedLines: lines } : {}),
            tries: 2,
            input,
          })
          .catch((err: unknown): ScanReaderResult => ({
            ran: false,
            attempted: true,
            text: '',
            pictures: 0,
            note: errorMessage(err),
            model: null,
            engine: 'mistral-ocr',
            quality: {
              ok: false,
              reasons: ['no_text'],
              illegibleShare: 0,
              anchors: 0,
              agreement: null,
            },
          }));
      const out = await callThroughWaits(scanOnce, (a) => a.wait, { pauses: waits.pauses });
      if (!out.attempted) {
        h.setSkipped('no_scan_reader');
        h.setMeta({ page, note: out.note });
        return { out, verdict: null };
      }
      // Still "not now": nothing billed, the page is not judged; the read
      // stops here and waits (the caller's queue).
      if (!out.ran && out.wait) {
        h.setSkipped(`provider_${out.wait.reason}`);
        h.setMeta({ page, wait: out.wait.reason, note: out.note });
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
}

/** Mostly a figure: one vision call describes it from the page's picture.
 *  A figure vision cannot describe (no picture, no vision worker, no text)
 *  is unread for good (`figure`): its Scan reader read is paid, and a later
 *  read would pay it again to the same end. */
async function describeFigure(
  at: { ownerId: string; filename: string; page: number },
  input: string,
  d: ScanPdfDeps,
  saw: (ran: boolean, model: string | null) => void,
  waits: ScanWaits,
  picture: () => Promise<{ bytes: Buffer; mimeType: string } | null>,
): Promise<ScanPage> {
  const { ownerId, filename, page } = at;
  const unreadAs = (why: ScanUnreadReason): ScanPage => ({ page, method: 'unread', text: '', why });
  const pic = await picture();
  if (!pic) return unreadAs('figure');
  const seen = await step(
    {
      name: 'extract_vision',
      kind: 'llm_call',
      input: { page, mime: pic.mimeType, bytes: pic.bytes.length, figure: true },
    },
    async (h) => {
      const r = await callThroughWaits(
        () =>
          d
            .vision({
              ownerId,
              bytes: pic.bytes,
              mimeType: pic.mimeType,
              filename: `${filename}#page-${page}.${pic.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`,
              input,
            })
            .catch((err: unknown): VisionResult => ({
              ran: false,
              text: '',
              note: errorMessage(err),
              model: null,
            })),
        (a) => a.wait,
        { pauses: waits.pauses },
      );
      h.setMeta({
        ran: r.ran,
        note: r.note,
        model: r.model,
        page,
        textLength: r.text.length,
        ...(r.wait ? { wait: r.wait.reason } : {}),
      });
      return r;
    },
  );
  // Still "not now" for the figure: not final (a try again describes it;
  // its Scan reader read is a kept answer, not paid again).
  if (!seen.ran && seen.wait) {
    waits.onWait(seen.wait);
    return unreadAs('failed');
  }
  saw(seen.ran, seen.model);
  return seen.text.trim() ? { page, method: 'vision', text: seen.text.trim() } : unreadAs('figure');
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
