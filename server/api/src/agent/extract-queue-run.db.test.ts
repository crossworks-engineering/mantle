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
 *  - a run's wait is only a wait: a run held many times in a row with no
 *    work done is sent again each time (nothing counted), never failed to
 *    the dead letters, and ends once the provider answers;
 *  - a run whose paid answer was not kept fails once on its wait (it has no
 *    retry): no new job, and a person runs it again;
 *  - a book's read (the book lane) is one trace: a `pipeline_run` with
 *    source and lane 'book', the extract runs in it, and a trace opened
 *    inside carries the lane too; a run on demand in the book lane is told
 *    its lane;
 *  - a run that says `extractAgain` (an Agent's new page text on a file
 *    too short to extract) sends the file's extract once more.
 * The notify is the real one (notifyPipelineRun), read on a LISTEN of the
 * test with the runtime's own parse (pipelineRunOfPayload).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/api/src/agent/extract-queue-run.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const runs = vi.hoisted(() => ({
  extracts: [] as string[],
  jobs: [] as string[],
  release: new Map<string, () => void>(),
  held: new Set<string>(),
  /** How many tries of a run meet the provider's "not now", in turn. */
  waits: new Map<string, number>(),
  /** Runs whose paid answer the cache cannot keep, then held. */
  keepFails: new Set<string>(),
  /** The trace each extract ran in, and the trace it opened inside. */
  traceOf: new Map<string, { outer: string | null; inner: string | null }>(),
  /** The lane each run on demand was told. */
  laneOf: new Map<string, string | undefined>(),
  /** Whether each run on demand was told the page mark (Q2). */
  pagesOf: [] as [string, boolean][],
  /** Runs that say `extractAgain`. */
  again: new Set<string>(),
}));
vi.mock('./extractor.js', () => ({
  extractNode: vi.fn(async (nodeId: string, ownerId: string) => {
    if (runs.held.has(nodeId)) {
      await new Promise<void>((resolve) => runs.release.set(nodeId, resolve));
    }
    // As the extractor opens its extractor_run trace: inside whatever is open.
    const { currentTrace, startTrace } = await import('@mantle/tracing');
    const outer = currentTrace()?.id ?? null;
    const inner = await startTrace(
      { kind: 'extractor_run', ownerId, subjectId: nodeId, subjectKind: 'node', data: {} },
      async () => currentTrace()?.id ?? null,
    );
    runs.traceOf.set(nodeId, { outer, inner });
    runs.extracts.push(nodeId);
  }),
}));
vi.mock('./extract/pipeline-run.js', () => ({
  isAfterRun: (_ownerId: string, id: string) => Promise.resolve(id === 'site-tags'),
  runPipelineJob: vi.fn(
    async (_owner: string, nodeId: string, pipelineId: string, lane?: string, pages = false) => {
      runs.jobs.push(`${pipelineId}:${nodeId}`);
      const key = `${pipelineId}:${nodeId}`;
      runs.laneOf.set(key, lane);
      runs.pagesOf.push([key, pages]);
      const left = runs.waits.get(key) ?? 0;
      if (runs.keepFails.has(key)) {
        // A paid answer the table refuses (its key check), in the job's scope.
        const { keepAnswer } = await import('@mantle/db/answer-cache');
        await keepAnswer('vision', 'not-a-key', { text: 'paid' }, true);
      }
      if (left > 0 || runs.keepFails.has(key)) {
        runs.waits.set(key, left - 1);
        return {
          status: 'asked',
          rows: 0,
          made: 0,
          reused: 0,
          warnings: [],
          stopped: 'provider_rate_limit',
          wait: { for: 'provider', reason: 'rate_limit' },
        };
      }
      if (runs.again.has(key)) {
        return { status: 'asked', rows: 1, made: 1, reused: 0, warnings: [], extractAgain: true };
      }
      return { status: 'built', tabs: 1, rows: 1 };
    },
  ),
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
        void m.runAsSystem('test:listen', () =>
          q.enqueuePipelineRun(run.nodeId, run.pipelineId, run.pages),
        );
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
  it("the page mark of a person's run of one file reaches the run, in a job of its own key (Q2)", async () => {
    const busy = await file('minutes-2.docx');
    runs.held.add(busy);
    await m.runAsSystem('test', () => q.enqueueExtract(busy));
    await until('the main worker is held', () => runs.release.has(busy));
    const pdf = await file('older-plan.pdf');
    const key = `drawing-pdf:${pdf}`;
    // A read again with no mark, then a person's run with it, while the
    // first waits: two jobs, the mark's never taken by the other.
    await m.runAsSystem('test', () => m.notifyPipelineRun(pdf, 'drawing-pdf'));
    await m.runAsSystem('test', () => m.notifyPipelineRun(pdf, 'drawing-pdf', { pages: true }));
    await until('both are queued', async () => (await jobs(pdf)).length === 2);
    expect((await jobs(pdf)).map((j) => j.key)).toEqual([key, `${key}:pages`]);
    runs.release.get(busy)!();
    await until('both ran', () => runs.pagesOf.filter(([k]) => k === key).length === 2);
    expect(
      runs.pagesOf
        .filter(([k]) => k === key)
        .map(([, p]) => p)
        .sort(),
    ).toEqual([false, true]);
    // A payload of another form gives no run.
    expect(m.pipelineRunOfPayload(`drawing-pdf:${pdf}:other`)).toBeNull();
    expect(m.pipelineRunOfPayload(`drawing-pdf:${pdf}:pages:x`)).toBeNull();
    expect(m.pipelineRunOfPayload(`drawing-pdf:${pdf}`)).toEqual({
      pipelineId: 'drawing-pdf',
      nodeId: pdf,
    });
  }, 90_000);

  it('a run held many times with no work done is sent again each time, never failed, and ends', async () => {
    const pdf = await file('book-figures.pdf');
    const key = `pdf-page-read:${pdf}`;
    const WAITS = 6;
    runs.waits.set(key, WAITS);
    const main = () =>
      su<{ state: string; waits: number | null }[]>`
        select state, (data->'wait'->>'waits')::int as waits from pgboss.job
        where data->>'nodeId' = ${pdf} and name = 'mantle.extract' order by created_on`;
    await m.runAsSystem('test', () => q.enqueuePipelineRun(pdf, 'pdf-page-read'));
    for (let sent = 1; sent <= WAITS; sent += 1) {
      await until(`wait ${sent} is sent`, async () => (await main()).length === sent + 1);
      // Due now, not after the wait's gap.
      await su`update pgboss.job set start_after = now()
        where data->>'nodeId' = ${pdf} and state = 'created'`;
    }
    await until('the run built', () => runs.jobs.filter((j) => j === key).length === WAITS + 1);
    await until('its job is done', async () => (await main()).at(-1)!.state === 'completed');
    const all = await main();
    expect(all.map((j) => j.waits)).toEqual([null, ...Array.from({ length: WAITS }, (_, i) => i)]);
    // Every try completed: none failed to the dead letters.
    expect(all.every((j) => j.state === 'completed')).toBe(true);
  }, 120_000);

  it('a run whose paid answer was not kept fails once on its wait: no new job', async () => {
    const pdf = await file('book-unkept.pdf');
    const key = `pdf-page-read:${pdf}`;
    runs.keepFails.add(key);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await m.runAsSystem('test', () => q.enqueuePipelineRun(pdf, 'pdf-page-read'));
      await until('the run failed', async () =>
        (await jobs(pdf)).some((j) => j.state === 'failed'),
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
      // One try on the main queue, failed: no new job sent as a wait.
      const main = (await jobs(pdf)).filter((j) => j.name === 'mantle.extract');
      expect(main.map((j) => [j.state, j.retries])).toEqual([['failed', 0]]);
      expect(runs.jobs.filter((j) => j === key)).toHaveLength(1);
      expect(error.mock.calls.some((c) => String(c[0]).includes('[answer-cache]'))).toBe(true);
    } finally {
      runs.keepFails.delete(key);
      error.mockRestore();
    }
  }, 90_000);

  it("an Agent's new page text on a file too short to extract sends its extract once more", async () => {
    const pdf = await file('one-page-scan.pdf');
    const key = `pdf-page-read:${pdf}`;
    runs.again.add(key);
    await m.runAsSystem('test', () => q.enqueuePipelineRun(pdf, 'pdf-page-read'));
    await until('the extract ran after the run', () => runs.extracts.includes(pdf));
    await until('its jobs are done', async () =>
      (await jobs(pdf)).every((j) => j.state === 'completed'),
    );
    // One run, then the extract: a job of the file's own key, read once.
    const all = await jobs(pdf);
    expect(all[0]).toMatchObject({ run: 'pdf-page-read', key });
    expect(all.slice(1).every((j) => j.run === null && j.key === pdf)).toBe(true);
    expect(runs.extracts.filter((id) => id === pdf)).toHaveLength(1);
  }, 90_000);

  it("a book's read is one trace, with the book lane; a run on demand there is told its lane", async () => {
    // Past BOOK_HEAVY_MIN_BYTES by its size alone: the book lane (no bytes,
    // so no page count is read). Built in SQL: a JSON text bound as a
    // parameter lands as one jsonb string, with no keys to read.
    const id = randomUUID();
    await su`insert into nodes (id, owner_id, type, title, path, data)
      values (${id}, ${owner}, 'file', 'spec-book.pdf', 'files',
              jsonb_build_object('filename', 'spec-book.pdf', 'size_bytes', 40000000))`;
    await m.runAsSystem('test', () => q.enqueueExtract(id));
    await until('the book was read', () => runs.extracts.includes(id));
    await until('its jobs are done', async () =>
      (await jobs(id)).every((j) => j.state === 'completed'),
    );
    expect((await jobs(id)).map((j) => j.name)).toEqual(['mantle.extract', 'mantle.extract.book']);
    const seen = runs.traceOf.get(id)!;
    await until('the traces closed', async () => {
      const open = await su<{ n: number }[]>`
        select count(*)::int as n from traces where subject_id = ${id} and status = 'running'`;
      return open[0]!.n === 0;
    });
    const rows = await su<
      { id: string; kind: string; status: string; source: string | null; lane: string | null }[]
    >`select id, kind::text as kind, status::text as status, data->>'source' as source,
             data->>'lane' as lane
        from traces where subject_id = ${id} order by started_at`;
    expect(rows.map((r) => [r.kind, r.status, r.source, r.lane])).toEqual([
      ['pipeline_run', 'success', 'book', 'book'],
      ['extractor_run', 'success', null, 'book'],
    ]);
    // The extract ran in the book's trace; the trace it opened is the other.
    expect(seen.outer).toBe(rows[0]!.id);
    expect(seen.inner).toBe(rows[1]!.id);

    await m.runAsSystem('test', () => q.enqueuePipelineRun(id, 'pdf-page-read'));
    await until('the run ran', () => runs.jobs.includes(`pdf-page-read:${id}`));
    expect(runs.laneOf.get(`pdf-page-read:${id}`)).toBe('book');
    // A file of the main queue: no lane, and no trace of the queue's own.
    const small = await file('minutes-2.docx');
    await m.runAsSystem('test', () => q.enqueueExtract(small));
    await until('the small file was read', () => runs.extracts.includes(small));
    expect(runs.traceOf.get(small)!.outer).toBeNull();
  }, 90_000);
});
