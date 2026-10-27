/**
 * The parser's job slots (./slots.ts): at most `maxJobs` at once, at most
 * `queueMax` waiting, each for at most `waitMs`, then `busy`; a freed slot
 * goes to the longest waiter.
 */
import { describe, expect, it } from 'vitest';
import { JobFailure } from './job-failure';
import { Slots } from './slots';

async function refusal(p: Promise<unknown>): Promise<JobFailure> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(JobFailure);
  return err as JobFailure;
}

describe('Slots', () => {
  it('runs up to maxJobs at once', async () => {
    const slots = new Slots(2, 0, 1_000);
    await slots.acquire();
    await slots.acquire();
    expect(slots.running).toBe(2);
    const busy = await refusal(slots.acquire());
    expect(busy.code).toBe('busy');
    expect(slots.running).toBe(2);
  });

  it('queues up to queueMax, then refuses busy at once', async () => {
    const slots = new Slots(1, 2, 10_000);
    await slots.acquire();
    const a = slots.acquire();
    const b = slots.acquire();
    expect(slots.queued).toBe(2);
    const c = await refusal(slots.acquire());
    expect(c).toMatchObject({ code: 'busy' });
    expect(c.message).toContain('2 wait already');
    // A freed slot goes to the longest waiter, then the next.
    slots.release();
    await a;
    expect(slots.queued).toBe(1);
    expect(slots.running).toBe(1);
    slots.release();
    await b;
    expect(slots.queued).toBe(0);
    slots.release();
    expect(slots.running).toBe(0);
  });

  it('answers busy when the wait passes, and leaves the queue', async () => {
    const slots = new Slots(1, 4, 50);
    await slots.acquire();
    const err = await refusal(slots.acquire());
    expect(err.code).toBe('busy');
    expect(err.message).toContain('0.05 s');
    expect(slots.queued).toBe(0);
    // The slot a timed-out waiter never took is not counted as running.
    slots.release();
    expect(slots.running).toBe(0);
  });

  it('never goes below zero', () => {
    const slots = new Slots(1, 0, 1_000);
    slots.release();
    expect(slots.running).toBe(0);
  });
});
