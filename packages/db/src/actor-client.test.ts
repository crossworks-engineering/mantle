/**
 * Which statements the system pool sends outside a transaction block, with
 * no actor set (arch A2a fix round, M3b): Postgres refuses them inside one.
 */
import { describe, expect, it } from 'vitest';
import { actorCheckMode, noteBoxActorCheckMode, runAsSystem } from './actor';
import {
  actorClient,
  actorInTransaction,
  closeDb,
  needsActorWrap,
  refreshActorCheckMode,
  runsOutsideTransaction,
  setActorSql,
} from './client';

type PgSql = Parameters<typeof actorInTransaction>[0];

/** A stand-in for a postgres.js transaction: a statement is "sent" when its
 *  `then` is first called (postgres.js is lazy the same way), and every
 *  answer is held until `release()`. */
function fakeTx(fail: Record<string, Error> = {}) {
  const sent: string[] = [];
  const held: (() => void)[] = [];
  const query = (text: string) => {
    let p: Promise<unknown> | null = null;
    const run = () =>
      (p ??= new Promise((resolve, reject) => {
        sent.push(text);
        held.push(() => {
          const err = Object.entries(fail).find(([k]) => text.includes(k))?.[1];
          if (err) reject(err);
          else resolve([{ text }]);
        });
      }));
    const q: Record<string, unknown> = {
      then: (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
      values: () => q,
      simple: () => q,
    };
    return q;
  };
  const t = { unsafe: (text: string) => query(text) } as unknown as PgSql;
  return { t, sent, release: () => held.splice(0).forEach((f) => f()) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const PARAMS: [string, string, string] = ['system:worker:test', 'rw', 'warn'];

describe('runsOutsideTransaction', () => {
  it('finds them after comments, whitespace and SET statements', () => {
    for (const q of [
      'vacuum analyze nodes',
      '  -- a note\n/* more */ VACUUM nodes',
      "set statement_timeout = '0'; vacuum nodes",
      'create index concurrently x on nodes (id)',
      'drop index concurrently x',
      'reindex database brain',
      'REINDEX (VERBOSE) SCHEMA public',
      'reindex system brain',
      'reindex index concurrently x',
      'call mantle_backfill()',
      'create database x',
      'alter system set work_mem = 1',
      'discard all',
    ]) {
      expect(runsOutsideTransaction(q), q).toBe(true);
    }
  });

  it('leaves everything else in its transaction', () => {
    for (const q of [
      'select 1',
      'insert into nodes default values',
      'reindex table nodes',
      'set transaction read only',
      "select 'vacuum'",
      '-- vacuum\nselect 1',
    ]) {
      expect(runsOutsideTransaction(q), q).toBe(false);
    }
  });
});

describe('needsActorWrap (owner decision: writes and unknown verbs only)', () => {
  it('runs reads plain', () => {
    for (const q of [
      'select 1',
      '  -- a note\nSELECT * from nodes',
      'with x as (select 1) select * from x',
      'values (1)',
      'show work_mem',
      'explain select 1',
      'select mantle_ws_private_workspace($1)',
    ]) {
      expect(needsActorWrap(q), q).toBe(false);
    }
  });

  it('wraps writes, a writing WITH and anything it cannot name', () => {
    for (const q of [
      'insert into nodes default values',
      '/* x */ update nodes set title = $1',
      'delete from nodes',
      'merge into nodes using x on true when matched then do nothing',
      'truncate nodes',
      'copy nodes from stdin',
      'with u as (update nodes set title = title returning id) select * from u',
      'with x as (select 1) insert into t select * from x',
      'explain analyze delete from nodes',
      'lock table nodes',
      'frobnicate',
    ]) {
      expect(needsActorWrap(q), q).toBe(true);
    }
  });

  it('wraps a WITH that names a write verb anywhere (fix round 2, L4)', () => {
    for (const q of [
      // A quoted table name, an alias with AS, ONLY: the old shape missed them.
      'with u as (update "public"."nodes" as n set title = title returning n.id) select * from u',
      'with u as (update only nodes set title = title returning id) select 1',
      'with d as (delete from only nodes returning id) select count(*) from d',
      'with m as (merge into t using s on true when matched then delete) select 1',
      // A false match only costs the wrap.
      'with x as (select "insert" from t) select 1',
    ]) {
      expect(needsActorWrap(q), q).toBe(true);
    }
    // A word that only contains a verb is not one.
    expect(needsActorWrap('with x as (select updated_at, insert_count from t) select 1')).toBe(
      false,
    );
  });

  it('wraps EXPLAIN ANALYZE and EXPLAIN ANALYSE (fix round 2, L4)', () => {
    for (const q of [
      'explain analyze select 1',
      'explain analyse select 1',
      'EXPLAIN (ANALYZE, BUFFERS) select 1',
      'explain (analyse true) update nodes set title = title',
    ]) {
      expect(needsActorWrap(q), q).toBe(true);
    }
    expect(needsActorWrap('explain (costs off) select 1')).toBe(false);
  });

  it('wraps more than one statement: unknown (fix round 2, L4)', () => {
    for (const q of [
      'select 1; delete from nodes',
      'select 1;update nodes set title = title',
      'show work_mem; select 1',
    ]) {
      expect(needsActorWrap(q), q).toBe(true);
    }
    // A trailing semicolon is still one statement.
    expect(needsActorWrap('select 1;')).toBe(false);
    expect(needsActorWrap('select 1;  \n')).toBe(false);
  });
});

describe('the actor SET in a transaction (fix round 2: pipelined)', () => {
  it('sends the SET and the first statement before either is answered: one round trip', async () => {
    const f = fakeTx();
    const tx = actorInTransaction(f.t, PARAMS);
    const done = Promise.resolve(tx.unsafe('select 1'));
    await tick();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[0]).toMatch(/set_config\('mantle\.actor'/);
    expect(f.sent[1]).toBe('select 1');
    f.release();
    await expect(done).resolves.toEqual([{ text: 'select 1' }]);
    // Later statements run plain: no second SET.
    const next = Promise.resolve(tx.unsafe('select 2'));
    await tick();
    f.release();
    await next;
    expect(f.sent.slice(2)).toEqual(['select 2']);
  });

  it('keeps SET TRANSACTION first, then sets the actor with the next statement', async () => {
    const f = fakeTx();
    const tx = actorInTransaction(f.t, PARAMS);
    const first = Promise.resolve(tx.unsafe('set transaction read only'));
    await tick();
    expect(f.sent).toEqual(['set transaction read only']);
    f.release();
    await first;
    const q = Promise.resolve(tx.unsafe('select 1'));
    await tick();
    expect(f.sent[1]).toMatch(/set_config\('mantle\.actor'/);
    expect(f.sent[2]).toBe('select 1');
    f.release();
    await q;
  });

  it("reports the SET's own error, not the statement's follow-on; nothing unhandled", async () => {
    const f = fakeTx({
      set_config: new Error('the SET failed'),
      'select 1': new Error('current transaction is aborted'),
    });
    const tx = actorInTransaction(f.t, PARAMS);
    const done = Promise.resolve(tx.unsafe('select 1'));
    await tick();
    f.release();
    await expect(done).rejects.toThrow('the SET failed');
  });

  it("a statement sent in parallel with the first reports the SET's error too (A2b)", async () => {
    const f = fakeTx({
      set_config: new Error('the SET failed'),
      'select ': new Error('current transaction is aborted'),
    });
    const tx = actorInTransaction(f.t, PARAMS);
    const one = Promise.resolve(tx.unsafe('select 1'));
    const two = Promise.resolve(tx.unsafe('select 2'));
    await tick();
    // One SET, both statements behind it in the same send.
    expect(f.sent).toHaveLength(3);
    expect(f.sent.filter((s) => s.includes('set_config'))).toHaveLength(1);
    f.release();
    await expect(one).rejects.toThrow('the SET failed');
    await expect(two).rejects.toThrow('the SET failed');
  });

  it('sets the actor before a savepoint opened first, in the same send', async () => {
    const f = fakeTx();
    const raw = f.t as unknown as { unsafe: (q: string) => PromiseLike<unknown> };
    // postgres.js sends SAVEPOINT, then runs the callback.
    const savepoint = (fn: () => unknown) => Promise.resolve(raw.unsafe('savepoint s1')).then(fn);
    const tx = actorInTransaction(Object.assign(f.t, { savepoint }), PARAMS) as unknown as {
      savepoint: (fn: () => unknown) => Promise<unknown>;
    };
    const done = tx.savepoint(() => 'inner');
    await tick();
    expect(f.sent[0]).toMatch(/set_config\('mantle\.actor'/);
    expect(f.sent[1]).toBe('savepoint s1');
    f.release();
    await expect(done).resolves.toBe('inner');
  });
});

describe('setActorSql checks each value before it inlines it (A2b)', () => {
  it('takes the values actor.ts makes', () => {
    expect(setActorSql(['login:rw:0f0e0d0c-0b0a-4908-8706-050403020100', 'ro', 'off'])).toContain(
      "'login:rw:0f0e0d0c-0b0a-4908-8706-050403020100'",
    );
    expect(setActorSql(['system:repair:page-block-ids', 'rw', 'on'])).toContain("'on'");
  });

  it('refuses any other shape, so nothing reaches the literal', () => {
    for (const bad of ["x'; drop table nodes; --", 'a b', '', 'a\0b', 'x'.repeat(201)]) {
      expect(() => setActorSql([bad, 'rw', 'warn']), JSON.stringify(bad)).toThrow(/not an actor/);
    }
    expect(() => setActorSql(['link', 'RW', 'warn'])).toThrow(/write mode/);
    expect(() => setActorSql(['link', "rw'", 'warn'])).toThrow(/write mode/);
    expect(() => setActorSql(['link', 'ro', 'strict'])).toThrow(/check mode/);
  });

  it('a refused value sends nothing in a transaction', async () => {
    const f = fakeTx();
    const tx = actorInTransaction(f.t, ["no'pe", 'rw', 'warn']);
    await expect(Promise.resolve().then(() => tx.unsafe('select 1'))).rejects.toThrow(
      /not an actor/,
    );
    await tick();
    expect(f.sent).toEqual([]);
  });
});

describe('the box mode read (fix round 2, L2 and L8)', () => {
  const failing = (code: string) =>
    ({
      unsafe: () => Promise.reject(Object.assign(new Error(code), { code })),
    }) as unknown as PgSql;
  const withEnvOff = async (fn: () => Promise<void>) => {
    const own = process.env.MANTLE_ACTOR_CHECK;
    process.env.MANTLE_ACTOR_CHECK = 'off';
    try {
      await fn();
    } finally {
      await closeDb();
      if (own === undefined) delete process.env.MANTLE_ACTOR_CHECK;
      else process.env.MANTLE_ACTOR_CHECK = own;
    }
  };

  it('keeps the last mode on a failed read; off only when the function is missing', () =>
    withEnvOff(async () => {
      noteBoxActorCheckMode('warn');
      refreshActorCheckMode(failing('57P01'));
      await tick();
      expect(actorCheckMode()).toBe('warn');
      refreshActorCheckMode(failing('42883'));
      await tick();
      expect(actorCheckMode()).toBe('off');
    }));

  it('a read that lands after closeDb does not set the next pool’s mode', () =>
    withEnvOff(async () => {
      let answer: (rows: unknown) => void = () => {};
      const slow = { unsafe: () => new Promise((r) => (answer = r)) } as unknown as PgSql;
      refreshActorCheckMode(slow);
      await closeDb();
      answer([{ m: 'warn' }]);
      await tick();
      expect(actorCheckMode()).toBe('off');
    }));
});

describe('the first mode read (A2b, the startup race)', () => {
  /** A pool whose mode read is held until `answer`; every other statement
   *  is recorded and answers at once. */
  function fakePool() {
    const sent: string[] = [];
    let answer: (rows: unknown) => void = () => {};
    const ok = (q: string) => {
      sent.push(q);
      const p = Promise.resolve([] as unknown[]);
      return Object.assign(p, { values: () => p, simple: () => p });
    };
    const base = {
      unsafe: (q: string) =>
        q.includes('mantle_actor_check_mode') ? new Promise((r) => (answer = r)) : ok(q),
      reserve: async () => ({ unsafe: (q: string) => ok(`conn: ${q}`), release: () => {} }),
      end: async () => {},
    } as unknown as PgSql;
    return { base, sent, answer: (m: string) => answer([{ m }]) };
  }

  it('a write with an actor waits for it and then sets the actor; a read does not wait', async () => {
    const own = process.env.MANTLE_ACTOR_CHECK;
    process.env.MANTLE_ACTOR_CHECK = 'off';
    const f = fakePool();
    globalThis.__mantleSql = f.base;
    try {
      refreshActorCheckMode(f.base);
      const client = actorClient(f.base);
      const write = runAsSystem('worker:test', () =>
        Promise.resolve(client.unsafe('insert into t values (1)')),
      );
      const read = runAsSystem('worker:test', () => Promise.resolve(client.unsafe('select 1')));
      await read;
      await tick();
      // The read went at once; the write waits for the box's mode.
      expect(f.sent).toEqual(['select 1']);
      f.answer('warn');
      await write;
      expect(f.sent.some((q) => /^conn: .*set_config\('mantle\.actor'/.test(q))).toBe(true);
      expect(f.sent).toContain('conn: insert into t values (1)');
      // Answered: nothing waits again, and off runs plain.
      noteBoxActorCheckMode('off');
      await runAsSystem('worker:test', () =>
        Promise.resolve(client.unsafe('insert into t values (2)')),
      );
      expect(f.sent.at(-1)).toBe('insert into t values (2)');
    } finally {
      await closeDb();
      if (own === undefined) delete process.env.MANTLE_ACTOR_CHECK;
      else process.env.MANTLE_ACTOR_CHECK = own;
    }
  });
});
