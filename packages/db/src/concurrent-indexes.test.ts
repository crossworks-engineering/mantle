/**
 * ensureConcurrentIndexes never fails the migration runner when it is given
 * onError: a setup failure (no connection, a refused setting) is reported
 * like a failed build (W3 re-audit, info 5).
 */
import { describe, expect, it } from 'vitest';
import { ensureConcurrentIndexes } from './concurrent-indexes';

describe('ensureConcurrentIndexes setup failures', () => {
  const list = [{ name: 'x_idx', create: 'CREATE INDEX CONCURRENTLY x_idx ON t (a)' }];
  const broken = {
    reserve: async () => {
      throw new Error('too many clients');
    },
  };

  it('reports a failed setup through onError and returns failed', async () => {
    const seen: string[] = [];
    const out = await ensureConcurrentIndexes(broken as never, list, {
      onError: (name) => seen.push(name),
    });
    expect(out).toEqual({ x_idx: 'failed' });
    expect(seen).toEqual(['(setup)']);
  });

  it('throws without onError', async () => {
    await expect(ensureConcurrentIndexes(broken as never, list)).rejects.toThrow(
      'too many clients',
    );
  });
});

describe('ensureConcurrentIndexes on a connection that dies (reserved.ts)', () => {
  const list = [
    { name: 'a_idx', create: 'CREATE INDEX CONCURRENTLY a_idx ON t (a)' },
    { name: 'b_idx', create: 'CREATE INDEX CONCURRENTLY b_idx ON t (b)' },
  ];

  /** A reserved connection whose validity check fails with a connection
   *  error; records every statement and whether it went back. */
  function dyingPool() {
    const sent: string[] = [];
    let released = 0;
    const answer = (q: string) => {
      sent.push(q);
      const p = /indisvalid/.test(q)
        ? Promise.reject(Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED' }))
        : Promise.resolve([]);
      p.catch(() => {});
      return p;
    };
    const conn = Object.assign((strings: TemplateStringsArray) => answer(strings.join('?')), {
      unsafe: (q: string) => answer(q),
      release: () => (released += 1),
    });
    return { pool: { reserve: async () => conn }, sent, released: () => released };
  }

  it('a death during the validity check fails that index and the rest; nothing more is sent', async () => {
    const f = dyingPool();
    const seen: string[] = [];
    const out = await ensureConcurrentIndexes(f.pool as never, list, {
      onError: (name) => seen.push(name),
    });
    expect(out).toEqual({ a_idx: 'failed', b_idx: 'failed' });
    expect(seen).toEqual(['a_idx', 'b_idx']);
    // The setup and the one validity check; no reset, no second index.
    expect(f.sent).toHaveLength(2);
    expect(f.released()).toBe(0);
  });
});
