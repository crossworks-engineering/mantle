/**
 * The answer cache at the worker gateway (@mantle/db answer-cache.ts;
 * docs/provider-http.md, "Kept answers"), on a real, migrated Postgres, with
 * a made-up worker and adapter (no provider):
 *  - a kept answer is taken with no paid call; outside the cache's scope
 *    nothing is kept or taken;
 *  - a person's read again takes only answers kept after it, and its own
 *    try again then takes the answer it paid for;
 *  - a scanned figure page across tries pays its Scan reader read once and
 *    its vision call once, and waits in turn (the Scan reader's, then the
 *    vision call's) never pay twice.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/runtime/src/agent/answer-cache.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** The made-up provider: the answers of each page's Scan reader read and
 *  of the vision call, in turn (`wait`: its "not now"). */
const h = vi.hoisted(() => ({
  scan: new Map<string, ('read' | 'figure' | 'wait')[]>(),
  vision: [] as ('read' | 'wait')[],
  scanCalls: [] as string[],
  visionCalls: 0,
}));

const ROWS = Array.from({ length: 12 }, (_, i) => `ROW ${i} | VALVE | 2-${i} | ASTM A105`).join(
  '\n',
);

vi.mock('@mantle/db', async (orig) => ({
  ...(await orig<typeof import('@mantle/db')>()),
  bumpWorkerUsage: vi.fn(async () => {}),
}));
vi.mock('@mantle/api-keys', () => ({
  getApiKeyById: vi.fn(),
  resolveDefaultWorker: vi.fn(async (_owner: string, kind: string) => ({
    ok: true,
    worker: {
      id: 'w-1',
      slug: kind,
      provider: 'made-up',
      model: `made-up-${kind}`,
      params: {},
    },
    credential: { apiKey: 'k' },
  })),
}));
vi.mock('@mantle/voice', () => ({
  DEFAULT_VISION_DESCRIBE_PROMPT: 'describe',
  getVisionAdapter: () => ({
    adapterName: 'made-up',
    parsePdf: async (bytes: Buffer) => {
      const page = bytes.toString();
      h.scanCalls.push(page);
      const next = h.scan.get(page)?.shift() ?? 'read';
      if (next === 'wait') throw Object.assign(new Error('failed: 429'), { status: 429 });
      return {
        text: next === 'figure' ? 'FIG 1\n![img-0.jpeg](img-0.jpeg)' : `${ROWS}\n${page}`,
        model: 'm',
        tokensIn: 1300,
        tokensOut: 16,
        reportedCostUsd: 0.002,
      };
    },
    extract: async () => {
      h.visionCalls += 1;
      const next = h.vision.shift() ?? 'read';
      if (next === 'wait') throw Object.assign(new Error('vision failed: 503'), { status: 503 });
      return { text: 'A pump curve, flow against head.', tokensIn: 900, tokensOut: 20 };
    },
  }),
}));
vi.mock('@mantle/files', async (orig) => ({
  ...(await orig<typeof import('@mantle/files')>()),
  transcodeImageForVision: async (bytes: Buffer, mimeType: string) => ({ bytes, mimeType }),
}));

describe.skipIf(!URL)('the answer cache at the worker gateway', () => {
  let m: typeof import('@mantle/db');
  let cache: typeof import('@mantle/db/answer-cache');
  let reader: typeof import('./scan-reader');
  let attachments: typeof import('./attachments');
  let scan: typeof import('./scan-pdf');
  type Admin = Parameters<(typeof import('@mantle/db'))['ensureViewerRoles']>[0];
  let admin: Admin;
  let since0 = new Date();
  /** A file of its own each test: its pages are keys of their own. */
  let sha = '';

  const asSystem = <T>(fn: () => Promise<T>) => m.runAsSystem('test:answer-cache', fn);
  const dbNow = async () => new Date((await admin<{ t: string }[]>`select now()::text as t`)[0]!.t);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    cache = await import('@mantle/db/answer-cache');
    reader = await import('./scan-reader');
    attachments = await import('./attachments');
    scan = await import('./scan-pdf');
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    since0 = await dbNow();
  }, 60_000);

  afterAll(async () => {
    if (admin)
      await admin`delete from ai_answer_cache where created_at >= ${since0.toISOString()}::timestamptz`;
    await m?.closeDb();
  });

  beforeEach(() => {
    h.scan.clear();
    h.vision = [];
    h.scanCalls = [];
    h.visionCalls = 0;
    sha = randomUUID().replace(/-/g, '').padEnd(64, '0');
  });

  const readPage = (input: string) =>
    reader.runScanReader({ ownerId: 'o-1', pdf: Buffer.from('page 1'), input });

  it('a kept answer is taken with no paid call; outside the scope nothing is kept or taken', async () => {
    const input = `${sha}#page-1`;
    const first = await asSystem(() => cache.withAnswerCache(() => readPage(input)));
    const again = await asSystem(() => cache.withAnswerCache(() => readPage(input)));
    expect(h.scanCalls).toEqual(['page 1']);
    expect(again).toEqual(first);
    expect(again.costUsd).toBe(0.002);
    // A vision answer too, by its prompt and its bytes.
    const ask = () =>
      attachments.runVisionWorker({
        ownerId: 'o-1',
        bytes: Buffer.from(sha),
        mimeType: 'image/png',
        prompt: 'what is it?',
      });
    const v1 = await asSystem(() => cache.withAnswerCache(ask));
    const v2 = await asSystem(() => cache.withAnswerCache(ask));
    expect(h.visionCalls).toBe(1);
    expect(v2).toEqual(v1);
    // Another prompt is another ask.
    await asSystem(() =>
      cache.withAnswerCache(() =>
        attachments.runVisionWorker({
          ownerId: 'o-1',
          bytes: Buffer.from(sha),
          mimeType: 'image/png',
          prompt: 'how many?',
        }),
      ),
    );
    expect(h.visionCalls).toBe(2);
    // No scope (a chat turn): paid each time, nothing kept.
    const fresh = `${sha}#page-9`;
    await asSystem(() => readPage(fresh));
    await asSystem(() => readPage(fresh));
    expect(h.scanCalls).toEqual(['page 1', 'page 1', 'page 1']);
    const key = cache.answerKey('scan_reader', [
      'made-up',
      'made-up-scan_reader',
      'mistral-ocr',
      fresh,
    ]);
    expect(await admin`select 1 from ai_answer_cache where key = ${key}`).toHaveLength(0);
  });

  it("a person's read again takes only answers kept after it; its own try again takes what it paid for", async () => {
    const input = `${sha}#page-1`;
    await asSystem(() => cache.withAnswerCache(() => readPage(input)));
    expect(h.scanCalls).toHaveLength(1);
    // The stamp file_reindex writes, read back as the extractor reads it.
    const { sql } = await import('drizzle-orm');
    const [row] = (await asSystem(() =>
      m.db.execute(sql`select ${cache.readAgainStampSql()} as data`),
    )) as unknown as { data: Record<string, unknown> }[];
    const since = cache.readAgainOf(row!.data);
    expect(since).not.toBeNull();
    expect(Math.abs(since!.getTime() - (await dbNow()).getTime())).toBeLessThan(5_000);
    // The read again pays once, then its try again pays nothing.
    await asSystem(() => cache.withAnswerCache(() => readPage(input), since));
    expect(h.scanCalls).toHaveLength(2);
    await asSystem(() => cache.withAnswerCache(() => readPage(input), since));
    expect(h.scanCalls).toHaveLength(2);
    expect(cache.readAgainOf({})).toBeNull();
    expect(cache.readAgainOf({ read_again: 'x' })).toBeNull();
  });

  /** A scanned PDF of `total` pages, each a scanned page, read with the
   *  gateway's own calls (the parser stood in for). */
  const readScan = (total: number) => {
    const deps: Partial<import('./scan-pdf').ScanPdfDeps> = {
      windows: async function* () {
        yield { part: { bytes: Buffer.from('w'), pageFrom: 1, pageTo: total, pagesTotal: total } };
      } as import('./scan-pdf').ScanPdfDeps['windows'],
      marks: async (part) => {
        const out = new Map<number, import('./scan-pdf').PageMark>();
        for (let n = part.pageFrom; n <= part.pageTo; n += 1) {
          out.set(n, { page: n, method: 'vision', why: 'scan', lines: 12, text: '' });
        }
        return out;
      },
      cut: async (_part, page) => Buffer.from(`page ${page}`),
      draw: async () => ({ bytes: Buffer.from('png'), mimeType: 'image/png' }),
      check: (async () => null) as import('./scan-pdf').ScanPdfDeps['check'],
    };
    return asSystem(() =>
      cache.withAnswerCache(() =>
        scan.readScannedPdf({
          ownerId: 'o-1',
          bytes: Buffer.from('%PDF'),
          sha256: sha,
          filename: 'scan.pdf',
          waitPauses: [],
          deps,
        }),
      ),
    );
  };

  it('a figure page across tries pays its Scan reader read once and its vision call once', async () => {
    h.scan.set('page 1', ['figure']);
    h.vision = ['wait'];
    const first = await readScan(2);
    expect(first.wait?.reason).toBe('overloaded');
    expect(first.pages[0]).toMatchObject({ page: 1, method: 'unread', why: 'failed' });
    const again = await readScan(2);
    expect(again.wait).toBeUndefined();
    expect(again.pages[0]).toMatchObject({ page: 1, method: 'vision' });
    expect(again.pages[1]).toMatchObject({ page: 2, method: 'scan_reader' });
    // One Scan reader read a page, in all; the vision call: one refused (no
    // bill), one paid.
    expect(h.scanCalls.sort()).toEqual(['page 1', 'page 2']);
    expect(h.visionCalls).toBe(2);
  });

  it('waits in turn never pay twice: the Scan reader waits, then the vision call, then all is read', async () => {
    h.scan.set('page 1', ['figure']);
    h.scan.set('page 2', ['wait']);
    h.vision = ['wait', 'wait'];
    const tries = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await readScan(2);
      tries.push(r.wait?.reason ?? null);
      if (!r.wait) {
        expect(r.pages.map((p) => p.method)).toEqual(['vision', 'scan_reader']);
        break;
      }
    }
    expect(tries.at(-1)).toBeNull();
    // Each page's Scan reader read paid once (page 2's refused call billed
    // nothing); the figure's vision call paid once.
    const paidScans = h.scanCalls.filter((p) => p === 'page 1');
    expect(paidScans).toHaveLength(1);
    expect(h.scanCalls.filter((p) => p === 'page 2')).toHaveLength(2);
    expect(h.visionCalls).toBe(3);
  });
});
