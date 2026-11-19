/**
 * runScanReader: the brain's `scan_reader` worker reads a one-page PDF
 * through the fixed engine (mistral-ocr), one call a page, its quality from
 * the answer and the page's line count. A made-up worker and adapter; no
 * provider, no database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Step = 'fail' | 'refused' | 'server' | 'read' | 'figure';

const h = vi.hoisted(() => ({
  plan: [] as Step[],
  calls: 0,
  seen: [] as Array<{ bytes: Buffer; opts: Record<string, unknown> }>,
  kinds: [] as string[],
  route: 'ok' as 'ok' | 'none' | 'no_key' | 'unusable' | 'unreadable_key',
  params: {} as Record<string, unknown>,
}));

const PAGE = Array.from(
  { length: 30 },
  (_, i) => `FLANGE WN | 2-${i + 4} | SCH 80 | ASTM A105 | RF | ${100 + i}-15`,
).join('\n');

/** The page as mistral-ocr's markdown comes back in the file annotation. */
const PARSED = [
  '<file name="page.pdf">',
  '# SP-00-00 MADE-UP SPEC BOOK PAGE 7',
  '',
  '',
  ...PAGE.split('\n').flatMap((r, i) =>
    i === 0 ? [`|  ${r}  |`, '| --- | --- | --- | --- | --- | --- |'] : [`|  ${r}  |`],
  ),
  '</file>',
].join('\n');

const parsePdf = async (bytes: Buffer, opts: Record<string, unknown>) => {
  h.calls += 1;
  h.seen.push({ bytes, opts });
  const next = h.plan.shift() ?? 'fail';
  if (next === 'fail') throw new Error('timeout');
  if (next === 'refused') throw Object.assign(new Error('failed: 429'), { status: 429 });
  if (next === 'server') throw Object.assign(new Error('failed: 503'), { status: 503 });
  const text =
    next === 'figure'
      ? '<file name="page.pdf">\nFIG 1\n![img-0.jpeg](img-0.jpeg)\n</file>'
      : PARSED;
  // The 16-token answer of the text model is cut on purpose: `length`.
  return {
    text,
    model: 'm',
    finishReason: 'length',
    tokensIn: 1300,
    tokensOut: 16,
    reportedCostUsd: 0.00203,
  };
};

vi.mock('@mantle/db', () => ({ bumpWorkerUsage: vi.fn() }));
vi.mock('@mantle/std', async (orig) => ({
  ...(await orig<typeof import('@mantle/std')>()),
  publicProviderErrorMessage: () => 'The provider does not answer in time.',
}));
vi.mock('@mantle/api-keys', () => ({
  resolveDefaultWorker: vi.fn(async (_owner: string, kind: string) => {
    h.kinds.push(kind);
    const worker = {
      id: 'w-1',
      slug: 'scan-reader',
      provider: 'made-up',
      model: 'made-up-model',
      params: h.params,
    };
    if (h.route === 'ok') return { ok: true, worker, credential: { apiKey: 'k' } };
    if (h.route === 'none') return { ok: false, why: 'none', worker: null };
    return { ok: false, why: h.route, worker };
  }),
}));
vi.mock('@mantle/voice', () => ({
  getVisionAdapter: () => ({ adapterName: 'made-up', extract: vi.fn(), parsePdf }),
}));

import {
  cleanParsedText,
  parsedPictureCount,
  runScanReader,
  SCAN_READER_ENGINE,
  SCAN_READER_ENGINE_MAX_TOKENS,
} from './scan-reader';

const pdf = Buffer.from('%PDF-1.4 made-up one-page pdf');
const read = (more: Partial<Parameters<typeof runScanReader>[0]> = {}) =>
  runScanReader({ ownerId: 'o-1', pdf, ...more });

beforeEach(() => {
  h.plan = [];
  h.calls = 0;
  h.seen = [];
  h.kinds = [];
  h.route = 'ok';
  h.params = {};
});

describe('runScanReader', () => {
  it('sends the one-page PDF through mistral-ocr, whatever the worker says; the text is the cleaned parse', async () => {
    h.plan = ['read'];
    h.params = { engine: 'something-else' };
    const out = await read({ expectedLines: 31 });
    expect(SCAN_READER_ENGINE).toBe('mistral-ocr');
    expect(h.kinds).toEqual(['scan_reader']);
    expect(h.calls).toBe(1);
    expect(h.seen[0]!.bytes).toBe(pdf);
    expect(h.seen[0]!.opts).toMatchObject({
      engine: 'mistral-ocr',
      model: 'made-up-model',
      maxTokens: SCAN_READER_ENGINE_MAX_TOKENS,
      apiKey: 'k',
    });
    expect(out).toMatchObject({
      ran: true,
      attempted: true,
      engine: 'mistral-ocr',
      model: 'made-up-model',
      costUsd: 0.00203,
      pictures: 0,
      text: ['SP-00-00 MADE-UP SPEC BOOK PAGE 7', '', PAGE].join('\n'),
    });
    // The text model's 16-token cut is not a cut page.
    expect(out.quality).toMatchObject({ ok: true, reasons: [] });
  });

  it('counts the figures the engine found', async () => {
    h.plan = ['figure'];
    expect(await read({ expectedLines: 2 })).toMatchObject({ text: 'FIG 1', pictures: 1 });
  });

  it('no Scan reader worker: nothing is called, model null, not attempted', async () => {
    h.route = 'none';
    const out = await read();
    expect(h.calls).toBe(0);
    expect(out).toMatchObject({
      ran: false,
      attempted: false,
      model: null,
      quality: { ok: false },
    });
  });

  it('a worker with no key, a provider with no engine, a bad key: nothing is called', async () => {
    for (const why of ['no_key', 'unusable', 'unreadable_key'] as const) {
      h.route = why;
      const out = await read();
      expect(out).toMatchObject({ ran: false, attempted: false });
      expect(out.note).toBeTruthy();
    }
    expect(h.calls).toBe(0);
  });

  it('with tries 2 a failed provider is asked one time more; a refusal is not', async () => {
    h.plan = ['fail', 'read'];
    expect((await read({ tries: 2 })).ran).toBe(true);
    expect(h.calls).toBe(2);
    h.calls = 0;
    h.plan = ['server', 'read'];
    expect((await read({ tries: 2 })).ran).toBe(true);
    expect(h.calls).toBe(2);
    h.calls = 0;
    h.plan = ['refused', 'read'];
    const out = await read({ tries: 2 });
    expect(out).toMatchObject({ ran: false, attempted: true, model: 'made-up-model' });
    expect(h.calls).toBe(1);
  });

  it('with no tries, one call only; a failure is attempted', async () => {
    const out = await read();
    expect(h.calls).toBe(1);
    expect(out).toMatchObject({ ran: false, attempted: true });
    expect(out.note).toMatch(/^Scan reader failed/);
  });

  it('no PDF: no worker is even looked up', async () => {
    expect((await read({ pdf: Buffer.alloc(0) })).ran).toBe(false);
    expect(h.kinds).toEqual([]);
  });
});

describe('cleanParsedText', () => {
  it('drops the wrapper, dividers and picture links; a table row loses its outer bars', () => {
    const md = [
      '<file name="page.pdf">',
      '## TITLE',
      '![img-0.jpeg](img-0.jpeg)',
      '|  A | B  |',
      '| :--- | ---: |',
      '| 1 |  2 |',
      '',
      '',
      '',
      'See ![img-1.jpeg](img-1.jpeg) above. Note: a | in prose stays.',
      '</file>',
      '',
    ].join('\n');
    expect(cleanParsedText(md)).toBe(
      ['TITLE', 'A | B', '1 | 2', '', 'See  above. Note: a | in prose stays.'].join('\n'),
    );
    expect(parsedPictureCount(md)).toBe(2);
  });

  it('keeps every word of a plain page', () => {
    expect(cleanParsedText('PAGE 7\nSome words here.\n')).toBe('PAGE 7\nSome words here.');
    expect(cleanParsedText('')).toBe('');
  });

  it('takes off paired bold marks only: a footnote mark or a form blank is printed text', () => {
    expect(cleanParsedText('**NOTE** see 150** and __A__ and ______ and TAG__01')).toBe(
      'NOTE see 150** and A and ______ and TAG__01',
    );
  });
});
