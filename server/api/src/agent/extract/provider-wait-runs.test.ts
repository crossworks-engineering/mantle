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
import { waitAgain } from '../extract-queue';

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
    expect(sent[0]!.opts.singletonKey).toBe('facts:n3');
  });
});
