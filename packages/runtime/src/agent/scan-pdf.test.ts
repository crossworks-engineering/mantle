/**
 * readScannedPdf: a scanned PDF read page by page with the Scan reader
 * (scan-pdf.ts), every page, with no cap. The parser, the workers and the
 * decider are stand-ins (`deps`); the windows, the order of the work and
 * each page's verdict are real.
 */
import { describe, expect, it, vi } from 'vitest';
import { ParserError } from '@mantle/files';

vi.mock('@mantle/tracing', async (orig) => ({
  ...(await orig<typeof import('@mantle/tracing')>()),
  step: vi.fn(async (_spec: unknown, fn: (h: unknown) => unknown) =>
    fn({ setMeta: () => {}, setError: () => {}, setSkipped: () => {} }),
  ),
}));

import {
  pageMarksOf,
  readScannedPdf,
  scanCountsOf,
  scanTextOf,
  scanVerdictOf,
  SCAN_WINDOW,
  scanPageFinal,
  type PageMark,
  type ScanPage,
  type ScanPdfDeps,
} from './scan-pdf';
import { scanReadQualityOf } from './scan-reader-quality';
import {
  claimOn,
  keepOn,
  shareDataOf,
  type ScanReader,
  type ScanShareData,
  type ScanShareHooks,
} from './scan-share';
import type { ScanReaderResult } from './scan-reader';
import type { PdfWindowPart } from '@mantle/content/pipeline-runner';

const ROWS = Array.from({ length: 12 }, (_, i) => `ROW ${i} | VALVE | 2-${i} | ASTM A105`).join(
  '\n',
);

/** A Scan reader answer: its text, figures and quality as the worker's. */
function answer(text: string, opts: { pictures?: number; lines?: number } = {}): ScanReaderResult {
  return {
    ran: true,
    attempted: true,
    text,
    pictures: opts.pictures ?? 0,
    note: null,
    model: 'm',
    engine: 'mistral-ocr',
    quality: scanReadQualityOf(text, { expectedLines: opts.lines ?? 12 }),
  };
}

type Plan = {
  total: number;
  marks?: (n: number) => Partial<PageMark> | undefined;
  scan?: (page: number) => ScanReaderResult;
  cut?: (page: number) => Buffer | Error;
  /** Throw this from the window starting at `from`. */
  windowThrows?: { from: number; err: Error };
  /** How long each Scan reader call takes. */
  delayMs?: number;
};

function deps(plan: Plan) {
  const calls = { scan: [] as number[], vision: 0, draw: 0, check: 0, cut: [] as number[] };
  const pdfOf = (n: number) => Buffer.from(`page ${n}`);
  const d: Partial<ScanPdfDeps> = {
    // As pdfWindows / pdfWindowsAt: every window, or each from the first
    // needed page past the window before.
    windows: async function* (_b, _s, w, needed) {
      const starts: number[] = [];
      if (needed === null) {
        for (let f = 1; f <= plan.total; f += w.pages) starts.push(f);
      } else {
        let edge = 0;
        for (const n of needed) {
          if (n <= edge) continue;
          starts.push(n);
          edge = n + w.pages - 1;
        }
      }
      for (const from of starts) {
        if (plan.windowThrows?.from === from) throw plan.windowThrows.err;
        const to = Math.min(plan.total, from + w.pages - 1);
        yield {
          part: { bytes: Buffer.from('w'), pageFrom: from, pageTo: to, pagesTotal: plan.total },
        };
      }
    } as ScanPdfDeps['windows'],
    marks: async (part: PdfWindowPart) => {
      const m = new Map<number, PageMark>();
      for (let n = part.pageFrom; n <= part.pageTo; n += 1) {
        const got = plan.marks?.(n);
        m.set(n, {
          page: n,
          method: 'vision',
          why: 'scan',
          lines: 12,
          text: '',
          ...got,
        });
      }
      return m;
    },
    cut: async (_part, page) => {
      calls.cut.push(page);
      const c = plan.cut?.(page) ?? pdfOf(page);
      if (c instanceof Error) throw c;
      return c;
    },
    draw: async () => {
      calls.draw += 1;
      return { bytes: Buffer.from('png'), mimeType: 'image/png' };
    },
    scan: (async (o: { pdf: Buffer }) => {
      const page = Number(o.pdf.toString().split(' ')[1]);
      calls.scan.push(page);
      if (plan.delayMs) await new Promise((r) => setTimeout(r, plan.delayMs));
      return plan.scan?.(page) ?? answer(`${ROWS}\nPAGE ${page}`);
    }) as ScanPdfDeps['scan'],
    vision: (async () => {
      calls.vision += 1;
      return { ran: true, text: 'A pump curve, flow against head.', note: null, model: 'v' };
    }) as ScanPdfDeps['vision'],
    check: (async () => {
      calls.check += 1;
      return null;
    }) as ScanPdfDeps['check'],
  };
  return { d, calls };
}

const read = (plan: Plan, more: Partial<Parameters<typeof readScannedPdf>[0]> = {}) => {
  const { d, calls } = deps(plan);
  return readScannedPdf({
    ownerId: 'o1',
    bytes: Buffer.from('%PDF'),
    sha256: 'a'.repeat(64),
    filename: 'scan.pdf',
    deps: d,
    ...more,
  }).then((r) => ({ r, calls }));
};

describe('readScannedPdf', () => {
  it('reads every page, past any old cap, one Scan reader call a page', async () => {
    const { r, calls } = await read({ total: 45 });
    expect(r.pagesTotal).toBe(45);
    expect(r.pages).toHaveLength(45);
    expect(r.pages.every((p) => p.method === 'scan_reader')).toBe(true);
    expect(calls.scan.sort((a, b) => a - b)).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
    expect(calls.vision).toBe(0);
    expect(scanTextOf(r.pages, r.pagesTotal)).toContain('[Page 45]');
  });

  it('pays nothing for a typed or a white page', async () => {
    const { r, calls } = await read({
      total: 3,
      marks: (n) =>
        n === 1
          ? { method: 'text', text: 'Typed cover' }
          : n === 2
            ? { method: 'blank' }
            : undefined,
    });
    expect(r.pages.map((p) => p.method)).toEqual(['text', 'blank', 'scan_reader']);
    expect(calls.scan).toEqual([3]);
    expect(calls.cut).toEqual([3]);
  });

  it('leaves a page read badly unread, with no second paid call', async () => {
    const { r, calls } = await read({ total: 1, scan: () => answer('x [?] [?] [?]') });
    expect(r.pages[0]).toMatchObject({ method: 'unread', why: 'bad_read' });
    expect(calls.scan).toEqual([1]);
    expect(calls.vision).toBe(0);
  });

  it('has vision describe a page the engine finds mostly a figure', async () => {
    const { r, calls } = await read({ total: 1, scan: () => answer('FIG 1', { pictures: 1 }) });
    expect(r.pages[0]).toMatchObject({
      method: 'vision',
      text: 'A pump curve, flow against head.',
    });
    expect(calls.draw).toBe(1);
    expect(calls.vision).toBe(1);
  });

  it('says there is no Scan reader, a provider that failed, a page too large, a page not cut', async () => {
    const { r, calls } = await read({
      total: 4,
      scan: (n) =>
        n === 1
          ? { ...answer(''), ran: false, attempted: false, model: null }
          : { ...answer(''), ran: false },
      cut: (n) =>
        n === 3
          ? Buffer.alloc(11 * 1024 * 1024)
          : n === 4
            ? new ParserError('failed', 'qpdf', { retryable: false, terminal: false })
            : undefined!,
    });
    expect(r.pages.map((p) => p.why)).toEqual(['no_scan_reader', 'failed', 'too_large', 'not_cut']);
    expect(calls.scan.sort()).toEqual([1, 2]);
    expect(scanCountsOf(r.pages)).toEqual({
      read: 0,
      unread: { no_scan_reader: 1, failed: 1, too_large: 1, not_cut: 1 },
    });
  });

  it('a busy parser throws before the window’s first paid call; the windows before are kept', async () => {
    const kept: number[] = [];
    const busy = new ParserError('busy', 'busy', { retryable: true, terminal: false });
    const { d, calls } = deps({
      total: 30,
      windowThrows: { from: 1 + SCAN_WINDOW.pages, err: busy },
    });
    await expect(
      readScannedPdf({
        ownerId: 'o1',
        bytes: Buffer.from('%PDF'),
        sha256: 'a'.repeat(64),
        filename: 'scan.pdf',
        deps: d,
        onWindow: async (pages) => {
          kept.push(...pages.map((p) => p.page));
        },
      }),
    ).rejects.toBe(busy);
    expect(kept).toHaveLength(SCAN_WINDOW.pages);
    expect(calls.scan).toHaveLength(SCAN_WINDOW.pages);
  });

  it('a busy cut throws with no page of its window paid for', async () => {
    const busy = new ParserError('busy', 'busy', { retryable: true, terminal: false });
    const { r, calls } = await read({ total: 2, cut: (n) => (n === 2 ? busy : undefined!) }).catch(
      (e: unknown) => ({ r: e, calls: null }),
    );
    expect(r).toBe(busy);
    expect(calls).toBeNull();
  });

  it('reads only the pages a read before did not keep, and cuts no window of kept pages', async () => {
    const done = new Set(
      Array.from({ length: 45 }, (_, i) => i + 1).filter((n) => n !== 7 && n < 41),
    );
    const { r, calls } = await read({ total: 45 }, { done, pagesTotal: 45 });
    expect(r.pages.map((p) => p.page)).toEqual([7, 41, 42, 43, 44, 45]);
    expect(calls.scan.sort((a, b) => a - b)).toEqual([7, 41, 42, 43, 44, 45]);
    expect(calls.cut.sort((a, b) => a - b)).toEqual([7, 41, 42, 43, 44, 45]);
  });

  it('pays for nothing when a read before kept every page', async () => {
    const done = new Set([1, 2, 3]);
    const { r, calls } = await read({ total: 3 }, { done, pagesTotal: 3 });
    expect(r.pages).toEqual([]);
    expect(calls.scan).toHaveLength(0);
  });

  it('a figure vision cannot describe is unread for good; a throw is no answer', async () => {
    const { d, calls } = deps({
      total: 2,
      scan: (n) => (n === 1 ? answer('FIG', { pictures: 1 }) : answer(ROWS)),
    });
    d.vision = (async () => ({
      ran: false,
      text: '',
      note: 'no vision worker',
      model: null,
    })) as ScanPdfDeps['vision'];
    const scan = d.scan!;
    d.scan = (async (o: Parameters<ScanPdfDeps['scan']>[0]) => {
      if (o.pdf.toString() === 'page 2') throw new Error('db down');
      return scan(o);
    }) as ScanPdfDeps['scan'];
    const r = await readScannedPdf({
      ownerId: 'o1',
      bytes: Buffer.from('%PDF'),
      sha256: 'a'.repeat(64),
      filename: 'scan.pdf',
      deps: d,
    });
    expect(r.pages.map((p) => p.why)).toEqual(['figure', 'failed']);
    expect(r.pages.map(scanPageFinal)).toEqual([true, false]);
    expect(calls.vision).toBe(0);
  });

  it('says the pages not reached in a chat turn’s time, and pays for none of them', async () => {
    const { r, calls } = await read({ total: 50 }, { deadline: Date.now() - 1 });
    expect(r.pages).toHaveLength(50);
    expect(r.pages.every((p) => p.why === 'time')).toBe(true);
    expect(calls.scan).toHaveLength(0);
  });
});

describe('readScannedPdf: the provider says "not now"', () => {
  /** The provider's answer of no credit: a wait, nothing billed. */
  const noCredit = (): ScanReaderResult => ({
    ...answer(''),
    ran: false,
    note: 'Scan reader failed: 402',
    wait: { reason: 'quota', status: 402 },
  });

  it('stops there: the pages read before stand, the rest are not final, and a try again reads only them', async () => {
    const { r, calls } = await read(
      { total: 45, scan: (n) => (n === 25 ? noCredit() : answer(`${ROWS}\nPAGE ${n}`)) },
      { waitPauses: [] },
    );
    expect(r.wait).toEqual({ reason: 'quota', status: 402 });
    expect(r.waitPaid).toBeUndefined();
    expect(r.pages).toHaveLength(45);
    // The first window is read whole; no page past the wait's window is sent.
    expect(r.pages.slice(0, 20).every((p) => p.method === 'scan_reader')).toBe(true);
    expect(r.pages.find((p) => p.page === 25)).toMatchObject({ method: 'unread', why: 'failed' });
    expect(r.pages.slice(40).every((p) => p.why === 'failed')).toBe(true);
    expect(calls.scan.some((n) => n > 40)).toBe(false);
    // The try again (credit added): the final pages are kept, only the rest
    // are paid for.
    const done = new Set(r.pages.filter(scanPageFinal).map((p) => p.page));
    const left = r.pages.filter((p) => !scanPageFinal(p)).map((p) => p.page);
    expect(left).toContain(25);
    const again = await read({ total: 45 }, { done, pagesTotal: 45 });
    expect(again.r.wait).toBeUndefined();
    expect(again.calls.scan.sort((a, b) => a - b)).toEqual(left);
    expect(again.r.pages.every((p) => p.method === 'scan_reader')).toBe(true);
  });

  it('a short "not now" is waited through on the page: the same page again, nothing else', async () => {
    let tries = 0;
    const { r, calls } = await read(
      {
        total: 3,
        scan: (n) => {
          if (n === 2 && tries++ === 0) {
            return { ...noCredit(), wait: { reason: 'rate_limit', status: 429 } };
          }
          return answer(`${ROWS}\nPAGE ${n}`);
        },
      },
      { waitPauses: [0] },
    );
    expect(r.wait).toBeUndefined();
    expect(r.pages.every((p) => p.method === 'scan_reader')).toBe(true);
    expect(calls.scan.sort((a, b) => a - b)).toEqual([1, 2, 2, 3]);
  });

  it('a figure whose vision call waits is not final, and the wait says its read was paid', async () => {
    const { d, calls } = deps({
      total: 2,
      scan: (n) => (n === 1 ? answer('FIG', { pictures: 1 }) : answer(ROWS)),
    });
    d.vision = (async () => ({
      ran: false,
      text: '',
      note: 'Vision worker failed: 503',
      model: 'v',
      wait: { reason: 'overloaded', status: 503 },
    })) as ScanPdfDeps['vision'];
    const r = await readScannedPdf({
      ownerId: 'o1',
      bytes: Buffer.from('%PDF'),
      sha256: 'a'.repeat(64),
      filename: 'scan.pdf',
      waitPauses: [],
      deps: d,
    });
    expect(r.wait).toEqual({ reason: 'overloaded', status: 503 });
    expect(r.waitPaid).toBe(true);
    expect(r.pages[0]).toMatchObject({ page: 1, method: 'unread', why: 'failed' });
    expect(scanPageFinal(r.pages[0]!)).toBe(false);
    expect(calls.scan.sort()).toEqual([1, 2]);
  });
});

describe('scanVerdictOf', () => {
  const live = (passes: boolean) =>
    vi.fn(async () => ({
      faithful: passes ? 0.9 : 0.1,
      model: 'j',
      mode: 'live' as const,
      used: true,
      passes,
      threshold: 0.5,
    }));

  it('asks the decider with the page picture when no free rule finds fault', async () => {
    const check = live(false);
    const pic = vi.fn(async () => ({ bytes: Buffer.from('p'), mimeType: 'image/png' }));
    const v = await scanVerdictOf('o1', answer(ROWS), pic, check);
    expect(v.verdict).toBe('bad');
    expect(pic).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('a live yes stands for `unverified`; any other fault stays bad', async () => {
    const made = Array.from({ length: 40 }, (_, i) => `MADE UP ROW ${i} | 2-${i} | A105`).join(
      '\n',
    );
    expect(
      (await scanVerdictOf('o1', answer(made, { lines: 8 }), async () => null, live(true))).verdict,
    ).toBe('bad');
    const pic = async () => ({ bytes: Buffer.from('p'), mimeType: 'image/png' });
    expect((await scanVerdictOf('o1', answer(made, { lines: 8 }), pic, live(true))).verdict).toBe(
      'good',
    );
    const check = live(true);
    expect((await scanVerdictOf('o1', answer('a [?] [?] [?] [?]'), pic, check)).verdict).toBe(
      'bad',
    );
    expect(check).not.toHaveBeenCalled();
  });

  it('a figure is no read to judge', async () => {
    const check = live(true);
    expect(
      (await scanVerdictOf('o1', answer('FIG', { pictures: 1 }), async () => null, check)).verdict,
    ).toBe('figure');
    expect(check).not.toHaveBeenCalled();
  });
});

describe('pageMarksOf', () => {
  it('reads the Reader’s tab Pages', () => {
    const marks = pageMarksOf({
      tabs: [
        {
          name: 'Pages',
          columns: ['Page', 'Paper', 'Method', 'Why', 'Chars', 'Lines', 'Text'].map((name) => ({
            name,
            type: 'text' as const,
          })) as never,
          rows: [
            [1, 'A4', 'text', null, 120, null, 'Typed'],
            [2, 'A4', 'vision', 'scan', 0, 44, ''],
            [3, 'A4', 'blank', null, 0, null, ''],
          ],
        },
      ],
    });
    expect(marks.get(1)).toMatchObject({ method: 'text', text: 'Typed', lines: null });
    expect(marks.get(2)).toMatchObject({ method: 'vision', why: 'scan', lines: 44 });
    expect(marks.get(3)?.method).toBe('blank');
    expect(pageMarksOf(undefined).size).toBe(0);
  });
});

describe('the reads shared by the readers of one upload (scan-share.ts)', () => {
  /** One node's shared reads, in memory: the store's own pure rules. */
  function memoryShare(store: ScanShareData, by: ScanReader, claimMs = 60_000): ScanShareHooks {
    return {
      claim: async (pages) => claimOn(store, pages, by, Date.now(), Date.now() + claimMs),
      keep: async (pages, total) => keepOn(store, pages, by, scanPageFinal, total),
      wait: async (pages, until) => {
        for (;;) {
          const got = new Map(
            pages
              .filter((n) => store.pages[String(n)])
              .map((n) => {
                const [method, why, text] = store.pages[String(n)]!;
                return [n, { page: n, method, text, ...(why ? { why } : {}) } as ScanPage];
              }),
          );
          const ended = pages.some(
            (n) => !store.pages[String(n)] && (store.claims[String(n)]?.[1] ?? 0) <= Date.now(),
          );
          if (got.size === pages.length || ended || Date.now() >= until) return got;
          await new Promise((r) => setTimeout(r, 5));
        }
      },
    };
  }
  const fresh = (): ScanShareData => ({ sha256: 'a'.repeat(64), pages: {}, claims: {} });
  const readWith = (share: ScanShareHooks, plan: Plan, more: Record<string, unknown> = {}) => {
    const { d, calls } = deps(plan);
    return readScannedPdf({
      ownerId: 'o1',
      bytes: Buffer.from('%PDF'),
      sha256: 'a'.repeat(64),
      filename: 'scan.pdf',
      deps: d,
      share,
      ...more,
    }).then((r) => ({ r, calls }));
  };

  it('the chat turn first: the extract takes its pages and pays for none', async () => {
    const store = fresh();
    const chat = await readWith(
      memoryShare(store, 'chat'),
      { total: 3 },
      { deadline: Date.now() + 60_000 },
    );
    expect(chat.calls.scan.sort()).toEqual([1, 2, 3]);
    const extract = await readWith(memoryShare(store, 'extract'), { total: 3 });
    expect(extract.calls.scan).toHaveLength(0);
    expect(extract.calls.cut).toHaveLength(0);
    expect(extract.r.pages.map((p) => p.text)).toEqual(chat.r.pages.map((p) => p.text));
  });

  it('the extract first: the chat turn takes its pages and pays for none', async () => {
    const store = fresh();
    const extract = await readWith(memoryShare(store, 'extract'), { total: 3 });
    expect(extract.calls.scan).toHaveLength(3);
    const chat = await readWith(
      memoryShare(store, 'chat'),
      { total: 3 },
      { deadline: Date.now() + 60_000 },
    );
    expect(chat.calls.scan).toHaveLength(0);
    expect(chat.r.pages.every((p) => p.method === 'scan_reader')).toBe(true);
  });

  it('both at once: each page is read one time, and both have every page', async () => {
    const store = fresh();
    const slow = (n: number) => answer(`${ROWS}\nPAGE ${n}`);
    const plan: Plan = { total: 8, scan: slow };
    const [a, b] = await Promise.all([
      readWith(memoryShare(store, 'chat'), plan, { deadline: Date.now() + 60_000 }),
      readWith(memoryShare(store, 'extract'), plan),
    ]);
    const paid = [...a.calls.scan, ...b.calls.scan].sort((x, y) => x - y);
    expect(paid).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(a.r.pages.filter((p) => p.method === 'scan_reader')).toHaveLength(8);
    expect(b.r.pages.filter((p) => p.method === 'scan_reader')).toHaveLength(8);
  });

  it('a page is kept as its read ends: a waiting chat turn has it before the window ends', async () => {
    const store = fresh();
    // The extract claims the window of 8 first; each call takes 100 ms, 4 at
    // once, so its window ends after about 200 ms.
    const extract = readWith(memoryShare(store, 'extract'), { total: 8, delayMs: 100 });
    await new Promise((r) => setTimeout(r, 5));
    // The chat turn has 170 ms: the first 4 pages are kept by then.
    const chat = await readWith(
      memoryShare(store, 'chat'),
      { total: 8 },
      { deadline: Date.now() + 170 },
    );
    expect(chat.calls.scan).toHaveLength(0);
    expect(chat.r.pages.filter((p) => p.method === 'scan_reader').length).toBeGreaterThanOrEqual(4);
    expect(chat.r.pages.filter((p) => p.why === 'time').length).toBeLessThanOrEqual(4);
    expect((await extract).calls.scan).toHaveLength(8);
  });

  it('each page is claimed again before its call: a window claim that ended while its first pages waited pays nothing twice', async () => {
    const store = fresh();
    // The extract's claim holds 400 ms; each call takes 300 ms, 4 at once:
    // the window's third round starts at about 600 ms, past the window's
    // claim (as a long "not now" pause makes a real window outlast it).
    const extract = readWith(memoryShare(store, 'extract', 400), { total: 12, delayMs: 300 });
    // The chat turn comes at about 480 ms: the window's claim ended.
    await new Promise((r) => setTimeout(r, 480));
    const chat = await readWith(
      memoryShare(store, 'chat'),
      { total: 12 },
      { deadline: Date.now() + 10_000 },
    );
    const ex = await extract;
    // Each page paid one time in all, and both readers have every page.
    const paid = [...chat.calls.scan, ...ex.calls.scan].sort((x, y) => x - y);
    expect(paid).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(ex.r.pages.filter((p) => p.method === 'scan_reader')).toHaveLength(12);
    expect(chat.r.pages.filter((p) => p.method === 'scan_reader')).toHaveLength(12);
  });

  it('a page read with no answer is not kept: the next reader reads it', async () => {
    const store = fresh();
    await readWith(memoryShare(store, 'chat'), {
      total: 2,
      scan: (n) => (n === 2 ? { ...answer(''), ran: false } : answer(`${ROWS}\nPAGE ${n}`)),
    });
    expect(Object.keys(store.pages)).toEqual(['1']);
    expect(store.claims).toEqual({});
    const extract = await readWith(memoryShare(store, 'extract'), { total: 2 });
    expect(extract.calls.scan).toEqual([2]);
  });

  it('a whole read already on the node stops the chat turn before any call', async () => {
    const { d, calls } = deps({ total: 3 });
    const r = await readScannedPdf({
      ownerId: 'o1',
      bytes: Buffer.from('%PDF'),
      sha256: 'a'.repeat(64),
      filename: 'scan.pdf',
      deps: d,
      share: {
        claim: async () => ({ final: true, kept: new Map(), mine: [], theirs: new Map() }),
        keep: async () => {},
        wait: async () => new Map(),
      },
    });
    expect(r.readBefore).toBe(true);
    expect(calls.scan).toHaveLength(0);
  });
});

describe('claimOn and keepOn', () => {
  it('one claim wins; a claim that ended, or the reader’s own, is taken again', () => {
    const share: ScanShareData = { sha256: 's', pages: {}, claims: {} };
    expect(claimOn(share, [1, 2], 'chat', 1000, 5000).mine).toEqual([1, 2]);
    const second = claimOn(share, [1, 2, 3], 'extract', 2000, 9000);
    expect(second.mine).toEqual([3]);
    expect([...second.theirs]).toEqual([
      [1, 5000],
      [2, 5000],
    ]);
    expect(claimOn(share, [1], 'chat', 2000, 7000).mine).toEqual([1]);
    expect(claimOn(share, [2], 'extract', 6000, 9000).mine).toEqual([2]);
  });

  it('keeps final pages only, with no NUL, and ends the reader’s claims', () => {
    const share: ScanShareData = { sha256: 's', pages: {}, claims: {} };
    claimOn(share, [1, 2], 'chat', 0, 10);
    keepOn(
      share,
      [
        { page: 1, method: 'scan_reader', text: `a${String.fromCharCode(0)}b` },
        { page: 2, method: 'unread', text: '', why: 'failed' },
      ],
      'chat',
      scanPageFinal,
      2,
    );
    expect(share.pages).toEqual({ '1': ['scan_reader', '', 'ab'] });
    expect(share.claims).toEqual({});
    expect(share.total).toBe(2);
  });

  it('reads a stored value only for its bytes', () => {
    expect(shareDataOf({ sha256: 'x', pages: { 1: ['blank', '', ''] } }, 'y')).toBeNull();
    expect(
      shareDataOf({ sha256: 'x', pages: { 1: ['blank', '', ''], z: [1] } }, 'x')?.pages,
    ).toEqual({
      '1': ['blank', '', ''],
    });
  });
});
