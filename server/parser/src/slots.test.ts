/**
 * The parser's one job slot (./slots.ts): one job at a time, at most
 * `queueMax` waiting, each for at most `waitMs`, then `busy`; a freed slot
 * goes to the longest waiter; an interactive waiter goes ahead of every
 * background one, waits its own shorter time, and is not turned away by a
 * full background queue; how long the slot has been held is known (the
 * watchdog); a closed slot answers every waiter and every later request
 * `unavailable`.
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
  it('runs one job at a time', async () => {
    const slots = new Slots(0, 1_000);
    await slots.acquire();
    expect(slots.running).toBe(1);
    const busy = await refusal(slots.acquire());
    expect(busy.code).toBe('busy');
    expect(slots.running).toBe(1);
  });

  it('queues up to queueMax, then refuses busy at once', async () => {
    const slots = new Slots(2, 10_000);
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
    const slots = new Slots(4, 50);
    await slots.acquire();
    const err = await refusal(slots.acquire());
    expect(err.code).toBe('busy');
    expect(err.message).toContain('0.05 s');
    expect(slots.queued).toBe(0);
    // The slot a timed-out waiter never took is not counted as running.
    slots.release();
    expect(slots.running).toBe(0);
  });

  it('knows how long the slot has been held', async () => {
    const slots = new Slots(0, 1_000);
    expect(slots.heldMs()).toBe(0);
    const before = Date.now();
    await slots.acquire();
    expect(slots.heldMs(before + 5_000)).toBeGreaterThanOrEqual(4_000);
    slots.release();
    expect(slots.heldMs()).toBe(0);
  });

  it('puts an interactive waiter at the head, behind earlier interactive ones', async () => {
    const slots = new Slots(4, 10_000, 10_000);
    await slots.acquire();
    const order: string[] = [];
    const bg1 = slots.acquire().then(() => order.push('bg1'));
    const bg2 = slots.acquire().then(() => order.push('bg2'));
    const i1 = slots.acquire({ interactive: true }).then(() => order.push('i1'));
    const i2 = slots.acquire({ interactive: true }).then(() => order.push('i2'));
    for (let n = 0; n < 4; n++) {
      slots.release();
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all([bg1, bg2, i1, i2]);
    expect(order).toEqual(['i1', 'i2', 'bg1', 'bg2']);
  });

  it('answers an interactive waiter busy after its own short wait', async () => {
    const slots = new Slots(4, 10_000, 50);
    await slots.acquire();
    const started = Date.now();
    const err = await refusal(slots.acquire({ interactive: true }));
    expect(err.code).toBe('busy');
    expect(err.message).toContain('0.05 s');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(slots.queued).toBe(0);
  });

  it('lets an interactive request wait though the background queue is full', async () => {
    const slots = new Slots(1, 10_000, 10_000);
    await slots.acquire();
    const bg = slots.acquire();
    expect((await refusal(slots.acquire())).code).toBe('busy');
    const person = slots.acquire({ interactive: true });
    expect(slots.queued).toBe(2);
    slots.release();
    await person;
    slots.release();
    await bg;
    expect(slots.queued).toBe(0);
  });

  it('closed: every waiter and every later request is unavailable, and nothing runs', async () => {
    const slots = new Slots(4, 10_000, 10_000);
    await slots.acquire();
    const bg = refusal(slots.acquire());
    const person = refusal(slots.acquire({ interactive: true }));
    slots.close('the parser is restarting');
    expect(await bg).toMatchObject({ code: 'unavailable', message: 'the parser is restarting' });
    expect((await person).code).toBe('unavailable');
    expect(slots.queued).toBe(0);
    slots.release();
    expect((await refusal(slots.acquire())).code).toBe('unavailable');
    expect(slots.running).toBe(0);
  });
});
