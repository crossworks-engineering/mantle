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
