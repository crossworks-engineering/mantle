/**
 * The page ask of the router's page types (./pdf-kind.ts decidePdfPageKind;
 * plan page c607711a, M3 in shadow). decide() and the box's decider worker
 * are stood in; resolveUse is the real one.
 *
 * - The Q5 guard (Jason, 2026-11-21: in shadow, page pictures leave only dev
 *   and the bench): a box with `pdf_kind` on but no `uses.pdf_kind.pages:
 *   true` (the operator's key, never shipped), as every client box, asks
 *   nothing and sends no picture. Since M4 there is no model pin: the key
 *   with the use on is the gate, whatever the decider's model.
 * - pdfPageUseOf: the model, whether page routing is live (`mode: 'live'`),
 *   and the floor.
 * - The floor is on the summed chance of the route, not on one option's.
 * - The state is the bench's: its 8 fields in its order, the picture as an
 *   image_url part.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DECISION_PICTURE_LIMITS } from '@mantle/client-types/decision-models';
import { PDF_PAGE_PICTURE } from '@mantle/files/pdf-page-kinds';

const h = vi.hoisted(() => ({
  calls: [] as Array<Record<string, any>>,
  outcome: null as null | Record<string, any>,
  worker: null as null | { model: string; params: Record<string, unknown> },
}));

vi.mock('./decide', async (orig) => {
  const real = await orig<typeof import('./decide')>();
  return {
    ...real,
    resolveDecider: vi.fn(async () =>
      h.worker ? { worker: { id: 'w', model: h.worker.model }, params: h.worker.params } : null,
    ),
    decide: vi.fn(async (input: Record<string, any>) => {
      h.calls.push(input);
      return h.outcome;
    }),
  };
});

const { USE_TIMEOUT_FLOOR_MS } = await import('./decide');
const { PDF_PAGE_INSTRUCTIONS, decidePdfPageKind, pageRouteOf, pdfPageAsksOn, pdfPageUseOf } =
  await import('./pdf-kind');

/** The model the M2 bench measured (no pin in the code since M4). */
const PDF_PAGE_MODEL = 'typesafe/jev-1.14';

/** A JPEG header of `w` x `h` (enough for sniffImage). */
function jpeg(w: number, hgt: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    hgt >> 8,
    hgt & 0xff,
    w >> 8,
    w & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0xff,
    0xd9,
  ]);
}

const ASK = {
  page: 7,
  size: 'a4',
  class: 'scan_hidden_text',
  instrument_tags: 0,
  line_numbers: 0,
  tag_like_tokens: 3,
  text_sample: 'SPECIFICATION GENERAL',
};
const PICTURE = jpeg(724, 1024);
const ON = { uses: { pdf_kind: { enabled: true, mode: 'shadow', pages: true } } };

const outcome = (choice: string, probabilities: Record<string, number>, mode = 'shadow') => ({
  answers: { kind: { type: 'choice', choice, confidence: 0.3, probabilities } },
  mode,
  use: { enabled: true, mode, threshold: undefined, deferBelow: 0.6, actAloneAt: 0.9 },
  model: PDF_PAGE_MODEL,
  cached: false,
  ms: 300,
});

beforeEach(() => {
  h.calls.length = 0;
  h.outcome = null;
  h.worker = null;
});

describe('the Q5 guard: where a page picture may go', () => {
  it('a client box with jev-1.14 but no `pages` key asks nothing (the manifest never ships it)', async () => {
    h.worker = {
      model: PDF_PAGE_MODEL,
      params: { uses: { pdf_kind: { enabled: true, mode: 'shadow' } } },
    };
    h.outcome = outcome('table', { table: 0.9 });
    expect(await pdfPageAsksOn('o')).toBe(false);
    expect(await decidePdfPageKind('o', ASK, PICTURE)).toBeNull();
    h.worker = {
      model: PDF_PAGE_MODEL,
      params: { uses: { pdf_kind: { enabled: true, pages: 'yes' } } },
    };
    expect(await pdfPageAsksOn('o')).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it('no decider, or pdf_kind off, asks nothing either', async () => {
    expect(await decidePdfPageKind('o', ASK, PICTURE)).toBeNull();
    h.worker = {
      model: PDF_PAGE_MODEL,
      params: { uses: { pdf_kind: { enabled: false, pages: true } } },
    };
    expect(await decidePdfPageKind('o', ASK, PICTURE)).toBeNull();
    h.worker = { model: PDF_PAGE_MODEL, params: {} };
    expect(await decidePdfPageKind('o', ASK, PICTURE)).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  it('any decider model with pdf_kind on and `pages: true` asks, one call a page (no pin, M4)', async () => {
    for (const model of [PDF_PAGE_MODEL, '~typesafe/jev-latest']) {
      h.calls.length = 0;
      h.worker = { model, params: ON };
      h.outcome = outcome('table', { table: 0.5, datasheet: 0.4, pid: 0.1 });
      expect(await pdfPageAsksOn('o')).toBe(true);
      expect(await decidePdfPageKind('o', ASK, PICTURE)).not.toBeNull();
      expect(h.calls).toHaveLength(1);
    }
  });
});

describe('pdfPageUseOf: the model, live, the floor', () => {
  it('null where page asks are off', async () => {
    expect(await pdfPageUseOf('o')).toBeNull();
    h.worker = {
      model: PDF_PAGE_MODEL,
      params: { uses: { pdf_kind: { enabled: true, mode: 'live' } } },
    };
    expect(await pdfPageUseOf('o')).toBeNull();
    h.worker = {
      model: PDF_PAGE_MODEL,
      params: { uses: { pdf_kind: { enabled: false, mode: 'live', pages: true } } },
    };
    expect(await pdfPageUseOf('o')).toBeNull();
  });

  it("shadow by default, live only with the mode live; the floor is the use's", async () => {
    h.worker = { model: '~typesafe/jev-latest', params: ON };
    expect(await pdfPageUseOf('o')).toEqual({
      model: '~typesafe/jev-latest',
      live: false,
      floor: 0.6,
    });
    h.worker = {
      model: PDF_PAGE_MODEL,
      params: {
        uses: { pdf_kind: { enabled: true, mode: 'live', pages: true, min_confidence: 0.7 } },
      },
    };
    expect(await pdfPageUseOf('o')).toEqual({ model: PDF_PAGE_MODEL, live: true, floor: 0.7 });
  });
});

describe('the page ask', () => {
  it('sends the bench state: the 8 fields in order, the picture as an image_url part', async () => {
    h.worker = { model: PDF_PAGE_MODEL, params: ON };
    h.outcome = outcome('document', { document: 0.95 });
    await decidePdfPageKind('o', ASK, PICTURE);
    const call = h.calls[0]!;
    expect(call.use).toBe('pdf_kind');
    expect(Object.keys(call.state)).toEqual([
      'page',
      'picture',
      'size',
      'class',
      'instrument_tags',
      'line_numbers',
      'tag_like_tokens',
      'text_sample',
    ]);
    expect(call.state.picture.type).toBe('image_url');
    expect(call.state.picture.image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(call.questions.kind.instructions).toBe(PDF_PAGE_INSTRUCTIONS);
    expect(call.questions.kind.instructions).toContain('this page');
  });

  it('the floor is on the summed chance of the route (the bench), not on one option', async () => {
    h.worker = { model: PDF_PAGE_MODEL, params: ON };
    // Table 0.45 and datasheet 0.45: each under 0.6, the office route 0.9.
    h.outcome = outcome('table', { table: 0.45, datasheet: 0.45, pid: 0.1 });
    expect(await decidePdfPageKind('o', ASK, PICTURE)).toMatchObject({
      kind: 'table',
      confidence: 0.9,
      sure: true,
      mode: 'shadow',
    });
    // Spread over both routes: the office route has 0.55, under the floor.
    h.outcome = outcome('document', { document: 0.3, table: 0.25, pid: 0.25, pfd: 0.2 });
    expect(await decidePdfPageKind('o', ASK, PICTURE)).toMatchObject({
      kind: 'document',
      confidence: 0.55,
      sure: false,
    });
  });

  it('the kind kept names the route its sum is of', () => {
    // The top option is a drawing, the office route is likelier.
    expect(pageRouteOf('pid', 0.2, { pid: 0.4, document: 0.35, table: 0.25 })).toEqual({
      kind: 'document',
      confidence: 0.6,
    });
    // A tie goes to office.
    expect(pageRouteOf('pid', 0.2, { pid: 0.5, table: 0.5 })).toMatchObject({ kind: 'table' });
    // No chances: the choice alone.
    expect(pageRouteOf('isometric', 0.8, {})).toEqual({ kind: 'isometric', confidence: 0.8 });
    expect(pageRouteOf('toString', 0.8, {})).toBeNull();
  });

  it('a picture call has the timeout floor of a picture (5 s)', () => {
    expect(USE_TIMEOUT_FLOOR_MS.pdf_kind).toBe(5_000);
  });

  it('the picture bounds of the step are the decider limits', () => {
    expect(PDF_PAGE_PICTURE.minSide).toBe(DECISION_PICTURE_LIMITS.minSide);
    expect(PDF_PAGE_PICTURE.minPixels).toBe(DECISION_PICTURE_LIMITS.minPixels);
    expect(PDF_PAGE_PICTURE.maxSide).toBeLessThanOrEqual(DECISION_PICTURE_LIMITS.maxSide);
  });
});
