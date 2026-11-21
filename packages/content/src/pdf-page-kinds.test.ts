/**
 * The router's part 2, the page types (./pdf-read.ts pdfPageKindsOf; plan
 * page c607711a, M3 in shadow), with the parser's two jobs made up here
 * (the qpdf cut and the router's window step), so the core's part is pinned
 * on its own: only the 8 checked fields of an ask reach the decider; every
 * page gets a type and a `Kind from`; each cap (the file's, the day's, a
 * stop) ends in the rules with its word and cuts no window more; the file's
 * one batch is settled once; a busy parser throws.
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
const { pdfPageKindsOf } = await import('./pdf-read');
type Decide = import('./pdf-read').PdfPageDecide;

const TOTAL = 60;
/** A router with a page cap of `cap` decider asks. */
const routerOf = (cap = 10_000) =>
  ({
    id: 'pdf-router',
    name: 'PDF router',
    description: 'Names the kind of a PDF.',
    version: '1.3.0',
    api: 1,
    runtime: 'bun',
    entry: 'step.ts',
    start: 'upload',
    router: true,
    match: { ext: ['pdf'] },
    produces: {},
    needs: { weight: 'light', workers: { decider: cap } },
  }) as never;

/** Page 3 of each window is blank, page 4 is not drawn; the rest asks. A
 *  step's ask carries a key of its own, which must stay behind. */
function windows() {
  split.mockImplementation(async (_b: Buffer, o: { from: number; pages: number }) => {
    const pageTo = Math.min(TOTAL, o.from + o.pages - 1);
    return { bytes: Buffer.from(`w${o.from}`), pageFrom: o.from, pageTo, pagesTotal: TOTAL };
  });
  step.mockImplementation(async (_body: Buffer, _p: unknown, req: Record<string, unknown>) => {
    const from = req.pageFrom as number;
    const to = req.pageTo as number;
    const pages: [number, string, string | null][] = [];
    const calls: unknown[] = [];
    const pictures = new Map<string, Buffer>();
    for (let n = from; n <= to; n++) {
      const i = n - from + 1;
      if (i === 3) pages.push([n, 'none', 'blank']);
      else if (i === 4) pages.push([n, 'scan', 'not drawn']);
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
 *  page at 0.45 (low). `room` the day cap leaves; `stopAt` a page that
 *  says `stop`. */
function decider(opts: { room?: number; stopAt?: number } = {}) {
  const asked: Record<string, unknown>[] = [];
  let settled = 0;
  const d: Decide = {
    room: async () => (opts.room ?? 20_000) - asked.length,
    ask: async (ask) => {
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
  return { d, asked, settled: () => settled };
}

beforeEach(() => {
  split.mockReset();
  step.mockReset();
});

describe('the page types of a PDF (part 2, shadow)', () => {
  it('only the 8 checked fields of an ask reach the decider', async () => {
    windows();
    const { d, asked } = decider();
    await pdfPageKindsOf(routerOf(), Buffer.from('pdf'), {}, d);
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
    const kinds = await pdfPageKindsOf(routerOf(), Buffer.from('pdf'), {}, d);
    expect(asked.some((a) => a.page === 1)).toBe(false);
    expect(kinds.find((k) => k.page === 1)).toMatchObject({ from: PAGE_KIND_FROM.notDrawn });
  });

  it('every page gets a type and its word; the rules kind stays the Kind', async () => {
    windows();
    const { d, settled } = decider();
    const kinds = await pdfPageKindsOf(routerOf(), Buffer.from('pdf'), {}, d);
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
    const kinds = await pdfPageKindsOf(routerOf(5), Buffer.from('pdf'), {}, d);
    expect(asked.length).toBe(5);
    expect(split).toHaveBeenCalledTimes(1);
    expect(kinds.filter((k) => k.from === PAGE_KIND_FROM.cap).length).toBe(TOTAL - 5 - 2);
    expect(kinds.length).toBe(TOTAL);
  });

  it('past the day cap: rules, `day cap`, and no window more is cut', async () => {
    windows();
    const { d, asked } = decider({ room: 30 });
    const kinds = await pdfPageKindsOf(routerOf(), Buffer.from('pdf'), {}, d);
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
    const kinds = await pdfPageKindsOf(routerOf(), Buffer.from('pdf'), {}, d);
    // The ask in flight with it (4 at once) still came back; none after.
    expect(asked.length).toBeLessThanOrEqual(4);
    expect(split).toHaveBeenCalledTimes(1);
    expect(kinds.find((k) => k.page === 2)).toMatchObject({ from: PAGE_KIND_FROM.noAnswer });
    expect(kinds.find((k) => k.page === TOTAL)).toMatchObject({ from: PAGE_KIND_FROM.noAnswer });
  });

  it('a busy parser throws (the extract is tried again); another failure ends with what it has', async () => {
    windows();
    split.mockRejectedValueOnce(
      new ParserError('busy', 'busy', { retryable: true, terminal: false }),
    );
    await expect(pdfPageKindsOf(routerOf(), Buffer.from('pdf'), {}, decider().d)).rejects.toThrow();
    windows();
    split.mockRejectedValueOnce(new Error('qpdf could not read it'));
    expect(await pdfPageKindsOf(routerOf(), Buffer.from('pdf'), {}, decider().d)).toEqual([]);
  });
});
