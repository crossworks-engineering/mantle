import { describe, expect, it, vi } from 'vitest';
import { HEADS_DEAD_QUEUE, parkHeadsFailure } from './extract-heads-park';

/** A Postgres error as Drizzle wraps it: the SQLSTATE on the cause. */
const pgError = (code: string, message: string) =>
  Object.assign(new Error('Failed query'), { cause: Object.assign(new Error(message), { code }) });

describe('parkHeadsFailure (plan V5)', () => {
  it('parks a heads-check refusal once and reports it handled, so pg-boss never retries', async () => {
    const park = vi.fn(async (_data: { nodeId: string }) => {});
    const log = vi.fn((_msg: string) => {});
    const err = pgError(
      '40001',
      'heads not held for content_chunks_write (node x): head not locked first for update',
    );
    await expect(parkHeadsFailure(err, 'n1', { park, log })).resolves.toBe(true);
    expect(park).toHaveBeenCalledTimes(1);
    expect(park.mock.calls[0]![0]).toMatchObject({ nodeId: 'n1' });
    expect(log.mock.calls[0]![0]).toContain(HEADS_DEAD_QUEUE);
  });

  it('leaves every other failure to the normal retry path (the extractor runs again only then)', async () => {
    const park = vi.fn(async (_data: { nodeId: string }) => {});
    const extractorCalls = { n: 1 };
    for (const err of [
      pgError('40001', 'could not serialize access due to concurrent update'),
      pgError('40P01', 'deadlock detected'),
      new Error('provider 429'),
    ]) {
      const handled = await parkHeadsFailure(err, 'n2', { park, log: () => {} });
      expect(handled).toBe(false);
      if (!handled) extractorCalls.n += 1; // pg-boss retries: the extractor would run again
    }
    expect(park).not.toHaveBeenCalled();
    // A heads refusal, by contrast, adds no run.
    const before = extractorCalls.n;
    if (
      !(await parkHeadsFailure(
        pgError('55000', 'mantle_lock_heads: heads must be the first lock of the transaction'),
        'n3',
        { park, log: () => {} },
      ))
    ) {
      extractorCalls.n += 1;
    }
    expect(extractorCalls.n).toBe(before);
  });
});
