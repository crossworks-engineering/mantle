// The brain id reader (lib/brain-identity.ts): read once per process, a hand
// deleted row is made again, a failed read is never remembered, and the
// "or null" reader that whoami and the push path use says so once and lets
// them go on. The database is a stand-in; the real table and its migration
// are checked in packages/db/src/brain-identity-migration.db.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** One entry per select: the rows it answers, or an error it throws. */
  selects: [] as Array<unknown[] | Error>,
  inserts: 0,
}));

vi.mock('@mantle/db', () => {
  const selectChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'limit']) chain[m] = () => chain;
    chain['then'] = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      const next = h.selects.shift() ?? [];
      return next instanceof Error ? reject(next) : resolve(next);
    };
    return chain;
  };
  return {
    brainIdentity: { brainId: 'brain_identity.brain_id' },
    db: {
      select: () => selectChain(),
      insert: () => ({
        values: () => ({
          onConflictDoNothing: async () => {
            h.inserts++;
          },
        }),
      }),
    },
  };
});

import { brainIdOrNull, getBrainId, resetBrainIdCache } from './brain-identity';

const ID = '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f';

beforeEach(() => {
  h.selects = [];
  h.inserts = 0;
  resetBrainIdCache();
});

describe('getBrainId', () => {
  it('reads the row once per process', async () => {
    h.selects = [[{ brainId: ID }]];
    expect(await getBrainId()).toBe(ID);
    expect(await getBrainId()).toBe(ID);
    expect(h.selects).toHaveLength(0);
    expect(h.inserts).toBe(0);
  });

  it('makes the row again when it was deleted by hand, and reads what stands', async () => {
    h.selects = [[], [{ brainId: ID }]];
    expect(await getBrainId()).toBe(ID);
    expect(h.inserts).toBe(1);
  });

  it('never remembers a failed read', async () => {
    h.selects = [new Error('relation "brain_identity" does not exist'), [{ brainId: ID }]];
    await expect(getBrainId()).rejects.toThrow('brain_identity');
    expect(await getBrainId()).toBe(ID);
  });
});

describe('brainIdOrNull', () => {
  it('answers the id', async () => {
    h.selects = [[{ brainId: ID }]];
    expect(await brainIdOrNull()).toBe(ID);
  });

  it('answers null and says so once when the table is not there (database behind the code)', async () => {
    const loud = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.selects = [new Error('relation "brain_identity" does not exist'), new Error('again')];
    expect(await brainIdOrNull()).toBeNull();
    expect(await brainIdOrNull()).toBeNull();
    expect(loud).toHaveBeenCalledTimes(1);
    expect(String(loud.mock.calls[0]![0])).toContain('0226_brain_identity');
    // Once the migration lands, the next call reads it.
    h.selects = [[{ brainId: ID }]];
    expect(await brainIdOrNull()).toBe(ID);
    loud.mockRestore();
  });
});
