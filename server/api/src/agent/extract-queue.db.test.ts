/**
 * The extract queue's two lanes on a real pg-boss (extract-queue.ts,
 * extract-lanes.ts), the extractor itself stubbed:
 *  - a drawing sent to `mantle.extract` is sent on to `mantle.extract.heavy`
 *    and extracted there, once; the main queue's job is completed with the
 *    output `{ lane: 'heavy' }`, which the queue counts leave out of "done";
 *  - a document is extracted on the main queue and never reaches the heavy
 *    one;
 *  - heavy files run one at a time, and a document sent after a batch of
 *    drawings does not wait for them;
 *  - the ceiling is in the path: on a box set to one extraction at a time, a
 *    document waits for the drawing that runs, and runs when it ends.
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
}));
vi.mock('./extractor.js', () => ({
  extractNode: vi.fn(async (nodeId: string) => {
    runs.started.push(nodeId);
    const isHeavy = runs.heavy.has(nodeId);
    if (isHeavy) runs.heavyMost = Math.max(runs.heavyMost, ++runs.heavyAtOnce);
    if (runs.held.has(nodeId)) {
      await new Promise<void>((resolve) => runs.release.set(nodeId, resolve));
    }
    if (isHeavy) runs.heavyAtOnce--;
    runs.ended.push(nodeId);
  }),
}));
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
});
