import { describe, expect, it, vi } from 'vitest';
import { HEADS_DEAD_QUEUE, parkHeadsFailure } from './extract-heads-park';

/** A Postgres error as Drizzle wraps it: the SQLSTATE on the cause. */
const pgError = (code: string, message: string) =>
  Object.assign(new Error('Failed query'), { cause: Object.assign(new Error(message), { code }) });

describe('parkHeadsFailure (plan V5)', () => {
  it('parks a heads-check refusal once and reports it handled, so pg-boss never retries', async () => {
    const stamp = vi.fn(async (_id: string) => {});
    const park = vi.fn(async (_data: { nodeId: string }) => {});
    const alert = vi.fn(async () => {});
    const log = vi.fn((_msg: string) => {});
    const err = pgError(
      '40001',
      'heads not held for content_chunks_write (node x): head not locked first for update',
    );
    await expect(parkHeadsFailure(err, 'n1', { stamp, park, alert, log })).resolves.toBe(true);
    expect(stamp).toHaveBeenCalledWith('n1');
    expect(park).toHaveBeenCalledTimes(1);
    expect(park.mock.calls[0]![0]).toMatchObject({ nodeId: 'n1' });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain(HEADS_DEAD_QUEUE);
  });

  it('leaves every other failure to the normal retry path (the extractor runs again only then)', async () => {
    const park = vi.fn(async (_data: { nodeId: string }) => {});
    const stamp = vi.fn(async (_id: string) => {});
    const quiet = { stamp, park, alert: async () => {}, log: () => {} };
    const extractorCalls = { n: 1 };
    for (const err of [
      pgError('40001', 'could not serialize access due to concurrent update'),
      pgError('40P01', 'deadlock detected'),
      new Error('provider 429'),
    ]) {
      const handled = await parkHeadsFailure(err, 'n2', quiet);
      expect(handled).toBe(false);
      if (!handled) extractorCalls.n += 1; // pg-boss retries: the extractor would run again
    }
    expect(park).not.toHaveBeenCalled();
    expect(stamp).not.toHaveBeenCalled();
    // A heads refusal, by contrast, adds no run.
    const before = extractorCalls.n;
    if (
      !(await parkHeadsFailure(
        pgError('55000', 'mantle_lock_heads: heads must be the first lock of the transaction'),
        'n3',
        quiet,
      ))
    ) {
      extractorCalls.n += 1;
    }
    expect(extractorCalls.n).toBe(before);
  });

  it('with no queue (the agent is stopping) the stamp alone records it, and an alert failure is only logged', async () => {
    const stamp = vi.fn(async (_id: string) => {});
    const log = vi.fn((_msg: string) => {});
    const err = pgError('40001', 'heads not held for facts_write (node y): head not locked first');
    await expect(
      parkHeadsFailure(err, 'n4', {
        stamp,
        park: null,
        alert: async () => {
          throw new Error('no connection');
        },
        log,
      }),
    ).resolves.toBe(true);
    expect(stamp).toHaveBeenCalledWith('n4');
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(/stamp only/);
  });

  it('a failed stamp is not a park: the error goes to the normal path', async () => {
    const err = pgError('40001', 'heads not held for facts_write (node z): head not locked first');
    const park = vi.fn(async () => {});
    await expect(
      parkHeadsFailure(err, 'n5', {
        stamp: async () => {
          throw new Error('db down');
        },
        park,
        alert: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow('db down');
    expect(park).not.toHaveBeenCalled();
  });
});
