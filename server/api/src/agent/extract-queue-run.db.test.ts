/**
 * A run on demand on a real pg-boss (extract-queue.ts, enqueuePipelineRun),
 * the extractor and the job stubbed:
 *  - a `pipeline_run` notify gives one job; a second notify for the same
 *    file and pipeline while the first waits gives no second job, and the
 *    job runs once, as a run (never as an extract);
 *  - a run and an extract of one file are two jobs (their keys differ);
 *  - a reader's run of a drawing goes on to the heavy lane with its `run`
 *    kept; an `after` run of a drawing stays on the main queue;
 *  - a run is stored with retry limit 0, on the main queue and after the
 *    heavy hop; an extract keeps the queue's 5;
 *  - a run's wait whose stop left a paid read unkept is a paid wait: past
 *    PAID_WAIT_RESENDS_MAX of them, a run that got no work done fails to
 *    the dead letters on its next wait, paid or not, and sends no new job.
 * The notify is the real one (notifyPipelineRun), read on a LISTEN of the
 * test with the runtime's own parse (pipelineRunOfPayload).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/api/src/agent/extract-queue-run.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PAID_WAIT_RESENDS_MAX } from '@mantle/std';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const runs = vi.hoisted(() => ({
  extracts: [] as string[],
  jobs: [] as string[],
  release: new Map<string, () => void>(),
  held: new Set<string>(),
  /** The waits each try of a run meets, in turn (`paid`: its stop left a
   *  paid read unkept). */
  waits: new Map<string, { paid?: true }[]>(),
}));
vi.mock('./extractor.js', () => ({
  extractNode: vi.fn(async (nodeId: string) => {
    if (runs.held.has(nodeId)) {
      await new Promise<void>((resolve) => runs.release.set(nodeId, resolve));
    }
    runs.extracts.push(nodeId);
  }),
}));
vi.mock('./extract/pipeline-run.js', () => ({
  isAfterRun: (_ownerId: string, id: string) => Promise.resolve(id === 'site-tags'),
  runPipelineJob: vi.fn(async (_owner: string, nodeId: string, pipelineId: string) => {
    runs.jobs.push(`${pipelineId}:${nodeId}`);
    const wait = runs.waits.get(`${pipelineId}:${nodeId}`)?.shift();
    if (wait) {
      return {
        status: 'asked',
        rows: 0,
        made: 0,
        reused: 0,
        warnings: [],
        stopped: 'provider_rate_limit',
        wait: { for: 'provider', reason: 'rate_limit', ...wait },
      };
    }
    return { status: 'built', tabs: 1, rows: 1 };
  }),
}));
vi.mock('./extract/model.js', () => ({ probeExtractionModel: vi.fn(async () => {}) }));

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out: ${what}`);
}

describe.skipIf(!URL)('the extract queue: a run on demand', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let su: ReturnType<Ts['superuserClient']>;
  let m: typeof import('@mantle/db');
  let q: typeof import('./extract-queue');
  let owner = '';
  let unlisten: (() => Promise<void>) | null = null;

  const file = async (name: string): Promise<string> => {
    const id = randomUUID();
    await su`insert into nodes (id, owner_id, type, title, path, data)
      values (${id}, ${owner}, 'file', ${name}, 'files', ${JSON.stringify({ filename: name })}::jsonb)`;
    return id;
  };
  const jobs = (nodeId: string) =>
    su<{ name: string; state: string; run: string | null; key: string; retries: number }[]>`
      select name, state, data->>'run' as run, singleton_key as key, retry_limit as retries
      from pgboss.job
      where data->>'nodeId' = ${nodeId} and name like 'mantle.extract%' order by created_on`;

  beforeAll(async () => {
    const ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    // One main worker: a held extract keeps a run waiting.
    process.env.EXTRACT_CONCURRENCY = '1';
    su = ts.superuserClient(scratch.url);
    owner = await ts.ensureTestAnchor(su);
    m = await import('@mantle/db');
    q = await import('./extract-queue');
    await m.runAsSystem('test:extract-queue-run', () => q.startExtractQueue(scratch!.url, owner));
    const sub = await su.listen(m.PIPELINE_RUN_CHANNEL, (payload) => {
      const run = m.pipelineRunOfPayload(payload);
      if (run)
        void m.runAsSystem('test:listen', () => q.enqueuePipelineRun(run.nodeId, run.pipelineId));
    });
    unlisten = () => sub.unlisten();
  }, 180_000);

  afterAll(async () => {
    for (const release of runs.release.values()) release();
    await unlisten?.();
    await q?.stopExtractQueue();
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
  }, 60_000);

  it('a notify gives one job, and a second notify while it waits gives none', async () => {
    const busy = await file('minutes.docx');
    runs.held.add(busy);
    await m.runAsSystem('test', () => q.enqueueExtract(busy));
    await until('the main worker is held', () => runs.release.has(busy));

    const dxf = await file('P-102.dxf');
    await m.runAsSystem('test', () => m.notifyPipelineRun(dxf, 'site-tags'));
    await until('the job is queued', async () => (await jobs(dxf)).length === 1);
    await m.runAsSystem('test', () => m.notifyPipelineRun(dxf, 'site-tags'));
    // The same file and another pipeline: its own job.
    await m.runAsSystem('test', () => m.notifyPipelineRun(dxf, 'drawing-cad'));
    await until('the second pipeline is queued', async () => (await jobs(dxf)).length === 2);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect((await jobs(dxf)).map((j) => [j.state, j.run, j.key])).toEqual([
      ['created', 'site-tags', `site-tags:${dxf}`],
      ['created', 'drawing-cad', `drawing-cad:${dxf}`],
    ]);
    // An extract of the same file waits beside the runs.
    await m.runAsSystem('test', () => q.enqueueExtract(dxf));
    await until('the extract is queued', async () => (await jobs(dxf)).length === 3);

    runs.release.get(busy)!();
    await until('all three ran', () => runs.jobs.length === 2 && runs.extracts.includes(dxf));
    expect(runs.jobs.filter((j) => j === `site-tags:${dxf}`)).toHaveLength(1);
    expect(runs.extracts.filter((id) => id === dxf)).toHaveLength(1);
    // A run is tried once; an extract keeps the queue's retry limit. The
    // reader's run and the extract of the drawing hop to the heavy lane.
    expect((await jobs(dxf)).map((j) => [j.name, j.run, j.retries])).toEqual([
      ['mantle.extract', 'site-tags', 0],
      ['mantle.extract', 'drawing-cad', 0],
      ['mantle.extract', null, 5],
      ['mantle.extract.heavy', 'drawing-cad', 0],
      ['mantle.extract.heavy', null, 5],
    ]);
    expect((await jobs(busy)).map((j) => j.retries)).toEqual([5]);
  }, 90_000);

  it("a reader's run of a drawing takes the heavy lane with its run; an after run stays", async () => {
    const dwg = await file('P-103.dwg');
    await m.runAsSystem('test', () => q.enqueuePipelineRun(dwg, 'drawing-cad'));
    await until('the reader ran', () => runs.jobs.includes(`drawing-cad:${dwg}`));
    await until('its jobs are done', async () =>
      (await jobs(dwg)).every((j) => j.state === 'completed'),
    );
    expect((await jobs(dwg)).map((j) => [j.name, j.run, j.key, j.retries])).toEqual([
      ['mantle.extract', 'drawing-cad', `drawing-cad:${dwg}`, 0],
      ['mantle.extract.heavy', 'drawing-cad', `drawing-cad:${dwg}`, 0],
    ]);

    const dwg2 = await file('P-104.dwg');
    await m.runAsSystem('test', () => q.enqueuePipelineRun(dwg2, 'site-tags'));
    await until('the patch ran', () => runs.jobs.includes(`site-tags:${dwg2}`));
    await until('its job is done', async () =>
      (await jobs(dwg2)).every((j) => j.state === 'completed'),
    );
    expect((await jobs(dwg2)).map((j) => j.name)).toEqual(['mantle.extract']);
    expect(runs.extracts).not.toContain(dwg);
    expect(runs.extracts).not.toContain(dwg2);
  }, 90_000);
  it('past the bound of paid waits, a run that got no work done fails on its next wait: no new job', async () => {
    const pdf = await file('book-figures.pdf');
    const key = `pdf-page-read:${pdf}`;
    runs.waits.set(key, [
      ...Array.from({ length: PAID_WAIT_RESENDS_MAX }, () => ({ paid: true as const })),
      {},
    ]);
    const main = () =>
      su<{ state: string; paid: number | null }[]>`
        select state, (data->'wait'->>'paid')::int as paid from pgboss.job
        where data->>'nodeId' = ${pdf} and name = 'mantle.extract' order by created_on`;
    await m.runAsSystem('test', () => q.enqueuePipelineRun(pdf, 'pdf-page-read'));
    for (let sent = 1; sent <= PAID_WAIT_RESENDS_MAX; sent += 1) {
      await until(`wait ${sent} is sent`, async () => (await main()).length === sent + 1);
      // Due now, not after the wait's gap.
      await su`update pgboss.job set start_after = now()
        where data->>'nodeId' = ${pdf} and state = 'created'`;
    }
    await until(
      'the try past the bound ran',
      () => runs.jobs.filter((j) => j === key).length === PAID_WAIT_RESENDS_MAX + 1,
    );
    await until('it ended', async () => (await main()).at(-1)!.state !== 'active');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const all = await main();
    expect(all.map((j) => j.paid)).toEqual([
      null,
      ...Array.from({ length: PAID_WAIT_RESENDS_MAX }, (_, i) => i + 1),
    ]);
    // A run has no retry: it fails, to the dead letters.
    expect(all.map((j) => j.state)).toEqual([
      ...Array.from({ length: PAID_WAIT_RESENDS_MAX }, () => 'completed'),
      'failed',
    ]);
  }, 90_000);
});
