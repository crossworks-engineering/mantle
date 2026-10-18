/**
 * The fail-open count (plan v3.2 S4a): each of the six sites writes one
 * miss row per site and calling file, none under a system actor (or, for a
 * write, outside a scoped write), and a repeat hit takes no stack. The
 * answers stay what they were: every cell checks the site's answer too.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginActor, runAsActor, runAsSystem, runWithoutActor } from './actor';
import { closeDb, db, scopeHasArea, scopeHoldsAdmin } from './client';
import {
  noteFailOpen,
  resetFailOpenForTest,
  setFailOpenWriter,
  takeFailOpenHits,
  type FailOpenRow,
} from './fail-open';
import { actorCheckMisses, nodes } from './schema';
import {
  asSystem,
  assertSystemDbCaller,
  enterRequestScope,
  runInRequestSlot,
  runInTurnScope,
} from './viewer';

const LOGIN = '00000000-0000-4000-8000-0000000000c1';
const WS = '00000000-0000-4000-8000-0000000000c2';

let rows: FailOpenRow[] = [];
beforeEach(() => {
  resetFailOpenForTest();
  rows = [];
  setFailOpenWriter((hit) => rows.push(hit) > 0);
});
afterEach(() => {
  vi.restoreAllMocks();
  takeFailOpenHits();
});
afterAll(() => closeDb());

describe('noteFailOpen: one row per site and calling file, the lookup before the stack', () => {
  it('a repeat hit takes no stack and writes no row', () => {
    const caller = vi.fn(() => '/app/lib/a.ts');
    noteFailOpen('scope-holds-admin', '', caller);
    noteFailOpen('scope-holds-admin', '', caller);
    noteFailOpen('scope-holds-admin', '', caller);
    expect(caller).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([
      { source: 'ts', check: 'fail-open:scope-holds-admin', actor: '', detail: '/app/lib/a.ts' },
    ]);
  });

  it('a site takes one stack a minute: a second caller then gets its row, the same one does not', () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    noteFailOpen('scope-has-area', 'login', () => '/app/lib/a.ts');
    now += 61_000;
    noteFailOpen('scope-has-area', 'login', () => '/app/lib/b.ts');
    now += 61_000;
    const again = vi.fn(() => '/app/lib/b.ts');
    noteFailOpen('scope-has-area', 'login', again);
    expect(again).toHaveBeenCalledTimes(1);
    expect(rows.map((r) => r.detail)).toEqual(['/app/lib/a.ts', '/app/lib/b.ts']);
  });

  it('the same site and file write again after an hour (the box window)', () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    noteFailOpen('turn-exit', 'login', () => '/app/lib/a.ts');
    now += 30 * 60_000;
    noteFailOpen('turn-exit', 'login', () => '/app/lib/a.ts');
    expect(rows).toHaveLength(1);
    now += 31 * 60_000;
    noteFailOpen('turn-exit', 'login', () => '/app/lib/a.ts');
    expect(rows.map((r) => r.detail)).toEqual(['/app/lib/a.ts', '/app/lib/a.ts']);
  });

  it('a hit no writer took is not marked: a later hit writes it', () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    setFailOpenWriter(() => false); // before the pool sets its writer
    noteFailOpen('system-db', 'login', () => '/app/lib/a.ts');
    setFailOpenWriter((hit) => rows.push(hit) > 0);
    now += 61_000;
    noteFailOpen('system-db', 'login', () => '/app/lib/a.ts');
    expect(rows).toEqual([expect.objectContaining({ detail: '/app/lib/a.ts' })]);
  });

  it('each site keeps its own lookup', () => {
    noteFailOpen('typed-write', 'login', () => '/app/lib/a.ts', 'public.x');
    noteFailOpen('raw-write', 'login', () => '/app/lib/a.ts', 'public.x');
    expect(rows.map((r) => r.check)).toEqual(['fail-open:typed-write', 'fail-open:raw-write']);
  });

  it('no app frame on the stack: a write names its table', () => {
    noteFailOpen('raw-write', 'login', () => null, 'public.x');
    noteFailOpen('scope-holds-admin', '', () => null);
    expect(rows.map((r) => r.detail)).toEqual(['unknown caller, table public.x', 'unknown caller']);
  });

  it('under vitest every hit is kept with its table, before the lookup; none fails the test', () => {
    noteFailOpen('typed-write', 'login', () => 'a.ts', 'public.x');
    noteFailOpen('typed-write', 'login', () => 'a.ts', 'public.y');
    expect(takeFailOpenHits()).toEqual([
      { site: 'typed-write', actor: 'login', table: 'public.x' },
      { site: 'typed-write', actor: 'login', table: 'public.y' },
    ]);
  });
});

describe('scopeHoldsAdmin outside every scope (site scope-holds-admin)', () => {
  it('no actor: yes, as before, counted once', async () => {
    await runWithoutActor(async () => {
      expect(await scopeHoldsAdmin()).toBe(true);
      expect(await scopeHoldsAdmin()).toBe(true);
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ check: 'fail-open:scope-holds-admin', actor: '' });
    expect(rows[0]!.detail).toMatch(/fail-open\.test\.ts$/);
  });

  it('a login actor with no scope: yes, as before, counted', async () => {
    await runAsActor(loginActor(LOGIN), async () => {
      expect(await scopeHoldsAdmin()).toBe(true);
    });
    expect(rows).toEqual([
      expect.objectContaining({ check: 'fail-open:scope-holds-admin', actor: 'login' }),
    ]);
  });

  it('a system actor: yes, the intended route, not counted', async () => {
    await runAsSystem('worker:fail-open-test', async () => {
      expect(await scopeHoldsAdmin()).toBe(true);
    });
    expect(rows).toEqual([]);
    expect(takeFailOpenHits()).toEqual([]);
  });
});

describe("scopeHasArea's system case (site scope-has-area)", () => {
  it('no actor: yes, as before, counted once', async () => {
    await runWithoutActor(async () => {
      expect(await scopeHasArea('users')).toBe(true);
      expect(await scopeHasArea('settings')).toBe(true);
    });
    expect(rows).toEqual([
      expect.objectContaining({ check: 'fail-open:scope-has-area', actor: '' }),
    ]);
  });

  it('a system actor: yes, not counted; an unknown area: no, not counted', async () => {
    await runAsSystem('worker:fail-open-test', async () => {
      expect(await scopeHasArea('users')).toBe(true);
    });
    await runWithoutActor(async () => {
      expect(await scopeHasArea('nope' as never)).toBe(false);
    });
    expect(rows).toEqual([]);
  });
});

/** Run `fn` in a login's mutating request scope (W6a), as the session
 *  guard leaves it. */
function inWriteRequest<T>(fn: () => Promise<T>): Promise<T> {
  return runInRequestSlot(async () => {
    const scope = Object.freeze({
      kind: 'user' as const,
      loginId: LOGIN,
      ws: Object.freeze([WS]),
      modWs: Object.freeze([]),
    });
    expect(enterRequestScope(scope, { writes: true, drafts: false })).toBe(true);
    return fn();
  });
}

/** Call `fn`, which may throw when no database is set (the unit run). */
function tryIt(fn: () => unknown): void {
  try {
    fn();
  } catch {
    // DATABASE_URL unset: the pool is not made; the hit is noted first.
  }
}

describe('a scoped typed write to a table the write role does not hold (site typed-write)', () => {
  it('counted once per calling file, with its table in the tests list', async () => {
    await inWriteRequest(async () => {
      tryIt(() => db.insert(actorCheckMisses));
      tryIt(() => db.delete(actorCheckMisses));
    });
    expect(rows).toEqual([
      expect.objectContaining({ check: 'fail-open:typed-write', actor: 'login' }),
    ]);
    expect(takeFailOpenHits()).toEqual([
      { site: 'typed-write', actor: 'login', table: 'public.actor_check_misses' },
      { site: 'typed-write', actor: 'login', table: 'public.actor_check_misses' },
    ]);
  });

  it('a write-role table is not counted; nor is a write with no request scope', async () => {
    await inWriteRequest(async () => {
      tryIt(() => db.insert(nodes));
    });
    await runAsSystem('worker:fail-open-test', async () => {
      tryIt(() => db.insert(actorCheckMisses));
    });
    expect(rows).toEqual([]);
    expect(takeFailOpenHits()).toEqual([]);
  });
});

// The raw write site (loginWriteClient) needs a database: fail-open.db.test.ts.

describe('the production allows in a turn scope (sites turn-exit, system-db)', () => {
  const scope = Object.freeze({
    kind: 'assistant' as const,
    loginId: null,
    ws: Object.freeze([WS]),
    modWs: Object.freeze([]),
  });
  const inTurn = <T>(fn: () => Promise<T>) => runInTurnScope(scope, fn);
  const nodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = nodeEnv;
  });

  it('an unlisted asSystem exit in production: allowed, as before, counted once', async () => {
    process.env.NODE_ENV = 'production';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(inTurn(() => asSystem(async () => 1, undefined as never))).resolves.toBe(1);
    await expect(inTurn(() => asSystem(async () => 2, undefined as never))).resolves.toBe(2);
    expect(rows).toEqual([
      expect.objectContaining({ check: 'fail-open:turn-exit', actor: 'assistant' }),
    ]);
    expect(rows[0]!.detail).toMatch(/fail-open\.test\.ts$/);
  });

  it('an off-list systemDb caller in production: allowed, as before, counted once', async () => {
    process.env.NODE_ENV = 'production';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stack = 'Error\n    at f (/app/server/web/lib/somewhere.ts:1:1)';
    await inTurn(async () => {
      expect(assertSystemDbCaller(stack)).toBeUndefined();
      expect(assertSystemDbCaller(stack)).toBeUndefined();
    });
    expect(rows).toEqual([
      {
        source: 'ts',
        check: 'fail-open:system-db',
        actor: 'assistant',
        detail: '/app/server/web/lib/somewhere.ts',
      },
    ]);
  });

  it('in tests both still throw, and nothing is counted', async () => {
    await expect(inTurn(() => asSystem(async () => 1, undefined as never))).rejects.toThrow();
    await expect(
      inTurn(async () => assertSystemDbCaller('Error\n    at f (/app/x/y.ts:1:1)')),
    ).rejects.toThrow();
    expect(rows).toEqual([]);
  });
});
