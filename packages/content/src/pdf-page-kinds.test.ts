/**
 * The router's part 2, the page types (./pdf-read.ts pdfPageKindsOf; plan
 * page c607711a, M3 in shadow), with the parser's two jobs made up here
 * (the qpdf cut and the router's window step), so the core's part is pinned
 * on its own: only the 8 checked fields of an ask reach the decider; every
 * page gets a type and a `Kind from`; each cap (the file's, the day's, a
 * stop) ends in the rules with its word and cuts no window more; a kept
 * answer is free (a retry takes no room for it); a page with no row in the
 * tab Pages is not asked; the file's one batch is settled once; a busy
 * parser throws.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Files from '@mantle/files';

const split = vi.fn();
const step = vi.fn();
vi.mock('@mantle/files', async (orig) => ({
  ...(await orig<typeof Files>()),
  parserPdfSplit: (...a: unknown[]) => split(...a),
  parserPipelineRun: (...a: unknown[]) => step(...a),
}));

const { PAGE_KIND_FROM, ParserError, pagePictureName } = await import('@mantle/files');
const { pdfPageKindsOf, pdfPageKindsOver } = await import('./pdf-read');
type Decide = import('./pdf-read').PdfPageDecide;

const TOTAL = 60;
/** Every page of the made-up file has a row in the tab Pages. */
const ALL = new Set(Array.from({ length: TOTAL }, (_, i) => i + 1));
/** A router with a page cap of `cap` decider asks. */
const routerOf = (cap = 10_000, version = '1.3.0') =>
  ({
    id: 'pdf-router',
    name: 'PDF router',
    description: 'Names the kind of a PDF.',
    version,
    api: 1,
    runtime: 'bun',
    entry: 'step.ts',
    start: 'upload',
    router: true,
    match: { ext: ['pdf'] },
    produces: {},
    needs: { weight: 'light', workers: { decider: cap } },
  }) as never;

/** Page 3 of each window is blank, page 4 is not drawn; the rest asks
 *  (`plain`: every page asks). A step's ask carries a key of its own, which
 *  must stay behind. */
function windows(total = TOTAL, plain = false) {
  split.mockImplementation(async (_b: Buffer, o: { from: number; pages: number }) => {
    const pageTo = Math.min(total, o.from + o.pages - 1);
    return { bytes: Buffer.from(`w${o.from}`), pageFrom: o.from, pageTo, pagesTotal: total };
  });
  step.mockImplementation(async (_body: Buffer, _p: unknown, req: Record<string, unknown>) => {
    const from = req.pageFrom as number;
    const to = req.pageTo as number;
    const pages: [number, string, string | null][] = [];
    const calls: unknown[] = [];
    const pictures = new Map<string, Buffer>();
    for (let n = from; n <= to; n++) {
      const i = n - from + 1;
      if (i === 3 && !plain) pages.push([n, 'none', 'blank']);
      else if (i === 4 && !plain) pages.push([n, 'scan', 'not drawn']);
      else {
        pages.push([n, 'document', null]);
        const picture = pagePictureName(n);
        pictures.set(picture, Buffer.from(`picture ${n}`));
        calls.push({
          call: 'worker',
          worker: 'decider',
          key: `page-${n}`,
          input: {
            page: n,
            picture,
            size: 'a4',
            class: 'text',
            instrument_tags: 0,
            line_numbers: 0,
            tag_like_tokens: 1,
            text_sample: 'GENERAL NOTES',
            secret: 'stays behind',
          },
        });
      }
    }
    return { result: { status: 'ok', calls, state: { pages } }, pictures };
  });
}

/** A made-up decider: page N answers table at 0.9 (sure), but every 5th
 *  page at 0.45 (low). `room` the day cap leaves (a paid ask takes one);
 *  `stopAt` a page that says `stop`; `keptTo` the pages 1 to N whose answer
 *  is in the answer cache (an extract tried again). */
function decider(opts: { room?: number; stopAt?: number; keptTo?: number } = {}) {
  const asked: Record<string, unknown>[] = [];
  /** How many arguments the core gives kept and ask (the ask and the
   *  picture: no router version, which is not of the key). */
  const argCounts = new Set<number>();
  let settled = 0;
  const d: Decide = {
    room: async () => (opts.room ?? 20_000) - asked.length,
    kept: async (...a) => {
      argCounts.add(a.length);
      return a[0].page <= (opts.keptTo ?? 0)
        ? { kind: 'pid', confidence: 0.95, sure: true, model: 'm', mode: 'shadow' }
        : null;
    },
    ask: async (...a) => {
      argCounts.add(a.length);
      const ask = a[0];
      asked.push({ ...ask });
      if (ask.page === opts.stopAt) return 'stop';
      const low = ask.page % 5 === 0;
      return {
        kind: 'table',
        confidence: low ? 0.45 : 0.9,
        sure: !low,
        model: 'm',
        mode: 'shadow',
      };
    },
    settle: () => {
      settled += 1;
    },
  };
  return { d, asked, argCounts, settled: () => settled };
}

beforeEach(() => {
  split.mockReset();
  step.mockReset();
});

describe('the page types of a PDF (part 2, shadow)', () => {
  it('only the 8 checked fields of an ask reach the decider', async () => {
    windows();
    const { d, asked } = decider();
    await pdfPageKindsOf(routerOf(), Buffer.from('pdf'), {}, d, ALL);
    expect(asked.length).toBe(TOTAL - 2 * 3);
    for (const a of asked) {
      expect(Object.keys(a).sort()).toEqual(
        [
          'class',
          'instrument_tags',
          'line_numbers',
          'page',
          'picture',
          'size',
          'tag_like_tokens',
          'text_sample',
        ].sort(),
      );
    }
  });

  it('an ask that is not that shape is not asked: the page has no picture', async () => {
    windows();
    const inner = step.getMockImplementation()!;
    step.mockImplementation(async (...a: unknown[]) => {
      const out = await inner(...(a as [Buffer, unknown, Record<string, unknown>]));
      const first = out.result.calls[0] as { input: Record<string, unknown> };
      first.input = { ...first.input, text_sample: 'x'.repeat(501) };
      return out;
    });
    const { d, asked } = decider();
    const kinds = await pdfPageKindsOf(routerOf(), Buffer.from('pdf'), {}, d, ALL);
    expect(asked.some((a) => a.page === 1)).toBe(false);
    expect(kinds.find((k) => k.page === 1)).toMatchObject({ from: PAGE_KIND_FROM.notDrawn });
  });

  it('every page gets a type and its word; the rules kind stays the Kind', async () => {
    windows();
    const { d, settled } = decider();
    const kinds = await pdfPageKindsOf(routerOf(), Buffer.from('pdf'), {}, d, ALL);
    expect(kinds.map((k) => k.page)).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1));
    expect(kinds[0]).toEqual({
      page: 1,
      kind: 'document',
      from: PAGE_KIND_FROM.shadow,
      deciderKind: 'table',
      deciderConfidence: 0.9,
    });
    expect(kinds[2]).toMatchObject({ kind: 'none', from: PAGE_KIND_FROM.blank, deciderKind: null });
    expect(kinds[3]).toMatchObject({ kind: 'scan', from: PAGE_KIND_FROM.notDrawn });
    // Under the floor on the route's sum: recorded, low confidence.
    expect(kinds[4]).toMatchObject({ from: PAGE_KIND_FROM.low, deciderConfidence: 0.45 });
    expect(settled()).toBe(1);
  });

  it("past the file's cap: rules, `cap`, and no window more is cut", async () => {
    windows();
    const { d, asked } = decider();
    const kinds = await pdfPageKindsOf(routerOf(5), Buffer.from('pdf'), {}, d, ALL);
    expect(asked.length).toBe(5);
    expect(split).toHaveBeenCalledTimes(1);
    expect(kinds.filter((k) => k.from === PAGE_KIND_FROM.cap).length).toBe(TOTAL - 5 - 2);
    expect(kinds.length).toBe(TOTAL);
  });

  it('past the day cap: rules, `day cap`, and no window more is cut', async () => {
    windows();
    const { d, asked } = decider({ room: 30 });
    const kinds = await pdfPageKindsOf(routerOf(), Buffer.from('pdf'), {}, d, ALL);
    expect(asked.length).toBe(30);
    expect(split).toHaveBeenCalledTimes(2);
    const past = kinds.filter((k) => k.from === PAGE_KIND_FROM.dayCap);
    expect(past.length).toBeGreaterThan(0);
    expect(past.every((k) => k.deciderKind === null)).toBe(true);
    expect(kinds.length).toBe(TOTAL);
  });

  it('a stop (failures, the breaker): the rest is `no answer`, nothing more asked', async () => {
    windows();
    const { d, asked } = decider({ stopAt: 2 });
    const kinds = await pdfPageKindsOf(routerOf(), Buffer.from('pdf'), {}, d, ALL);
    // The ask in flight with it (4 at once) still came back; none after.
    expect(asked.length).toBeLessThanOrEqual(4);
    expect(split).toHaveBeenCalledTimes(1);
    expect(kinds.find((k) => k.page === 2)).toMatchObject({ from: PAGE_KIND_FROM.noAnswer });
    expect(kinds.find((k) => k.page === TOTAL)).toMatchObject({ from: PAGE_KIND_FROM.noAnswer });
  });

  it('a retry: 4,000 kept answers and room for 1,000 write all 4,000 as answers; only real calls take room', async () => {
    windows(6_000, true);
    const { d, asked, argCounts } = decider({ room: 1_000, keptTo: 4_000 });
    const rows = new Set(Array.from({ length: 6_000 }, (_, i) => i + 1));
    const kinds = await pdfPageKindsOf(routerOf(), Buffer.from('pdf'), {}, d, rows);
    const kept = kinds.filter((k) => k.page <= 4_000);
    expect(kept.length).toBe(4_000);
    expect(kept.every((k) => k.from === PAGE_KIND_FROM.shadow && k.deciderKind === 'pid')).toBe(
      true,
    );
    // The room went to real calls only: 1,000 new pages asked, the rest the
    // day cap's.
    expect(asked.length).toBe(1_000);
    expect(asked.every((a) => (a.page as number) > 4_000)).toBe(true);
    expect(kinds.filter((k) => k.from === PAGE_KIND_FROM.dayCap).length).toBe(1_000);
    expect(kinds.length).toBe(6_000);
    // No router version is given: the key is the question's (the decider's).
    expect([...argCounts]).toEqual([2]);
  });

  it('a retry with no day-cap room: 4,000 kept answers are all written as answers, past window 1 too', async () => {
    windows(6_000, true);
    const { d, asked } = decider({ room: 0, keptTo: 4_000 });
    const rows = new Set(Array.from({ length: 6_000 }, (_, i) => i + 1));
    // A release between the tries with a new router version (not of the
    // question): the kept answers are still taken.
    const kinds = await pdfPageKindsOf(routerOf(10_000, '1.3.1'), Buffer.from('pdf'), {}, d, rows);
    const kept = kinds.filter((k) => k.page <= 4_000);
    expect(kept.length).toBe(4_000);
    expect(kept.every((k) => k.from === PAGE_KIND_FROM.shadow && k.deciderKind === 'pid')).toBe(
      true,
    );
    expect(asked.length).toBe(0);
    // The first window with a page turned away (pages 4,001 to 4,025) is
    // the last cut: the rest is the day cap's.
    expect(split).toHaveBeenCalledTimes(4_000 / 25 + 1);
    const past = kinds.filter((k) => k.from === PAGE_KIND_FROM.dayCap);
    expect(past.length).toBe(2_000);
    expect(past.every((k) => k.page > 4_000 && k.deciderKind === null)).toBe(true);
    expect(kinds.length).toBe(6_000);
  });

  it('no day-cap room and no kept answer: the run stops after the first window that turned a page away', async () => {
    windows();
    const { d, asked } = decider({ room: 0 });
    const kinds = await pdfPageKindsOf(routerOf(), Buffer.from('pdf'), {}, d, ALL);
    expect(asked.length).toBe(0);
    expect(split).toHaveBeenCalledTimes(1);
    // Window 1: its asks turned away; then every page left is the day cap's.
    expect(kinds.find((k) => k.page === 1)).toMatchObject({ from: PAGE_KIND_FROM.dayCap });
    expect(kinds.filter((k) => k.page > 25).every((k) => k.from === PAGE_KIND_FROM.dayCap)).toBe(
      true,
    );
    expect(kinds.length).toBe(TOTAL);
  });

  it('a page with no row in the tab Pages is not asked; a window with none is not cut', async () => {
    windows();
    const { d, asked } = decider();
    // Rows for pages 1 to 10 only (the Reader lost the rest).
    const rows = new Set(Array.from({ length: 10 }, (_, i) => i + 1));
    await pdfPageKindsOf(routerOf(), Buffer.from('pdf'), {}, d, rows);
    expect(asked.every((a) => (a.page as number) <= 10)).toBe(true);
    expect(asked.length).toBe(10 - 2);
    expect(step).toHaveBeenCalledTimes(1);
    // No row at all: nothing is cut or asked.
    split.mockClear();
    step.mockClear();
    expect(await pdfPageKindsOf(routerOf(), Buffer.from('pdf'), {}, d, new Set())).toEqual([]);
    expect(split).not.toHaveBeenCalled();
    expect(step).not.toHaveBeenCalled();
  });

  it('a busy parser throws (the extract is tried again); another failure ends with what it has', async () => {
    windows();
    split.mockRejectedValueOnce(
      new ParserError('busy', 'busy', { retryable: true, terminal: false }),
    );
    await expect(
      pdfPageKindsOf(routerOf(), Buffer.from('pdf'), {}, decider().d, ALL),
    ).rejects.toThrow();
    windows();
    split.mockRejectedValueOnce(new Error('qpdf could not read it'));
    expect(await pdfPageKindsOf(routerOf(), Buffer.from('pdf'), {}, decider().d, ALL)).toEqual([]);
  });
});

describe("a person's run of one file over the stored page types (Q2)", () => {
  /** A stored answer of page n (an upload's). */
  const answered = (n: number) => ({
    page: n,
    kind: 'document',
    from: PAGE_KIND_FROM.shadow,
    deciderKind: 'pid',
    deciderConfidence: 0.97,
  });
  const ruled = (n: number, from: string) => ({
    page: n,
    kind: 'document',
    from,
    deciderKind: null,
    deciderConfidence: null,
  });

  it('an older file (no stored type): every page with ink is asked, and the answers are its types', async () => {
    windows();
    const { d, asked } = decider();
    const kinds = await pdfPageKindsOver(routerOf(), Buffer.from('pdf'), {}, d, ALL, []);
    expect(asked.length).toBe(TOTAL - 2 * 3);
    expect(kinds.length).toBe(TOTAL);
    expect(kinds[0]).toMatchObject({ from: PAGE_KIND_FROM.shadow, deciderKind: 'table' });
  });

  it('only the pages with no stored answer are asked; a stored answer stands, a stored rules word is asked again', async () => {
    windows();
    const { d, asked } = decider();
    // Window 1 (pages 1 to 25) typed at upload, its blank and not-drawn
    // pages too; pages 26 to 60 left by the day cap.
    const stored = [
      ...Array.from({ length: 25 }, (_, i) => i + 1).map((n) =>
        n % 25 === 3
          ? ruled(n, PAGE_KIND_FROM.blank)
          : n === 4
            ? ruled(n, PAGE_KIND_FROM.notDrawn)
            : answered(n),
      ),
      ...Array.from({ length: 35 }, (_, i) => ruled(i + 26, PAGE_KIND_FROM.dayCap)),
    ];
    const kinds = await pdfPageKindsOver(routerOf(), Buffer.from('pdf'), {}, d, ALL, stored);
    // Window 1 holds page 4 (not drawn: no answer), so it is cut again, but
    // no page of it with an answer is asked; windows 2 and 3 are asked.
    const pages = asked.map((a) => a.page as number);
    expect(pages.every((n) => n > 25)).toBe(true);
    expect(pages.length).toBe(35 - 2 * 2);
    // The stored answers stand as they were, not the new read's word.
    for (const n of [1, 2, 5, 25]) expect(kinds.find((k) => k.page === n)).toEqual(answered(n));
    expect(kinds.find((k) => k.page === 3)).toEqual(ruled(3, PAGE_KIND_FROM.blank));
    // The pages the day cap left now have their answers.
    expect(kinds.find((k) => k.page === 26)).toMatchObject({
      from: PAGE_KIND_FROM.shadow,
      deciderKind: 'table',
    });
    expect(kinds.length).toBe(TOTAL);
  });

  it('a second run asks nothing and cuts no window: every page is done', async () => {
    windows();
    const first = decider();
    const stored = await pdfPageKindsOver(routerOf(), Buffer.from('pdf'), {}, first.d, ALL, []);
    // The not-drawn pages (no answer) are the ones a run would cut for:
    // here they are given as answered, so the file is whole.
    const whole = stored.map((k) =>
      k.deciderKind || k.from === PAGE_KIND_FROM.blank ? k : answered(k.page),
    );
    split.mockClear();
    step.mockClear();
    const again = decider();
    const kinds = await pdfPageKindsOver(routerOf(), Buffer.from('pdf'), {}, again.d, ALL, whole);
    expect(again.asked).toEqual([]);
    expect(split).not.toHaveBeenCalled();
    expect(step).not.toHaveBeenCalled();
    expect(again.settled()).toBe(0);
    expect(kinds).toEqual(whole);
  });

  it('a day cap of 0: nothing is asked, the untyped pages say `day cap`, and the stored answers stand', async () => {
    windows();
    const { d, asked } = decider({ room: 0 });
    const stored = [answered(1), answered(2)];
    const kinds = await pdfPageKindsOver(routerOf(), Buffer.from('pdf'), {}, d, ALL, stored);
    expect(asked).toEqual([]);
    expect(kinds.find((k) => k.page === 1)).toEqual(answered(1));
    expect(kinds.find((k) => k.page === 5)).toMatchObject({
      from: PAGE_KIND_FROM.dayCap,
      deciderKind: null,
    });
    expect(kinds.filter((k) => k.page > 25).every((k) => k.from === PAGE_KIND_FROM.dayCap)).toBe(
      true,
    );
    expect(kinds.length).toBe(TOTAL);
  });

  it('a kept answer (the answer cache) is taken free, with no room', async () => {
    windows();
    const { d, asked } = decider({ room: 0, keptTo: 60 });
    const kinds = await pdfPageKindsOver(routerOf(), Buffer.from('pdf'), {}, d, ALL, []);
    expect(asked).toEqual([]);
    expect(kinds.filter((k) => k.deciderKind === 'pid').length).toBe(TOTAL - 2 * 3);
  });
});
