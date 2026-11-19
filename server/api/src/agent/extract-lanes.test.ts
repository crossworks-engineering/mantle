import { describe, expect, it } from 'vitest';
import { CAD_EXTS, extractWeightOfExt } from '@mantle/files';
import { BOOK_HEAVY_MIN_BYTES, BOOK_HEAVY_MIN_PAGES } from '@mantle/files';
import {
  BOOK_EXPIRE_MAX_MIN,
  bookExpireMinutes,
  ExtractCeiling,
  extractWeightOfNode,
  HEAVY_LANE_WORKERS,
} from './extract-lanes';

describe('extractWeightOfNode', () => {
  it('a drawing file is heavy, by the name the extractor types it by', () => {
    for (const ext of [...CAD_EXTS, 'dwf']) {
      expect(extractWeightOfNode({ type: 'file', title: 'x', filename: `plan.${ext}` })).toBe(
        'heavy',
      );
    }
    // An email attachment has no data.filename: the title is the file name.
    expect(extractWeightOfNode({ type: 'file', title: 'P-101.DWG', filename: null })).toBe('heavy');
  });

  it('a PDF of BOOK_HEAVY_MIN_BYTES or more is heavy (a book read by OCR); a smaller one light', () => {
    const pdf = (sizeBytes: number | null) =>
      extractWeightOfNode({ type: 'file', title: 'b.pdf', filename: 'b.pdf', sizeBytes });
    expect(BOOK_HEAVY_MIN_BYTES).toBe(10 * 1024 * 1024);
    expect(pdf(BOOK_HEAVY_MIN_BYTES)).toBe('heavy');
    expect(pdf(BOOK_HEAVY_MIN_BYTES - 1)).toBe('light');
    expect(pdf(null)).toBe('light');
    // Only a PDF: a large Word file stays light.
    expect(
      extractWeightOfNode({ type: 'file', title: 'a.docx', filename: 'a.docx', sizeBytes: 1e9 }),
    ).toBe('light');
  });

  it('a PDF of more than BOOK_HEAVY_MIN_PAGES pages is heavy whatever its bytes (M6)', () => {
    const pdf = (pages: number | null) =>
      extractWeightOfNode({
        type: 'file',
        title: 'b.pdf',
        filename: 'b.pdf',
        sizeBytes: 8e6,
        pages,
      });
    expect(BOOK_HEAVY_MIN_PAGES).toBe(200);
    // A typed catalogue of 4,000 pages in 8 MB.
    expect(pdf(4000)).toBe('heavy');
    expect(pdf(BOOK_HEAVY_MIN_PAGES + 1)).toBe('heavy');
    expect(pdf(BOOK_HEAVY_MIN_PAGES)).toBe('light');
    expect(pdf(null)).toBe('light');
    expect(
      extractWeightOfNode({ type: 'file', title: 'a.docx', filename: 'a.docx', pages: 4000 }),
    ).toBe('light');
  });

  it('the time budget of a book grows with its page windows, bounded', () => {
    expect(bookExpireMinutes(60, 1)).toBe(65);
    expect(bookExpireMinutes(60, 1000)).toBe(160);
    expect(bookExpireMinutes(60, 1679)).toBe(230);
    expect(bookExpireMinutes(60, 100_000)).toBe(BOOK_EXPIRE_MAX_MIN);
    expect(bookExpireMinutes(60, null)).toBe(BOOK_EXPIRE_MAX_MIN);
    // Never under the base a box set.
    expect(bookExpireMinutes(600, 10)).toBe(600);
  });

  it('every other file is light, a small PDF included', () => {
    for (const name of ['a.pdf', 'a.docx', 'a.xlsx', 'a.png', 'a.txt', 'no-extension', '']) {
      expect(extractWeightOfNode({ type: 'file', title: name, filename: name })).toBe('light');
    }
    expect(extractWeightOfNode({ type: 'file', title: null, filename: null })).toBe('light');
  });

  it('only a file has a weight: a note or a page titled like a drawing is light', () => {
    for (const type of ['note', 'page', 'email', 'task']) {
      expect(extractWeightOfNode({ type, title: 'old plan.dwg', filename: null })).toBe('light');
    }
  });

  it('the heavy list is the CAD list and DWF, nothing else', () => {
    const all = ['pdf', 'docx', 'xlsx', 'xml', 'csv', 'png', 'mp4', 'dwg', 'dxf', 'dgn', 'dwf'];
    expect(all.filter((e) => extractWeightOfExt(e) === 'heavy').sort()).toEqual(
      ['dgn', 'dwf', 'dwg', 'dxf'].sort(),
    );
  });

  it('the heavy lane is one wide, as the parser has one job slot', () => {
    expect(HEAVY_LANE_WORKERS).toBe(1);
  });
});

/** A run that ends when the test says so. */
function gate() {
  let open!: () => void;
  const done = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { done, open };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('ExtractCeiling', () => {
  it('runs at most `limit` at once and takes the waiting in order', async () => {
    const ceiling = new ExtractCeiling(2);
    const started: string[] = [];
    const gates = { a: gate(), b: gate(), c: gate(), d: gate() };
    const runs = (['a', 'b', 'c', 'd'] as const).map((name) =>
      ceiling.run(async () => {
        started.push(name);
        await gates[name].done;
        return name;
      }),
    );
    await tick();
    expect(started).toEqual(['a', 'b']);
    expect(ceiling.running).toBe(2);
    expect(ceiling.queued).toBe(2);

    gates.a.open();
    await tick();
    expect(started).toEqual(['a', 'b', 'c']);
    expect(ceiling.running).toBe(2);

    gates.b.open();
    gates.c.open();
    gates.d.open();
    await expect(Promise.all(runs)).resolves.toEqual(['a', 'b', 'c', 'd']);
    expect(ceiling.running).toBe(0);
    expect(ceiling.queued).toBe(0);
  });

  it('a limit of one runs one at a time: a box set to 1 never has a light and a heavy run together', async () => {
    const ceiling = new ExtractCeiling(1);
    let atOnce = 0;
    let most = 0;
    const one = () =>
      ceiling.run(async () => {
        most = Math.max(most, ++atOnce);
        await tick();
        atOnce--;
      });
    await Promise.all([one(), one(), one(), one()]);
    expect(most).toBe(1);
  });

  it('a failed run gives its place back', async () => {
    const ceiling = new ExtractCeiling(1);
    await expect(
      ceiling.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(ceiling.running).toBe(0);
    await expect(ceiling.run(async () => 'next')).resolves.toBe('next');
  });

  it('a newcomer does not pass the waiting when a place frees', async () => {
    const ceiling = new ExtractCeiling(1);
    const order: string[] = [];
    const first = gate();
    const a = ceiling.run(async () => {
      await first.done;
      order.push('a');
    });
    const b = ceiling.run(async () => {
      order.push('b');
    });
    await tick();
    first.open();
    // `c` arrives in the same turn the place frees: it still runs after `b`.
    const c = ceiling.run(async () => {
      order.push('c');
    });
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('the limit is live: a higher one wakes the waiting, a lower one lets the runs in flight finish', async () => {
    const ceiling = new ExtractCeiling(1);
    const started: string[] = [];
    const gates = { a: gate(), b: gate(), c: gate() };
    const runs = (['a', 'b', 'c'] as const).map((name) =>
      ceiling.run(async () => {
        started.push(name);
        await gates[name].done;
      }),
    );
    await tick();
    expect(started).toEqual(['a']);

    ceiling.setLimit(2);
    await tick();
    expect(started).toEqual(['a', 'b']);

    ceiling.setLimit(1);
    gates.a.open();
    await tick();
    // Two were in flight under the old limit; one ended, one still runs, so
    // `c` waits for the new limit of one.
    expect(started).toEqual(['a', 'b']);
    gates.b.open();
    await tick();
    expect(started).toEqual(['a', 'b', 'c']);
    gates.c.open();
    await Promise.all(runs);
  });

  it('a limit below one is taken as one, so a bad setting cannot stop the queue', async () => {
    const ceiling = new ExtractCeiling(3);
    ceiling.setLimit(0);
    await expect(ceiling.run(async () => 'ran')).resolves.toBe('ran');
  });
});
