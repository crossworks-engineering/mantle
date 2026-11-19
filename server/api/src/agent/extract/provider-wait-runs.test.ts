/**
 * The provider is the cap (owner decision 2026-11-19): an Agent's run that
 * stopped at the provider's "not now" or at the day cap is a wait, and the
 * queue sends the same work again later, never to the dead letters.
 *  - runWaitOf (pipeline-run.ts): which stops are waits, and when a run held
 *    at the day cap is due (the window's room, never sooner than its gap);
 *    a cap of 0 is no wait (the operator's "no Agent may ask");
 *  - waitAgain (extract-queue.ts): the same job, with its wait, sent with a
 *    growing gap; a run keeps its key and its "no retry" of anything else.
 */
import { describe, expect, it } from 'vitest';
import { runWaitOf, DAY_CAP_MIN_GAP_MS, type PipelineRunResult } from './pipeline-run';
import { enqueueDeferredFacts, paidWaitResends, waitAgain } from '../extract-queue';
import { PAID_WAIT_RESENDS_MAX } from '@mantle/std';

const asked = (stopped?: string): PipelineRunResult => ({
  status: 'asked',
  rows: 3,
  made: 1,
  reused: 2,
  warnings: [],
  ...(stopped !== undefined ? { stopped } : {}),
});

const NOW = new Date('2026-11-19T12:00:00Z');

describe('runWaitOf', () => {
  const deps = (free: Date | null, cap = 20_000) => ({
    dayCap: () => cap,
    freeAt: async () => free,
    now: () => NOW,
  });

  it('a provider stop is a wait for the provider, with its reason', async () => {
    for (const reason of ['rate_limit', 'quota', 'overloaded'] as const) {
      expect(await runWaitOf('o', asked(`provider_${reason}`), deps(null))).toEqual({
        for: 'provider',
        reason,
      });
    }
  });

  it('a day cap stop waits for the room the window gives', async () => {
    const free = new Date(NOW.getTime() + 3 * 3_600_000);
    expect(await runWaitOf('o', asked('day_cap'), deps(free))).toEqual({
      for: 'day_cap',
      until: free,
    });
  });

  it('never sooner than its gap: each try is a parser job', async () => {
    expect(await runWaitOf('o', asked('day_cap'), deps(NOW))).toEqual({
      for: 'day_cap',
      until: new Date(NOW.getTime() + DAY_CAP_MIN_GAP_MS),
    });
  });

  it('a stop that left a paid read unkept is a paid wait, for the provider and the day cap', async () => {
    const unkept = (stopped: string): PipelineRunResult => ({
      status: 'asked',
      rows: 3,
      made: 0,
      reused: 2,
      warnings: [],
      stopped,
      paidStop: true,
    });
    expect(await runWaitOf('o', unkept('provider_rate_limit'), deps(null))).toEqual({
      for: 'provider',
      reason: 'rate_limit',
      paid: true,
    });
    expect(await runWaitOf('o', unkept('day_cap'), deps(NOW))).toMatchObject({
      for: 'day_cap',
      paid: true,
    });
    expect(await runWaitOf('o', asked('provider_rate_limit'), deps(null))).toEqual({
      for: 'provider',
      reason: 'rate_limit',
    });
  });

  it('a cap of 0 (no Agent may ask) is no wait: the run stops as before', async () => {
    expect(await runWaitOf('o', asked('day_cap'), deps(null, 0))).toBeNull();
  });

  it('every other result is no wait', async () => {
    for (const stopped of [undefined, 'off', 'no_llm_work', 'no_worker', 'failed', 'cap']) {
      expect(await runWaitOf('o', asked(stopped), deps(NOW))).toBeNull();
    }
    expect(await runWaitOf('o', { status: 'failed' }, deps(NOW))).toBeNull();
    expect(await runWaitOf('o', { status: 'skipped', reason: 'gone' }, deps(NOW))).toBeNull();
  });
});

describe('waitAgain', () => {
  const sent: { data: Record<string, unknown>; opts: Record<string, unknown> }[] = [];
  const send = async (data: unknown, opts: Record<string, unknown>) => {
    sent.push({ data: data as Record<string, unknown>, opts });
  };
  const at = NOW.getTime();

  it('a read the provider refused: the same job, a minute later, with its wait', async () => {
    sent.length = 0;
    const due = await waitAgain(
      send,
      { nodeId: 'n1' },
      { for: 'provider', provider: { reason: 'rate_limit' } },
      at,
    );
    expect(due).toEqual(new Date(at + 60_000));
    expect(sent[0]!.data).toEqual({
      nodeId: 'n1',
      wait: { for: 'provider', reason: 'rate_limit', waits: 0, until: due.toISOString() },
    });
    expect(sent[0]!.opts).toMatchObject({ singletonKey: 'n1', startAfter: due });
    expect(sent[0]!.opts.retryLimit).toBeUndefined();
  });

  it('it waits again: the gap doubles', async () => {
    sent.length = 0;
    const due = await waitAgain(
      send,
      {
        nodeId: 'n1',
        wait: { for: 'provider', reason: 'quota', waits: 2, until: NOW.toISOString() },
      },
      { for: 'provider', provider: { reason: 'quota' } },
      at,
    );
    expect(due).toEqual(new Date(at + 8 * 60_000));
    expect((sent[0]!.data.wait as { waits: number }).waits).toBe(3);
  });

  it("an Agent's run at the day cap: its key, no retry of its own, due when the cap has room", async () => {
    sent.length = 0;
    const until = new Date(at + 5 * 3_600_000);
    const due = await waitAgain(
      send,
      { nodeId: 'n2', run: 'pdf-page-read' },
      { for: 'day_cap', until },
      at,
    );
    expect(due).toEqual(until);
    expect(sent[0]!.data).toMatchObject({
      nodeId: 'n2',
      run: 'pdf-page-read',
      wait: { for: 'day_cap', waits: 0 },
    });
    expect(sent[0]!.opts).toMatchObject({
      singletonKey: 'pdf-page-read:n2',
      retryLimit: 0,
      startAfter: until,
    });
  });

  it('deferred facts keep their own key', async () => {
    sent.length = 0;
    await waitAgain(
      send,
      { nodeId: 'n3', facts: { at: 'x', candidates: [] } },
      { for: 'provider', provider: { reason: 'overloaded' } },
      at,
    );
    expect(sent[0]!.opts.singletonKey).toBe('facts:n3:x');
  });

  it('a try that got work done starts the gaps over', async () => {
    sent.length = 0;
    const due = await waitAgain(
      send,
      {
        nodeId: 'n1',
        run: 'pdf-page-read',
        wait: { for: 'provider', reason: 'rate_limit', waits: 7, until: NOW.toISOString() },
      },
      { for: 'provider', provider: { reason: 'rate_limit' } },
      at,
      { progressed: true },
    );
    expect(due).toEqual(new Date(at + 60_000));
    expect((sent[0]!.data.wait as { waits: number }).waits).toBe(0);
  });

  it('a wait after paid calls is counted, and sent again only a few times', async () => {
    sent.length = 0;
    let job: Parameters<typeof waitAgain>[1] = { nodeId: 'n4' };
    let resends = 0;
    while (paidWaitResends(job)) {
      await waitAgain(send, job, { for: 'provider', provider: { reason: 'overloaded' } }, at, {
        paid: true,
      });
      job = sent.at(-1)!.data as typeof job;
      resends++;
    }
    expect(resends).toBe(PAID_WAIT_RESENDS_MAX);
    // A wait before any paid call adds nothing to the count, but keeps it:
    // the same work paid again after it is still past the bound.
    await waitAgain(send, job, { for: 'provider', provider: { reason: 'overloaded' } }, at);
    job = sent.at(-1)!.data as typeof job;
    expect((job.wait as { paid?: number }).paid).toBe(PAID_WAIT_RESENDS_MAX);
    expect(paidWaitResends(job)).toBe(false);
  });

  it('paid and unpaid waits in turn never start the paid count over', async () => {
    sent.length = 0;
    let job: Parameters<typeof waitAgain>[1] = { nodeId: 'n5' };
    let tries = 0;
    // A figure page paid then a wait, then a wait before any call, and so
    // on: bounded all the same.
    while (paidWaitResends(job) && tries < 20) {
      await waitAgain(send, job, { for: 'provider', provider: { reason: 'rate_limit' } }, at, {
        paid: tries % 2 === 0,
      });
      job = sent.at(-1)!.data as typeof job;
      tries++;
    }
    expect(paidWaitResends(job)).toBe(false);
    expect(tries).toBe(2 * PAID_WAIT_RESENDS_MAX - 1);
    // A try that got work done starts it over.
    await waitAgain(send, job, { for: 'provider', provider: { reason: 'rate_limit' } }, at, {
      progressed: true,
    });
    job = sent.at(-1)!.data as typeof job;
    expect((job.wait as { paid?: number }).paid).toBeUndefined();
    expect(paidWaitResends(job)).toBe(true);
  });
});

describe('enqueueDeferredFacts', () => {
  it('with no queue to send to (stopped), it throws: the read is tried again, its facts never lost', async () => {
    const deferred = { facts: { at: NOW.toISOString(), candidates: [] } };
    await expect(enqueueDeferredFacts('n6', deferred)).rejects.toThrow(/not running/);
    await expect(
      enqueueDeferredFacts('n6', { ...deferred, wait: { reason: 'rate_limit' } }),
    ).rejects.toThrow(/not running/);
  });
});
