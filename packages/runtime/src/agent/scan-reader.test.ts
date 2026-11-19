/**
 * runScanReader: the brain's `scan_reader` worker, one call a page, its
 * quality from the answer and Tesseract's words. A made-up worker and
 * adapter; no provider, no database.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  plan: [] as ('fail' | 'refused' | 'server' | 'read' | 'cut')[],
  calls: 0,
  seen: [] as Array<Record<string, unknown>>,
  kinds: [] as string[],
  route: 'ok' as 'ok' | 'none' | 'no_key' | 'unusable' | 'unreadable_key',
  params: {} as Record<string, unknown>,
}));

const PAGE = Array.from(
  { length: 30 },
  (_, i) => `FLANGE WN | 2-${i + 4} | SCH 80 | ASTM A105 | RF | ${100 + i}-15`,
).join('\n');

const extract = async (_bytes: Buffer, opts: Record<string, unknown>) => {
  h.calls += 1;
  h.seen.push(opts);
  const next = h.plan.shift() ?? 'fail';
  if (next === 'fail') throw new Error('timeout');
  if (next === 'refused') throw Object.assign(new Error('failed: 429'), { status: 429 });
  if (next === 'server') throw Object.assign(new Error('failed: 503'), { status: 503 });
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
      model: 'made-up-ocr',
      params: h.params,
    };
    if (h.route === 'ok') return { ok: true, worker, credential: { apiKey: 'k' } };
    if (h.route === 'none') return { ok: false, why: 'none', worker: null };
    return { ok: false, why: h.route, worker };
  }),
}));
vi.mock('@mantle/voice', () => ({
  getVisionAdapter: () => ({ adapterName: 'made-up', extract }),
}));

import {
  runScanReader,
  SCAN_READER_MAX_TOKENS,
  SCAN_READER_PROMPT,
  SCAN_READER_SYSTEM_TEXT,
} from './scan-reader';

const png = Buffer.from('made-up page picture');
const read = (more: Partial<Parameters<typeof runScanReader>[0]> = {}) =>
  runScanReader({ ownerId: 'o-1', bytes: png, mimeType: 'image/png', ...more });

describe('runScanReader', () => {
  beforeEach(() => {
    h.plan = [];
    h.calls = 0;
    h.seen = [];
    h.kinds = [];
    h.route = 'ok';
    h.params = {};
  });

  it('reads with the scan_reader worker only, its own prompt, least thinking', async () => {
    h.plan = ['read'];
    const out = await read();
    expect(h.kinds).toEqual(['scan_reader']);
    expect(h.calls).toBe(1);
    expect(h.seen[0]).toMatchObject({
      prompt: SCAN_READER_PROMPT,
      systemPrompt: SCAN_READER_SYSTEM_TEXT,
      model: 'made-up-ocr',
      maxTokens: SCAN_READER_MAX_TOKENS,
      leastThinking: true,
      mimeType: 'image/png',
      apiKey: 'k',
    });
    expect(out).toMatchObject({
      ran: true,
      text: PAGE,
      model: 'made-up-ocr',
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
    expect(h.seen[0]!.maxTokens).toBe(3000);
  });

  it('no Scan reader worker: nothing is called, model null (the caller keeps its old path)', async () => {
    h.route = 'none';
    const out = await read();
    expect(h.calls).toBe(0);
    expect(out).toMatchObject({ ran: false, model: null, quality: { ok: false } });
  });

  it('a worker with no key, a provider with no picture reader, a bad key: nothing is called', async () => {
    for (const why of ['no_key', 'unusable', 'unreadable_key'] as const) {
      h.route = why;
      const out = await read();
      expect(out.ran).toBe(false);
      expect(out.note).toBeTruthy();
    }
    expect(h.calls).toBe(0);
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
    expect(out).toMatchObject({ ran: false, model: 'made-up-ocr' });
    expect(h.calls).toBe(1);
  });

  it('with no tries, one call only', async () => {
    const out = await read();
    expect(h.calls).toBe(1);
    expect(out.ran).toBe(false);
    expect(out.note).toMatch(/^Scan reader failed/);
  });

  it('a picture that is no PNG, JPEG or WebP, or empty, is not sent', async () => {
    expect((await read({ mimeType: 'image/heic' })).ran).toBe(false);
    expect((await read({ bytes: Buffer.alloc(0) })).ran).toBe(false);
    expect(h.calls).toBe(0);
    expect(h.kinds).toEqual([]);
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
