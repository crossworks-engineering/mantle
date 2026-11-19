/**
 * runScanReader: the brain's `scan_reader` worker, one call a page, by a PDF
 * parser engine (the shipped worker) or by an image model; its quality from
 * the answer and the free reads. A made-up worker and adapter; no provider,
 * no database.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Step = 'fail' | 'refused' | 'server' | 'read' | 'cut';

const h = vi.hoisted(() => ({
  plan: [] as Step[],
  calls: 0,
  seen: [] as Array<{ how: 'picture' | 'pdf'; bytes: Buffer; opts: Record<string, unknown> }>,
  kinds: [] as string[],
  route: 'ok' as 'ok' | 'none' | 'no_key' | 'unusable' | 'unreadable_key',
  params: {} as Record<string, unknown>,
  noParser: false,
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

const answer = (how: 'picture' | 'pdf') => async (bytes: Buffer, opts: Record<string, unknown>) => {
  h.calls += 1;
  h.seen.push({ how, bytes, opts });
  const next = h.plan.shift() ?? 'fail';
  if (next === 'fail') throw new Error('timeout');
  if (next === 'refused') throw Object.assign(new Error('failed: 429'), { status: 429 });
  if (next === 'server') throw Object.assign(new Error('failed: 503'), { status: 503 });
  if (how === 'pdf') {
    // The 16-token answer of the text model is cut on purpose: `length`.
    return {
      text: PARSED,
      model: 'm',
      finishReason: 'length',
      tokensIn: 1300,
      tokensOut: 16,
      reportedCostUsd: 0.00203,
    };
  }
  if (next === 'cut') return { text: PAGE, model: 'm', finishReason: 'length', tokensOut: 8000 };
  return { text: `  ${PAGE}\n`, model: 'm', finishReason: 'stop', tokensIn: 1200, tokensOut: 900 };
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
  getVisionAdapter: () => ({
    adapterName: 'made-up',
    extract: answer('picture'),
    ...(h.noParser ? {} : { parsePdf: answer('pdf') }),
  }),
}));

import {
  cleanParsedText,
  runScanReader,
  SCAN_READER_ENGINE_MAX_TOKENS,
  SCAN_READER_MAX_TOKENS,
  SCAN_READER_PROMPT,
  SCAN_READER_SYSTEM_TEXT,
} from './scan-reader';

const png = Buffer.from('made-up page picture');
const pdf = Buffer.from('%PDF-1.4 made-up one-page pdf');
const picture = { bytes: png, mimeType: 'image/png' };
const read = (more: Partial<Parameters<typeof runScanReader>[0]> = {}) =>
  runScanReader({ ownerId: 'o-1', pdf, picture, ...more });

beforeEach(() => {
  h.plan = [];
  h.calls = 0;
  h.seen = [];
  h.kinds = [];
  h.route = 'ok';
  h.params = {};
  h.noParser = false;
});

describe('runScanReader with a PDF parser engine (the shipped worker)', () => {
  beforeEach(() => {
    h.params = { engine: 'mistral-ocr' };
  });

  it('sends the one-page PDF through the engine, and the text is the cleaned parse', async () => {
    h.plan = ['read'];
    const out = await read({ expectedLines: 31 });
    expect(h.kinds).toEqual(['scan_reader']);
    expect(h.calls).toBe(1);
    expect(h.seen[0]!.how).toBe('pdf');
    expect(h.seen[0]!.bytes).toBe(pdf);
    expect(h.seen[0]!.opts).toMatchObject({
      engine: 'mistral-ocr',
      model: 'made-up-model',
      maxTokens: SCAN_READER_ENGINE_MAX_TOKENS,
      apiKey: 'k',
    });
    expect(out).toMatchObject({
      ran: true,
      engine: 'mistral-ocr',
      model: 'made-up-model',
      costUsd: 0.00203,
      text: ['SP-00-00 MADE-UP SPEC BOOK PAGE 7', '', PAGE].join('\n'),
    });
    // The text model's 16-token cut is not a cut page.
    expect(out.quality).toMatchObject({ ok: true, reasons: [] });
  });

  it('with no PDF given, nothing is sent (the picture is not the engine read)', async () => {
    const out = await read({ pdf: undefined });
    expect(h.calls).toBe(0);
    expect(out.ran).toBe(false);
  });

  it('a provider with no PDF parser engine: nothing is sent', async () => {
    h.noParser = true;
    const out = await read();
    expect(h.calls).toBe(0);
    expect(out).toMatchObject({ ran: false, model: 'made-up-model' });
  });

  it('a made-up page no free read vouches for is a bad read', async () => {
    h.plan = ['read'];
    const out = await read({ ocrWords: [], expectedLines: 12 });
    expect(out.quality.reasons).toEqual(['unverified']);
  });
});

describe('runScanReader with an image model (a worker with no engine)', () => {
  it('reads the picture with its own prompt, least thinking', async () => {
    h.plan = ['read'];
    const out = await read();
    expect(h.calls).toBe(1);
    expect(h.seen[0]!.how).toBe('picture');
    expect(h.seen[0]!.opts).toMatchObject({
      prompt: SCAN_READER_PROMPT,
      systemPrompt: SCAN_READER_SYSTEM_TEXT,
      model: 'made-up-model',
      maxTokens: SCAN_READER_MAX_TOKENS,
      leastThinking: true,
      mimeType: 'image/png',
      apiKey: 'k',
    });
    expect(out).toMatchObject({
      ran: true,
      text: PAGE,
      model: 'made-up-model',
      finishReason: 'stop',
      tokensIn: 1200,
      tokensOut: 900,
      quality: { ok: true, reasons: [] },
    });
  });

  it('the worker param max_tokens sets the cap', async () => {
    h.plan = ['read'];
    h.params = { max_tokens: 3000 };
    await read();
    expect(h.seen[0]!.opts.maxTokens).toBe(3000);
  });

  it('an answer cut at the cap is a bad read, with no second call', async () => {
    h.plan = ['cut', 'read'];
    const out = await read({ tries: 2 });
    expect(h.calls).toBe(1);
    expect(out.quality).toMatchObject({ ok: false, reasons: ['cut'] });
  });

  it('a read that disagrees with Tesseract is a bad read, with no second call', async () => {
    h.plan = ['read', 'read'];
    const ocrWords = Array.from({ length: 40 }, () => ({ text: 'GASKET', conf: 97 }));
    const out = await read({ ocrWords, tries: 2 });
    expect(h.calls).toBe(1);
    expect(out.quality.reasons).toEqual(['disagrees']);
  });

  it('a picture that is no PNG, JPEG or WebP, or no picture, is not sent', async () => {
    expect((await read({ picture: { bytes: png, mimeType: 'image/heic' } })).ran).toBe(false);
    expect((await read({ picture: undefined })).ran).toBe(false);
    expect(h.calls).toBe(0);
  });
});

describe('runScanReader, both ways', () => {
  it('no Scan reader worker: nothing is called, model null (the caller keeps its old path)', async () => {
    h.route = 'none';
    const out = await read();
    expect(h.calls).toBe(0);
    expect(out).toMatchObject({ ran: false, model: null, quality: { ok: false } });
  });

  it('a worker with no key, a provider with no reader, a bad key: nothing is called', async () => {
    for (const why of ['no_key', 'unusable', 'unreadable_key'] as const) {
      h.route = why;
      const out = await read();
      expect(out.ran).toBe(false);
      expect(out.note).toBeTruthy();
    }
    expect(h.calls).toBe(0);
  });

  it('with tries 2 a failed provider is asked one time more; a refusal is not', async () => {
    h.params = { engine: 'mistral-ocr' };
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
    expect(out).toMatchObject({ ran: false, model: 'made-up-model' });
    expect(h.calls).toBe(1);
  });

  it('with no tries, one call only', async () => {
    const out = await read();
    expect(h.calls).toBe(1);
    expect(out.ran).toBe(false);
    expect(out.note).toMatch(/^Scan reader failed/);
  });

  it('nothing to read: no worker is even looked up', async () => {
    expect((await read({ pdf: Buffer.alloc(0), picture: undefined })).ran).toBe(false);
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
      'Note: a | in prose stays.',
      '</file>',
      '',
    ].join('\n');
    expect(cleanParsedText(md)).toBe(
      ['TITLE', 'A | B', '1 | 2', '', 'Note: a | in prose stays.'].join('\n'),
    );
  });

  it('keeps every word of a plain page', () => {
    expect(cleanParsedText('PAGE 7\nSome words here.\n')).toBe('PAGE 7\nSome words here.');
    expect(cleanParsedText('')).toBe('');
  });
});

describe('the bench harness asks as the worker does', () => {
  it('scripts/scan-reader/harness.py holds the same prompt', () => {
    const py = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'scripts', 'scan-reader', 'harness.py'),
      'utf8',
    );
    const block = /^SYSTEM = \(\n([\s\S]*?)\n\)$/m.exec(py)?.[1] ?? '';
    const system = [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => m[1]!.replace(/\\"/g, '"'))
      .join('');
    expect(system).toBe(SCAN_READER_SYSTEM_TEXT);
    expect(/^PROMPT = "(.*)"$/m.exec(py)?.[1]).toBe(SCAN_READER_PROMPT);
  });
});
