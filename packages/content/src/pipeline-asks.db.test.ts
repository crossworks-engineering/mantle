/**
 * The count the day cap of the Agents' paid asks is held against
 * (docs/pipelines.md, "Agents"), on a real migrated Postgres:
 * pipelineAsksToday reads the trace, and nothing else.
 *
 *  - a step with `meta.use` = 'pipeline_ask' in a `pipeline_run` trace of
 *    this owner, started now, counts 1; a second counts 2;
 *  - a step with another `use`, or with none, counts nothing;
 *  - a step started 25 hours ago counts nothing;
 *  - a step in a trace of another owner counts nothing for this one;
 *  - a `pipeline_ask` step in a trace of another kind counts nothing: a
 *    paid ask is only ever made inside a `pipeline_run` trace;
 *  - pipelineAsksDayCap reads MANTLE_PIPELINE_ASKS_PER_DAY when it is
 *    called: 20,000 by default, and 0 when the env says 0.
 *
 * The count is taken before the first row and each check is the rise from
 * it, so rows of another test under the same anchor change nothing. Its
 * rows are removed after.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/content/src/pipeline-asks.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('pipelineAsksToday and pipelineAsksDayCap', () => {
  type Db = typeof import('@mantle/db');
  type Ts = typeof import('@mantle/db/test-support');
  let m: Db;
  let pa: typeof import('./pipeline-asks');
  let su: ReturnType<Ts['superuserClient']> | undefined;
  let owner = '';
  const other = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const traceIds: string[] = [];
  const now = new Date();
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);
  let base = 0;
  let ordinal = 0;

  const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:pipeline-asks', fn);
  /** The rise of this owner's count since the first read. */
  const risen = async () => (await sys(() => pa.pipelineAsksToday(owner, now))) - base;

  /** One trace, started at `at`. */
  const trace = async (ownerId: string, kind: 'pipeline_run' | 'extractor_run', at = now) => {
    const id = randomUUID();
    await su!`insert into traces (id, owner_id, kind, subject_kind, status, started_at)
      values (${id}, ${ownerId}, ${kind}::trace_kind, 'node', 'success', ${at})`;
    traceIds.push(id);
    return id;
  };
  /** One step of a trace, started at `at`. `use`: its `meta.use`; null: a
   *  step with no `use`. */
  const step = async (traceId: string, use: string | null, at = now) => {
    if (use === null) {
      await su!`insert into trace_steps (trace_id, ordinal, name, kind, status, started_at)
        values (${traceId}, ${ordinal++}, 'a made-up step', 'compute', 'success', ${at})`;
      return;
    }
    await su!`insert into trace_steps (trace_id, ordinal, name, kind, status, started_at, meta)
      values (${traceId}, ${ordinal++}, 'a made-up step', 'llm_call', 'success', ${at},
              jsonb_build_object('use', ${use}::text))`;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    pa = await import('./pipeline-asks');
    const ts: Ts = await import('@mantle/db/test-support');
    su = ts.superuserClient(URL!);
    owner = await ts.ensureTestAnchor(su);
    // Another login, to own a trace: traces.owner_id names a row of auth.users.
    await su`insert into auth.users (id, email, password_hash, role)
      values (${other}, ${`asks-${tag}@example.invalid`}, 'x', 'member')`;
    base = await sys(() => pa.pipelineAsksToday(owner, now));
  }, 120_000);

  afterAll(async () => {
    if (su) {
      // The steps go with their trace.
      if (traceIds.length > 0) await su`delete from traces where id = any(${traceIds})`;
      await su`delete from auth.users where id = ${other}`;
      await su.end();
    }
    await m?.closeDb();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('counts each pipeline_ask step of a pipeline_run trace of this owner', async () => {
    const run = await trace(owner, 'pipeline_run');
    expect(await risen()).toBe(0);
    await step(run, pa.PIPELINE_ASK_USE);
    expect(await risen()).toBe(1);
    await step(run, pa.PIPELINE_ASK_USE);
    expect(await risen()).toBe(2);
    // The word is the one the ask writes.
    expect(pa.PIPELINE_ASK_USE).toBe('pipeline_ask');
  });

  it('a step with another use, or with none, does not count', async () => {
    const before = await risen();
    const run = await trace(owner, 'pipeline_run');
    await step(run, 'decide_pdf_kind');
    await step(run, null);
    expect(await risen()).toBe(before);
  });

  it('a step started 25 hours ago does not count', async () => {
    const before = await risen();
    // The trace started within the look of the count; its step did not.
    const run = await trace(owner, 'pipeline_run', hoursAgo(24.5));
    await step(run, pa.PIPELINE_ASK_USE, hoursAgo(25));
    expect(await risen()).toBe(before);
    // It is a real row: a count from 2 hours before `now` holds it too.
    expect(
      (await sys(() => pa.pipelineAsksToday(owner, hoursAgo(2)))) -
        (await sys(() => pa.pipelineAsksToday(owner, now))),
    ).toBeGreaterThanOrEqual(1);
  });

  it("a step of another owner's trace does not count for this owner", async () => {
    const before = await risen();
    const theirs = await trace(other, 'pipeline_run');
    await step(theirs, pa.PIPELINE_ASK_USE);
    expect(await risen()).toBe(before);
    // It is a real row: it counts for its own owner.
    expect(await sys(() => pa.pipelineAsksToday(other, now))).toBe(1);
  });

  it('a pipeline_ask step in a trace of another kind does not count', async () => {
    const before = await risen();
    const extract = await trace(owner, 'extractor_run');
    await step(extract, pa.PIPELINE_ASK_USE);
    expect(await risen()).toBe(before);
  });

  it('the day cap is read from the env at the call: 20,000 by default, 0 when it says 0', () => {
    // Blank is the default (the one number dialect, @mantle/config).
    vi.stubEnv('MANTLE_PIPELINE_ASKS_PER_DAY', '');
    expect(pa.pipelineAsksDayCap()).toBe(20_000);
    vi.stubEnv('MANTLE_PIPELINE_ASKS_PER_DAY', '0');
    expect(pa.pipelineAsksDayCap()).toBe(0);
    vi.stubEnv('MANTLE_PIPELINE_ASKS_PER_DAY', '150');
    expect(pa.pipelineAsksDayCap()).toBe(150);
  });
});
