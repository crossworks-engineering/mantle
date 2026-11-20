/**
 * The extract queue's three lanes on a real pg-boss (extract-queue.ts,
 * extract-lanes.ts), the extractor itself stubbed:
 *  - a drawing sent to `mantle.extract` is sent on to `mantle.extract.heavy`
 *    and extracted there, once; the main queue's job is completed with the
 *    output `{ lane: 'heavy' }`, which the queue counts leave out of "done";
 *  - a document is extracted on the main queue and never reaches the heavy
 *    one;
 *  - heavy files run one at a time, and a document sent after a batch of
 *    drawings does not wait for them;
 *  - the ceiling is in the path: on a box set to one extraction at a time, a
 *    document waits for the drawing that runs, and runs when it ends;
 *  - a book (a PDF of 10 MB or more) hops to `mantle.extract.book` and holds
 *    no place of the light and heavy ceiling: while it runs, a drawing and a
 *    document both run and end, on a box set to one extraction at a time;
 *  - a wait is only a wait: a read the provider holds many times in a row
 *    is sent again as a wait each time (nothing counted), never into the
 *    retries or the dead letters, and ends once the provider answers.
 *  - but a try whose paid answer could not be kept sends no wait: it takes
 *    pg-boss's bounded retries, so a broken cache never loops paid tries.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/api/src/agent/extract-queue.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** The stubbed extractor: it records each run, and a run of a node in
 *  `held` waits until the test lets it go. */
const runs = vi.hoisted(() => ({
  started: [] as string[],
  ended: [] as string[],
  heavyAtOnce: 0,
  heavyMost: 0,
  heavy: new Set<string>(),
  release: new Map<string, () => void>(),
  held: new Set<string>(),
  /** How many tries of a node meet the provider's "not now", in turn. */
  waits: new Map<string, number>(),
  /** Nodes whose try pays for an answer the cache cannot keep, then waits. */
  keepFails: new Set<string>(),
}));
vi.mock('./extractor.js', async () => {
  const { ProviderWaitError } = await import('@mantle/std');
  return {
    extractNode: vi.fn(async (nodeId: string) => {
      runs.started.push(nodeId);
      if (runs.keepFails.has(nodeId)) {
        // A paid answer the table refuses (its key check), then the
        // provider's "not now" to the next call.
        const { keepAnswer } = await import('@mantle/db/answer-cache');
        await keepAnswer('vision', 'not-a-key', { text: 'paid' });
        throw new ProviderWaitError({ reason: 'rate_limit' }, 'vision');
      }
      const left = runs.waits.get(nodeId) ?? 0;
      if (left > 0) {
        runs.waits.set(nodeId, left - 1);
        throw new ProviderWaitError({ reason: 'rate_limit' }, 'scan_reader');
      }
      const isHeavy = runs.heavy.has(nodeId);
      if (isHeavy) runs.heavyMost = Math.max(runs.heavyMost, ++runs.heavyAtOnce);
      if (runs.held.has(nodeId)) {
        await new Promise<void>((resolve) => runs.release.set(nodeId, resolve));
      }
      if (isHeavy) runs.heavyAtOnce--;
      runs.ended.push(nodeId);
    }),
  };
});
// No provider is asked: the circuit's probes are not part of this test.
vi.mock('./extract/model.js', () => ({ probeExtractionModel: vi.fn(async () => {}) }));

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out: ${what}`);
}

describe.skipIf(!URL)('the extract queue: a heavy lane for drawings', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let su: ReturnType<Ts['superuserClient']>;
  let m: typeof import('@mantle/db');
  let q: typeof import('./extract-queue');
  let owner = '';

  const file = async (name: string): Promise<string> => {
    const id = randomUUID();
    await su`insert into nodes (id, owner_id, type, title, path, data)
      values (${id}, ${owner}, 'file', ${name}, 'files', ${JSON.stringify({ filename: name })}::jsonb)`;
    return id;
  };
  const pdfOf = async (name: string, sizeBytes: number): Promise<string> => {
    const id = randomUUID();
    // Built in SQL: a JSON text bound as a parameter lands as one jsonb
    // string, with no keys to read.
    await su`insert into nodes (id, owner_id, type, title, path, data)
      values (${id}, ${owner}, 'file', ${name}, 'files',
              jsonb_build_object('filename', ${name}::text, 'size_bytes', ${sizeBytes}::bigint))`;
    return id;
  };
  const jobs = (nodeId: string) =>
    su<{ name: string; state: string; lane: string | null }[]>`
      select name, state, output->>'lane' as lane from pgboss.job
      where data->>'nodeId' = ${nodeId} order by created_on`;

  beforeAll(async () => {
    const ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    // Two main workers, as a box has by default.
    process.env.EXTRACT_CONCURRENCY = '2';
    su = ts.superuserClient(scratch.url);
    owner = await ts.ensureTestAnchor(su);
    m = await import('@mantle/db');
    q = await import('./extract-queue');
    await m.runAsSystem('test:extract-queue', () => q.startExtractQueue(scratch!.url, owner));
  }, 180_000);

  afterAll(async () => {
    for (const release of runs.release.values()) release();
    await q?.stopExtractQueue();
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
  }, 60_000);

  it('a drawing hops to the heavy lane and is extracted there once; a document stays on the main queue', async () => {
    const dwg = await file('P-101.dwg');
    const pdf = await file('report.pdf');
    runs.heavy.add(dwg);
    await q.enqueueExtract(dwg);
    await q.enqueueExtract(pdf);
    await until('both extracted', () => runs.ended.includes(dwg) && runs.ended.includes(pdf));
    await until('the jobs are completed', async () =>
      [...(await jobs(dwg)), ...(await jobs(pdf))].every((j) => j.state === 'completed'),
    );

    expect(runs.started.filter((id) => id === dwg)).toHaveLength(1);
    expect(runs.started.filter((id) => id === pdf)).toHaveLength(1);
    expect(await jobs(dwg)).toEqual([
      { name: 'mantle.extract', state: 'completed', lane: 'heavy' },
      { name: 'mantle.extract.heavy', state: 'completed', lane: null },
    ]);
    expect(await jobs(pdf)).toEqual([{ name: 'mantle.extract', state: 'completed', lane: null }]);
  }, 90_000);

  it('heavy files run one at a time, and a document does not wait behind them', async () => {
    const drawings = await Promise.all(['a.dwg', 'b.dgn', 'c.dxf', 'd.dwf'].map(file));
    for (const id of drawings) {
      runs.heavy.add(id);
      runs.held.add(id);
    }
    for (const id of drawings) await q.enqueueExtract(id);
    await until('the first drawing runs', () => drawings.some((id) => runs.started.includes(id)));

    // Every drawing is queued or running, and a document sent now is done
    // while the first drawing still holds the lane.
    const doc = await file('minutes.docx');
    await q.enqueueExtract(doc);
    await until('the document is extracted', () => runs.ended.includes(doc));
    expect(drawings.filter((id) => runs.started.includes(id))).toHaveLength(1);
    expect(drawings.filter((id) => runs.ended.includes(id))).toHaveLength(0);

    // Let them go, one after the other: never two at once.
    for (let i = 0; i < drawings.length; i++) {
      await until(`drawing ${i + 1} holds the lane`, () => runs.release.size > 0);
      const [id, release] = [...runs.release.entries()][0]!;
      runs.release.delete(id);
      release();
      await until(`drawing ${i + 1} ends`, () => runs.ended.includes(id));
    }
    expect(drawings.every((id) => runs.ended.includes(id))).toBe(true);
    expect(runs.heavyMost).toBe(1);
  }, 120_000);

  it('a box set to one extraction at a time: a document waits for the drawing that runs', async () => {
    // The queue again, as a box with the setting at 1 starts it.
    await q.stopExtractQueue();
    process.env.EXTRACT_CONCURRENCY = '1';
    await m.runAsSystem('test:extract-queue', () => q.startExtractQueue(scratch!.url, owner));

    const dwg = await file('one-at-a-time.dwg');
    runs.heavy.add(dwg);
    runs.held.add(dwg);
    await q.enqueueExtract(dwg);
    await until('the drawing holds the only place', () => runs.release.has(dwg));

    const doc = await file('waits.docx');
    await q.enqueueExtract(doc);
    // The main worker has taken the document's job (it is active) and waits
    // for a place: the extractor has not been called for it.
    await until('the document job is active', async () =>
      (await jobs(doc)).some((j) => j.name === 'mantle.extract' && j.state === 'active'),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(runs.started).not.toContain(doc);

    runs.release.get(dwg)!();
    runs.release.delete(dwg);
    await until('the document runs once the drawing ends', () => runs.ended.includes(doc));
    expect(runs.ended.indexOf(dwg)).toBeLessThan(runs.started.lastIndexOf(doc));
  }, 120_000);

  it('a book takes its own lane, and a drawing and a document run while it holds it', async () => {
    // The box is still set to one extraction at a time (the test above).
    const book = await pdfOf('manual.pdf', 20 * 1024 * 1024);
    runs.held.add(book);
    await q.enqueueExtract(book);
    await until('the book holds its lane', () => runs.release.has(book));
    expect((await jobs(book)).map((j) => [j.name, j.lane])).toEqual([
      ['mantle.extract', 'book'],
      ['mantle.extract.book', null],
    ]);

    // A drawing in the heavy lane and a document on the main queue: both
    // run and end while the book still runs.
    const dwg = await file('beside-the-book.dwg');
    const doc = await file('beside-the-book.docx');
    runs.heavy.add(dwg);
    await q.enqueueExtract(dwg);
    await q.enqueueExtract(doc);
    await until('the drawing and the document end', () =>
      [dwg, doc].every((id) => runs.ended.includes(id)),
    );
    expect(runs.ended).not.toContain(book);
    expect((await jobs(dwg)).map((j) => j.name)).toEqual([
      'mantle.extract',
      'mantle.extract.heavy',
    ]);

    // A second book waits for the first: one book at a time by default.
    const book2 = await pdfOf('second.pdf', 30 * 1024 * 1024);
    runs.held.add(book2);
    await q.enqueueExtract(book2);
    await until('the second book is in the book lane', async () =>
      (await jobs(book2)).some((j) => j.name === 'mantle.extract.book'),
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(runs.started).not.toContain(book2);

    runs.release.get(book)!();
    runs.release.delete(book);
    await until('the second book runs once the first ends', () => runs.release.has(book2));
    runs.release.get(book2)!();
    runs.release.delete(book2);
    await until('the second book ends', () => runs.ended.includes(book2));
    // The hop of a book is not a finished extraction.
    const counts = await m.extractionQueueCounts();
    expect(counts.running + counts.waiting).toBe(0);
  }, 120_000);
  it('a wait never dead-letters: eight waits in turn are each sent again as a wait, and the read ends', async () => {
    const pdf = await file('scan-held-long.pdf');
    const WAITS = 8;
    runs.waits.set(pdf, WAITS);
    const main = () =>
      su<{ state: string; waits: number | null; keys: string[] | null }[]>`
        select state, (data->'wait'->>'waits')::int as waits,
               (select array_agg(k order by k) from jsonb_object_keys(data->'wait') k) as keys
        from pgboss.job
        where data->>'nodeId' = ${pdf} and name = 'mantle.extract' order by created_on`;
    await q.enqueueExtract(pdf);
    for (let sent = 1; sent <= WAITS; sent += 1) {
      await until(`wait ${sent} is sent`, async () => (await main()).length === sent + 1);
      // Due now, not after the wait's gap.
      await su`update pgboss.job set start_after = now()
        where data->>'nodeId' = ${pdf} and state = 'created'`;
    }
    await until('the read ended', () => runs.ended.includes(pdf));
    await until('its job is done', async () => (await main()).at(-1)!.state === 'completed');
    const all = await main();
    // Each wait a new job with its wait alone on it (no count), every one
    // completed: none in the retries, none in the dead letters.
    expect(all.map((j) => j.waits)).toEqual([null, ...Array.from({ length: WAITS }, (_, i) => i)]);
    for (const j of all.slice(1)) expect(j.keys).toEqual(['for', 'reason', 'until', 'waits']);
    expect(all.every((j) => j.state === 'completed')).toBe(true);
    const dead = await su<{ n: number }[]>`select count(*)::int as n from pgboss.job
      where data->>'nodeId' = ${pdf} and name = 'mantle.extract.dead'`;
    expect(dead[0]!.n).toBe(0);
    expect(runs.started.filter((id) => id === pdf)).toHaveLength(WAITS + 1);
  }, 120_000);

  it('a try whose paid answer was not kept sends no wait: it takes the retries', async () => {
    const pdf = await file('scan-unkept.pdf');
    runs.keepFails.add(pdf);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await q.enqueueExtract(pdf);
      await until('the try is in the retries', async () =>
        (await jobs(pdf)).some((j) => j.state === 'retry'),
      );
      // One job, in its retries: no new job sent as a wait.
      expect(await jobs(pdf)).toEqual([{ name: 'mantle.extract', state: 'retry', lane: null }]);
      expect(error.mock.calls.some((c) => String(c[0]).includes('[answer-cache]'))).toBe(true);
      // Its retry, with the cache keeping again, reads the file.
      runs.keepFails.delete(pdf);
      await su`update pgboss.job set start_after = now()
        where data->>'nodeId' = ${pdf} and state = 'retry'`;
      await until('the read ended', () => runs.ended.includes(pdf));
      await until('its job is done', async () =>
        (await jobs(pdf)).every((j) => j.state === 'completed'),
      );
      expect(await jobs(pdf)).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  }, 90_000);
});
