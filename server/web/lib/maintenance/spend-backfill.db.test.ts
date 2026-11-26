/**
 * spend-backfill on a real, migrated Postgres
 * (lib/maintenance/spend-backfill.ts): a dry run changes nothing; an apply
 * writes the list price on each $0 step it can price, marks the step, and
 * adds the same amount to the step's trace total, to the run item that
 * copied that total and to the run's spent amount; a cost above 0, a free
 * route, a timed-out step, a model with no price row, a step with no
 * recorded cost (the old shape), a step of a trace that closed a moment ago
 * and a step of a trace still running are left as they are; a step of a
 * run that has not ended is left too, with its run item and its run (no
 * live run is paused by a list price), and a later run prices it once the
 * run has ended; token counts never change; a second apply changes nothing;
 * the undo puts every row back exactly as it was. A scratch database,
 * dropped after (the walk is box-wide).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/lib/maintenance/spend-backfill.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** List prices of the fixtures (packages/tracing/src/pricing.ts). */
const VISION_USD = 825_000 + 412_500; // 1M in, 100k out of Gemini 3.8 Flash
const EMBED_USD = 130_000; // 1M tokens of text-embedding-3-large
const SONNET_USD = 2_000_000; // 1M in of Claude Sonnet 5.5

type Snapshot = {
  steps: Record<string, Record<string, unknown>>;
  traces: Record<string, Record<string, unknown>>;
  items: Record<string, unknown>;
  runs: Record<string, unknown>;
};

describe.skipIf(!URL)('spend-backfill', () => {
  let m: typeof import('@mantle/db');
  let backfill: typeof import('./spend-backfill');
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let anchor = '';
  const trace = {
    old: randomUUID(), // closed two hours ago: several steps
    item: randomUUID(), // closed two hours ago: a run item copied its total
    fresh: randomUUID(), // closed five minutes ago
    running: randomUUID(), // never closed
    openRun: randomUUID(), // closed two hours ago: the item of a run not ended
  };
  const step = {
    vision: randomUUID(), // the recorder shape, $0: to price
    embed: randomUUID(), // a bare embedding id, $0: to price
    paid: randomUUID(), // a cost above 0: never touched
    local: randomUUID(), // a free route
    timedOut: randomUUID(),
    unlisted: randomUUID(), // a model with no price row
    oldShape: randomUUID(), // tokens, no recorded cost
    sonnet: randomUUID(), // in the run item's trace: to price
    fresh: randomUUID(), // its trace closed a moment ago
    running: randomUUID(), // its trace is still open
    openRun: randomUUID(), // it has a price, and its run has not ended
  };
  const run = randomUUID(); // ended
  const item = randomUUID();
  const openRun = randomUUID(); // paused on its budget: not ended
  const openItem = randomUUID();

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async (q: ReturnType<typeof sql>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);

  const snapshot = async (): Promise<Snapshot> => {
    const steps = await x<{ id: string; meta: Record<string, unknown> }>(
      sql`select s.id, s.meta from trace_steps s join traces t on t.id = s.trace_id
           where t.owner_id = ${anchor}::uuid`,
    );
    const traces = await x<Record<string, unknown> & { id: string }>(
      sql`select id, cost_micro_usd::text as cost, tokens_in, tokens_out, tokens_embed
            from traces where owner_id = ${anchor}::uuid`,
    );
    const items = await x<{ id: string; cost: string | null }>(
      sql`select id, cost_micro_usd::text as cost from run_items
           where run_id in (${run}::uuid, ${openRun}::uuid)`,
    );
    const runs = await x<{ id: string; spent: string }>(
      sql`select id, spent_micro_usd::text as spent from runs
           where id in (${run}::uuid, ${openRun}::uuid)`,
    );
    return {
      steps: Object.fromEntries(steps.map((r) => [r.id, r.meta])),
      traces: Object.fromEntries(traces.map(({ id, ...rest }) => [id, rest])),
      items: Object.fromEntries(items.map((r) => [r.id, r.cost])),
      runs: Object.fromEntries(runs.map((r) => [r.id, r.spent])),
    };
  };

  beforeAll(async () => {
    scratch = await (await import('@mantle/db/test-support')).createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    m = await import('@mantle/db');
    backfill = await import('./spend-backfill');
    const admin = (m.systemDb as unknown as { $client: Parameters<typeof ensureTestAnchor>[0] })
      .$client;
    anchor = await ensureTestAnchor(admin);

    const addTrace = (id: string, closed: string | null, cost: number, tokensIn: number) =>
      su(sql`insert into traces (id, owner_id, kind, subject_kind, status, started_at,
                                 finished_at, cost_micro_usd, tokens_in, tokens_out, tokens_embed)
             values (${id}, ${anchor}, 'manual', 'node',
                     ${closed ? 'success' : 'running'},
                     now() - interval '3 hours',
                     ${closed ? sql`now() - ${closed}::interval` : sql`null`},
                     ${cost}, ${tokensIn}, 100000, 1000000)`);
    await addTrace(trace.old, '2 hours', 500, 2_000_000);
    await addTrace(trace.item, '2 hours', 0, 1_000_000);
    await addTrace(trace.fresh, '5 minutes', 0, 1_000_000);
    await addTrace(trace.running, null, 0, 1_000_000);
    await addTrace(trace.openRun, '2 hours', 0, 1_000_000);

    let ordinal = 0;
    const addStep = (
      id: string,
      traceId: string,
      kind: string,
      meta: Record<string, unknown>,
      input: Record<string, unknown> = {},
    ) =>
      su(sql`insert into trace_steps (id, trace_id, ordinal, name, kind, status, started_at,
                                      meta, input)
             values (${id}, ${traceId}, ${ordinal++}, 'made_up_step', ${kind}, 'success',
                     now() - interval '3 hours',
                     ${JSON.stringify(meta)}::jsonb, ${JSON.stringify(input)}::jsonb)`);
    const vision = {
      model: 'google/gemini-3.8-flash',
      provider: 'openrouter',
      tokens_in: 1_000_000,
      tokens_out: 100_000,
      cost_micro_usd: 0,
    };
    await addStep(step.vision, trace.old, 'llm_call', vision);
    await addStep(step.embed, trace.old, 'embed', {
      model: 'text-embedding-3-large',
      provider: 'openrouter',
      tokens_in: 1_000_000,
      tokens_out: 0,
      cost_micro_usd: 0,
      cache_hits: 3,
    });
    await addStep(step.paid, trace.old, 'llm_call', { ...vision, cost_micro_usd: 500 });
    await addStep(step.local, trace.old, 'embed', {
      model: 'embeddinggemma:latest',
      provider: 'local',
      tokens_in: 5000,
      tokens_out: 0,
      cost_micro_usd: 0,
    });
    await addStep(step.timedOut, trace.old, 'llm_call', { ...vision, timed_out: 1 });
    await addStep(step.unlisted, trace.old, 'llm_call', { ...vision, model: 'made-up/unlisted' });
    await addStep(step.oldShape, trace.old, 'llm_call', {
      ran: true,
      model: 'gpt-4o-mini',
      adapter: 'openai-vision',
      tokensIn: 25_000,
      tokensOut: 48,
    });
    // A meta from before the recorder wrote `provider`: the route is in the input.
    await addStep(
      step.sonnet,
      trace.item,
      'llm_call',
      { model: 'claude-sonnet-5-5', tokens_in: 1_000_000, tokens_out: 0, cost_micro_usd: 0 },
      { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    );
    await addStep(step.fresh, trace.fresh, 'llm_call', vision);
    await addStep(step.running, trace.running, 'llm_call', vision);
    await addStep(step.openRun, trace.openRun, 'llm_call', vision);

    // An ended run: the engine stamps completed_at when a run finishes.
    await su(sql`insert into runs (id, owner_id, title, status, spent_micro_usd, completed_at)
                 values (${run}, ${anchor}, 'a made-up run', 'done', 0,
                         now() - interval '2 hours')`);
    await su(sql`insert into run_items (id, run_id, position, kind, state, trace_ref)
                 values (${item}, ${run}, 0, 'tool_call', 'done', ${trace.item})`);
    // A run paused on its budget: it has not ended, and an item of it is done.
    await su(sql`insert into runs (id, owner_id, title, status, spent_micro_usd, budget_micro_usd)
                 values (${openRun}, ${anchor}, 'a made-up open run', 'paused', 0, 1)`);
    await su(sql`insert into run_items (id, run_id, position, kind, state, trace_ref)
                 values (${openItem}, ${openRun}, 0, 'tool_call', 'done', ${trace.openRun})`);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  let start: Snapshot;

  it('a dry run counts what it would price and changes nothing', async () => {
    start = await snapshot();
    const { tally, written } = await backfill.runSpendBackfill({ mode: 'price', apply: false });
    expect(await snapshot()).toEqual(start);
    expect(written.steps).toBe(0);
    expect(backfill.totalMicroUsd(tally)).toBe(VISION_USD + EMBED_USD + SONNET_USD);
    expect(tally.traces.size).toBe(2);
    expect([...tally.price.values()].map((l) => [l.provider, l.model, l.steps]).sort()).toEqual([
      ['anthropic', 'claude-sonnet-5-5', 1],
      ['openrouter', 'google/gemini-3.8-flash', 1],
      ['openrouter', 'text-embedding-3-large', 1],
    ]);
    expect([...tally.cannot.values()].map((l) => [l.why, l.model]).sort()).toEqual([
      ['old_shape', 'gpt-4o-mini'],
      ['unpriced', 'made-up/unlisted'],
    ]);
    expect(tally.left).toEqual({ free: 1, timed_out: 1 });
    // The step of the run that has not ended: on its own line, with its USD,
    // and out of the total.
    expect(tally.runOpen).toEqual({ steps: 1, microUsd: VISION_USD });
  });

  it('a bound holds a run to its model and its dates', async () => {
    const one = await backfill.runSpendBackfill({
      mode: 'price',
      apply: false,
      bounds: { model: 'text-embedding-3-large' },
    });
    expect(backfill.totalMicroUsd(one.tally)).toBe(EMBED_USD);
    const none = await backfill.runSpendBackfill({
      mode: 'price',
      apply: false,
      bounds: { since: new Date(Date.now() - 60_000) },
    });
    expect(none.tally.read).toBe(0);
    const all = await backfill.runSpendBackfill({
      mode: 'price',
      apply: false,
      bounds: { since: new Date(Date.now() - 86_400_000), until: new Date() },
    });
    expect(backfill.totalMicroUsd(all.tally)).toBe(VISION_USD + EMBED_USD + SONNET_USD);
  });

  let applied: Snapshot;

  it('an apply prices exactly those steps and keeps every total with them', async () => {
    // One step per statement: the totals must hold across batches.
    const { written } = await backfill.runSpendBackfill({ mode: 'price', apply: true, batch: 1 });
    expect(written).toMatchObject({
      steps: 3,
      microUsd: VISION_USD + EMBED_USD + SONNET_USD,
      runItems: 1,
      runs: 1,
    });
    applied = await snapshot();

    const mark = (amount: number) => ({
      micro_usd: amount,
      basis: 'list_price',
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    });
    expect(applied.steps[step.vision]).toEqual({
      ...start.steps[step.vision],
      cost_micro_usd: VISION_USD,
      cost_backfill: mark(VISION_USD),
    });
    expect(applied.steps[step.embed]).toEqual({
      ...start.steps[step.embed],
      cost_micro_usd: EMBED_USD,
      cost_backfill: mark(EMBED_USD),
    });
    expect(applied.steps[step.sonnet]).toEqual({
      ...start.steps[step.sonnet],
      cost_micro_usd: SONNET_USD,
      cost_backfill: mark(SONNET_USD),
    });
    // Every other step is as it was.
    for (const id of [
      step.paid,
      step.local,
      step.timedOut,
      step.unlisted,
      step.oldShape,
      step.fresh,
      step.running,
      step.openRun,
    ]) {
      expect(applied.steps[id], id).toEqual(start.steps[id]);
    }

    // The trace totals: the old total plus its steps' amounts. Tokens as they were.
    expect(applied.traces[trace.old]).toEqual({
      ...start.traces[trace.old],
      cost: String(500 + VISION_USD + EMBED_USD),
    });
    expect(applied.traces[trace.item]).toEqual({
      ...start.traces[trace.item],
      cost: String(SONNET_USD),
    });
    expect(applied.traces[trace.fresh]).toEqual(start.traces[trace.fresh]);
    expect(applied.traces[trace.running]).toEqual(start.traces[trace.running]);

    // The copies of the trace total: the run item and the run's spent amount.
    expect(start.items[item]).toBeNull();
    expect(applied.items[item]).toBe(String(SONNET_USD));
    expect(applied.runs[run]).toBe(String(SONNET_USD));

    // The run that has not ended: its step's trace, its item and its spent
    // amount are as they were, so the backfill cannot make it pause.
    expect(applied.traces[trace.openRun]).toEqual(start.traces[trace.openRun]);
    expect(applied.items[openItem]).toBeNull();
    expect(applied.runs[openRun]).toBe('0');

    // The stored totals agree with the steps: a trace's backfilled amounts
    // are the sum of its steps' marks.
    const [sum] = await x<{ marks: string; costs: string }>(sql`
      select coalesce(sum((s.meta->'cost_backfill'->>'micro_usd')::bigint), 0)::text as marks,
             coalesce(sum((s.meta->>'cost_micro_usd')::bigint), 0)::text as costs
        from trace_steps s where s.trace_id = ${trace.old}::uuid`);
    expect(sum).toEqual({
      marks: String(VISION_USD + EMBED_USD),
      costs: String(500 + VISION_USD + EMBED_USD),
    });
  });

  it('a second apply changes nothing', async () => {
    const again = await backfill.runSpendBackfill({ mode: 'price', apply: true });
    expect(again.written.steps).toBe(0);
    expect(backfill.totalMicroUsd(again.tally)).toBe(0);
    expect(await snapshot()).toEqual(applied);
  });

  it('the undo lists the marked steps, and a dry run of it changes nothing', async () => {
    const { tally, written } = await backfill.runSpendBackfill({ mode: 'undo', apply: false });
    expect(written.steps).toBe(0);
    expect(tally.read).toBe(3);
    expect(backfill.totalMicroUsd(tally)).toBe(VISION_USD + EMBED_USD + SONNET_USD);
    expect(await snapshot()).toEqual(applied);
  });

  it('the undo puts every row back exactly as it was', async () => {
    const { written } = await backfill.runSpendBackfill({ mode: 'undo', apply: true, batch: 2 });
    expect(written).toMatchObject({
      steps: 3,
      microUsd: VISION_USD + EMBED_USD + SONNET_USD,
      runItems: 1,
      runs: 1,
    });
    // The step metas, the trace totals, the item's NULL cost and the run.
    expect(await snapshot()).toEqual(start);
    const none = await backfill.runSpendBackfill({ mode: 'undo', apply: true });
    expect(none.written.steps).toBe(0);
  });

  it('after an undo the same steps can be priced again', async () => {
    const { written } = await backfill.runSpendBackfill({ mode: 'price', apply: true });
    expect(written.steps).toBe(3);
    const now = await snapshot();
    expect(now.traces).toEqual(applied.traces);
    expect(now.items).toEqual(applied.items);
    expect(now.runs).toEqual(applied.runs);
  });

  it('once the run has ended, a later run prices its step and its totals', async () => {
    // Every apply above left it: the step, its trace, the item and the run.
    const before = await snapshot();
    expect(before.steps[step.openRun]).toEqual(start.steps[step.openRun]);
    expect(before.traces[trace.openRun]).toEqual(start.traces[trace.openRun]);
    expect(before.items[openItem]).toBeNull();
    expect(before.runs[openRun]).toBe('0');

    // The run ends as the engine ends one: a final status and completed_at.
    await su(sql`update runs set status = 'cancelled', completed_at = now()
                  where id = ${openRun}::uuid`);
    const { tally, written } = await backfill.runSpendBackfill({ mode: 'price', apply: true });
    expect(tally.runOpen).toEqual({ steps: 0, microUsd: 0 });
    expect(written).toMatchObject({ steps: 1, microUsd: VISION_USD, runItems: 1, runs: 1 });

    const after = await snapshot();
    expect(after.steps[step.openRun]).toMatchObject({
      cost_micro_usd: VISION_USD,
      cost_backfill: { micro_usd: VISION_USD, basis: 'list_price' },
    });
    expect(after.traces[trace.openRun]).toEqual({
      ...start.traces[trace.openRun],
      cost: String(VISION_USD),
    });
    expect(after.items[openItem]).toBe(String(VISION_USD));
    expect(after.runs[openRun]).toBe(String(VISION_USD));
    // The other run is as the last apply left it.
    expect(after.runs[run]).toBe(String(SONNET_USD));
  });
});
