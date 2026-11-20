/**
 * The answer cache at the worker gateway (@mantle/db answer-cache.ts;
 * docs/provider-http.md, "Kept answers"), on a real, migrated Postgres, with
 * a made-up worker and adapter (no provider):
 *  - a kept answer is taken with no paid call; outside the cache's scope
 *    nothing is kept or taken;
 *  - only an answer the caller accepts is kept (any text by default);
 *  - a kept string is well-formed (no NUL, no lone surrogate); each keep
 *    that fails is logged and marks the scope (answerKeepFailed);
 *  - the cache is per node: another node with the same bytes pays once for
 *    its own, a scope with no node uses no cache, and deleting the file
 *    removes its kept answers (the cascade of 0392);
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
  /** The vision call's answer text (null: the pump curve). */
  visionText: null as string | null,
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
      return {
        text: h.visionText ?? 'A pump curve, flow against head.',
        tokensIn: 900,
        tokensOut: 20,
      };
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
  /** The node of the file each test (the cache is per node). */
  let node = '';
  let owner = '';
  const newNode = async (): Promise<string> => {
    const id = randomUUID();
    const name = `answer-cache-${id}.pdf`;
    await admin`insert into nodes (id, owner_id, type, title, path, data)
      values (${id}, ${owner}, 'file', ${name}, 'files', jsonb_build_object('filename', ${name}::text))`;
    return id;
  };

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
    owner = await (await import('@mantle/db/test-support')).ensureTestAnchor(admin);
    since0 = await dbNow();
  }, 60_000);

  afterAll(async () => {
    if (admin) {
      await admin`delete from ai_answer_cache where created_at >= ${since0.toISOString()}::timestamptz`;
      await admin`delete from nodes where owner_id = ${owner}::uuid
        and title like 'answer-cache-%.pdf'`;
    }
    await m?.closeDb();
  });

  beforeEach(async () => {
    h.scan.clear();
    h.vision = [];
    h.scanCalls = [];
    h.visionCalls = 0;
    h.visionText = null;
    sha = randomUUID().replace(/-/g, '').padEnd(64, '0');
    node = await newNode();
  });

  const readPage = (input: string) =>
    reader.runScanReader({ ownerId: 'o-1', pdf: Buffer.from('page 1'), input });

  it('a kept answer is taken with no paid call; outside the scope nothing is kept or taken', async () => {
    const input = `${sha}#page-1`;
    const first = await asSystem(() => cache.withAnswerCache(() => readPage(input), null, node));
    const again = await asSystem(() => cache.withAnswerCache(() => readPage(input), null, node));
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
    const v1 = await asSystem(() => cache.withAnswerCache(ask, null, node));
    const v2 = await asSystem(() => cache.withAnswerCache(ask, null, node));
    expect(h.visionCalls).toBe(1);
    expect(v2).toEqual(v1);
    // Another prompt is another ask.
    await asSystem(() =>
      cache.withAnswerCache(
        () =>
          attachments.runVisionWorker({
            ownerId: 'o-1',
            bytes: Buffer.from(sha),
            mimeType: 'image/png',
            prompt: 'how many?',
          }),
        null,
        node,
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
    await asSystem(() => cache.withAnswerCache(() => readPage(input), null, node));
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
    await asSystem(() => cache.withAnswerCache(() => readPage(input), since, node));
    expect(h.scanCalls).toHaveLength(2);
    await asSystem(() => cache.withAnswerCache(() => readPage(input), since, node));
    expect(h.scanCalls).toHaveLength(2);
    expect(cache.readAgainOf({})).toBeNull();
    expect(cache.readAgainOf({ read_again: 'x' })).toBeNull();
  });

  it('per node: a try again of the node pays once, another node with the same bytes pays once, no node no cache', async () => {
    const input = `${sha}#page-1`;
    await asSystem(() => cache.withAnswerCache(() => readPage(input), null, node));
    await asSystem(() => cache.withAnswerCache(() => readPage(input), null, node));
    expect(h.scanCalls).toHaveLength(1);
    const other = await newNode();
    await asSystem(() => cache.withAnswerCache(() => readPage(input), null, other));
    await asSystem(() => cache.withAnswerCache(() => readPage(input), null, other));
    expect(h.scanCalls).toHaveLength(2);
    // A scope with no node: paid each time, nothing kept.
    await asSystem(() => cache.withAnswerCache(() => readPage(`${sha}#page-2`), null, null));
    await asSystem(() => cache.withAnswerCache(() => readPage(`${sha}#page-2`), null, null));
    expect(h.scanCalls).toHaveLength(4);
    const rows = await admin<{ node_id: string }[]>`select node_id::text from ai_answer_cache
      where node_id in (${node}::uuid, ${other}::uuid) order by created_at`;
    expect(rows.map((r) => r.node_id)).toEqual([node, other]);
  });

  it('only an answer the caller accepts is kept: an empty one and a refused one are asked again', async () => {
    const ask = (prompt: string, accept?: (text: string) => boolean) => () =>
      attachments.runVisionWorker({
        ownerId: 'o-1',
        bytes: Buffer.from(sha),
        mimeType: 'image/png',
        prompt,
        ...(accept ? { accept } : {}),
      });
    // No text (the default): not kept, so a try again asks again.
    h.visionText = '';
    await asSystem(() => cache.withAnswerCache(ask('empty?'), null, node));
    await asSystem(() => cache.withAnswerCache(ask('empty?'), null, node));
    expect(h.visionCalls).toBe(2);
    // Text the caller cannot use (no JSON): not kept either.
    h.visionText = 'I cannot read this sheet.';
    const json = (text: string) => text.startsWith('{');
    await asSystem(() => cache.withAnswerCache(ask('json?', json), null, node));
    await asSystem(() => cache.withAnswerCache(ask('json?', json), null, node));
    expect(h.visionCalls).toBe(4);
    // An answer it accepts: kept, paid once.
    h.visionText = '{"Line number":"6-P-101"}';
    await asSystem(() => cache.withAnswerCache(ask('json?', json), null, node));
    await asSystem(() => cache.withAnswerCache(ask('json?', json), null, node));
    expect(h.visionCalls).toBe(5);
  });

  it('a string with a lone surrogate or a NUL is kept well-formed, and taken', async () => {
    const key = cache.answerKey('vision', [sha, 'surrogate']);
    const text = `cut in a pair \ud83d, a NUL ${String.fromCharCode(0)}here, a pair \ud83d\ude00`;
    const got = await asSystem(() =>
      cache.withAnswerCache(
        async () => {
          await cache.keepAnswer('vision', key, { text });
          return { kept: await cache.keptAnswer<{ text: string }>(key) };
        },
        null,
        node,
      ),
    );
    expect(got.kept?.text).toBe('cut in a pair \ufffd, a NUL here, a pair \ud83d\ude00');
  });

  it('each failed keep is logged, and marks its scope and the scope it runs in', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const got = await asSystem(() =>
        cache.withAnswerCache(
          async () => {
            const before = cache.answerKeepFailed();
            // The extractor's own scope inside the queue's: a key the table
            // refuses (its check), twice.
            const inner = await cache.withAnswerCache(
              async () => {
                await cache.keepAnswer('vision', 'not-a-key', { text: 'paid' });
                await cache.keepAnswer('vision', 'not-a-key', { text: 'paid' });
                return cache.answerKeepFailed();
              },
              null,
              node,
            );
            return { before, inner, outer: cache.answerKeepFailed() };
          },
          null,
          node,
        ),
      );
      expect(got).toEqual({ before: false, inner: true, outer: true });
      const logged = error.mock.calls.filter((c) => String(c[0]).includes('[answer-cache]'));
      expect(logged).toHaveLength(2);
      // A new scope (the job's try again) starts unmarked.
      expect(
        await asSystem(() =>
          cache.withAnswerCache(async () => cache.answerKeepFailed(), null, node),
        ),
      ).toBe(false);
    } finally {
      error.mockRestore();
    }
  });

  it('deleting the file removes its kept answers, and only its own', async () => {
    const input = `${sha}#page-1`;
    const other = await newNode();
    await asSystem(() => cache.withAnswerCache(() => readPage(input), null, node));
    await asSystem(() => cache.withAnswerCache(() => readPage(input), null, other));
    const kept = (id: string) =>
      admin<
        { n: number }[]
      >`select count(*)::int as n from ai_answer_cache where node_id = ${id}::uuid`;
    expect((await kept(node))[0]!.n).toBe(1);
    await admin`delete from nodes where id = ${node}::uuid`;
    expect((await kept(node))[0]!.n).toBe(0);
    expect((await kept(other))[0]!.n).toBe(1);
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
      cache.withAnswerCache(
        () =>
          scan.readScannedPdf({
            ownerId: 'o-1',
            bytes: Buffer.from('%PDF'),
            sha256: sha,
            filename: 'scan.pdf',
            waitPauses: [],
            deps,
          }),
        null,
        node,
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
