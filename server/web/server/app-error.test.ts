import { describe, expect, it } from 'vitest';
import {
  BUSY_MESSAGE,
  BusyError,
  POOL_BUSY_MESSAGE,
  PoolBusyError,
  SAVE_BUSY_MESSAGE,
} from '@mantle/db';
import { appAnswerOf } from './test-support';

/**
 * The busy answers (409): a pool's wait run out says the plain text, on a
 * read as on a write, under drizzle's wrap too; another write holding the
 * rows keeps the text it had.
 */

/** drizzle's wrap of a driver error (DrizzleQueryError, the cause below). */
const drizzleWrap = (cause: unknown) =>
  Object.assign(new Error('Failed query: select 1\nparams: '), {
    name: 'DrizzleQueryError',
    cause,
  });

const answer = async (err: unknown, method = 'GET') => {
  const res = await appAnswerOf(Promise.reject(err), 'http://localhost/api/tree', method);
  return { status: res.status, body: (await res.json()) as { error: string } };
};

describe('the busy answer', () => {
  it("a pool's wait run out on a read: 409 with the plain text, never the folders one", async () => {
    expect(await answer(drizzleWrap(new PoolBusyError()))).toEqual({
      status: 409,
      body: { error: POOL_BUSY_MESSAGE },
    });
    expect(await answer(new PoolBusyError(), 'POST')).toEqual({
      status: 409,
      body: { error: POOL_BUSY_MESSAGE },
    });
    expect(POOL_BUSY_MESSAGE).not.toBe(BUSY_MESSAGE);
  });

  it('another write holding the rows: the text it had', async () => {
    expect(await answer(new BusyError(), 'POST')).toEqual({
      status: 409,
      body: { error: SAVE_BUSY_MESSAGE },
    });
    const deadlock = Object.assign(new Error('deadlock detected'), {
      code: '40P01',
      severity: 'ERROR',
    });
    expect(await answer(drizzleWrap(deadlock), 'POST')).toEqual({
      status: 409,
      body: { error: BUSY_MESSAGE },
    });
  });
});
