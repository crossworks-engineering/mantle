/**
 * The draw reader's image rule inside a turn scope (workspaces W4b fix round
 * 2), without a database: the scope's own row rules decide, and an unnamed
 * exit from the turn (TurnScopeExitError) reaches the caller instead of
 * turning into a drawing with no images. The rule on Postgres is in
 * server/web/lib/turn-gates.turn-scope.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fail: null as Error | null, systemCalls: 0 }));

vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  const rows = [{ fileRefs: { 'f-1': '11111111-1111-4111-8111-111111111111' } }];
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => {
      if (h.fail) throw h.fail;
      return rows;
    },
    then: (ok: (v: unknown) => unknown) => {
      if (h.fail) throw h.fail;
      return Promise.resolve([{ id: '11111111-1111-4111-8111-111111111111' }]).then(ok);
    },
  };
  return {
    ...real,
    inTurnScope: () => true,
    asSystem: vi.fn(async (fn: () => Promise<unknown>) => {
      h.systemCalls += 1;
      return fn();
    }),
    db: { select: () => chain },
  };
});

describe('readerVisibleFileIds in a turn scope', () => {
  beforeEach(() => {
    h.fail = null;
    h.systemCalls = 0;
  });

  it('reads by the scope, never on the system pool', async () => {
    const { readerVisibleFileIds } = await import('./draw-reader');
    const seen = await readerVisibleFileIds('o', 'd');
    expect([...(seen ?? [])]).toEqual(['f-1']);
    expect(h.systemCalls).toBe(0);
  });

  it('an unnamed exit from the turn is re-thrown, not an empty set', async () => {
    const { TurnScopeExitError } = await import('@mantle/db');
    const { readerVisibleFileIds } = await import('./draw-reader');
    h.fail = new TurnScopeExitError(undefined);
    await expect(readerVisibleFileIds('o', 'd')).rejects.toBeInstanceOf(TurnScopeExitError);
    // Any other failure still fails closed: no images.
    h.fail = new Error('boom');
    expect([...((await readerVisibleFileIds('o', 'd')) ?? ['all'])]).toEqual([]);
  });
});
