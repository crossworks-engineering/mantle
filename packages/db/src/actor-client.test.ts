/**
 * Which statements the system pool sends outside a transaction block, with
 * no actor set (arch A2a fix round, M3b): Postgres refuses them inside one.
 */
import { describe, expect, it } from 'vitest';
import { actorCheckMode, noteBoxActorCheckMode, runAsActor, runAsSystem } from './actor';
import { END_SESSION_SQL } from './reserved';
import {
  actorClient,
  actorInTransaction,
  closeDb,
  needsActorWrap,
  refreshActorCheckMode,
  runsOutsideTransaction,
  setActorSql,
  writeRoleSettingsSql,
} from './client';
import { statementBody, workResult } from './gateway/actor-sql';

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

  it('reads the leading comments and SETs as Postgres does (sql-text.ts)', () => {
    // Block comments nest: the whole of the first is a comment.
    expect(statementBody('/* a /* b */ select */ vacuum', false)).toBe('vacuum');
    expect(runsOutsideTransaction('/* a /* b */ select */ vacuum')).toBe(true);
    expect(runsOutsideTransaction('/* a /* b */ vacuum */ select 1')).toBe(false);
    // A `--` comment a carriage return ends.
    expect(statementBody('--x\rvacuum', false)).toBe('vacuum');
    // A `;` in a string or a dollar quote (a tag of any name characters)
    // ends no SET.
    expect(statementBody("set my.x = 'a;b'; vacuum", true)).toBe('vacuum');
    expect(statementBody('set my.x = $é$;$é$; vacuum', true)).toBe('vacuum');
    expect(runsOutsideTransaction('set my.x = $é$;$é$; vacuum')).toBe(true);
    expect(statementBody('set my.x = $é$; vacuum $é$; select 1', true)).toBe('select 1');
    expect(runsOutsideTransaction('set my.x = $é$; vacuum $é$; select 1')).toBe(false);
    // SET TRANSACTION and a SET with no end are kept.
    expect(statementBody('set transaction read only; select 1', true)).toBe(
      'set transaction read only; select 1',
    );
    expect(statementBody('set x = 1', true)).toBe('set x = 1');
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

describe('a transaction client sends in the order its statements are awaited', () => {
  /** fakeTx with tagged templates too (sent, like the rest, on `then`). */
  function taggedFake() {
    const f = fakeTx();
    const unsafe = (f.t as unknown as { unsafe: (q: string) => unknown }).unsafe;
    const t = Object.assign((strings: TemplateStringsArray) => unsafe(strings.join('$1')), {
      unsafe,
    }) as unknown as PgSql;
    return { ...f, t };
  }

  it('builds without sending: values(), simple() and a tagged template send on their first then', async () => {
    const f = taggedFake();
    const tx = actorInTransaction(f.t, PARAMS) as unknown as PgSql & {
      unsafe: (q: string) => { values: () => unknown; simple: () => unknown };
    };
    const a = tx.unsafe('select 1').simple();
    const b = tx.unsafe('select 2').values();
    const c = tx`select 3`;
    await tick();
    expect(f.sent).toEqual([]);
    const all = Promise.all([c, b, a]);
    await tick();
    expect(f.sent.slice(1)).toEqual(['select 3', 'select 2', 'select 1']);
    expect(f.sent[0]).toMatch(/set_config\('mantle\.actor'/);
    f.release();
    await tick();
    f.release();
    await all;
  });

  it('a SET TRANSACTION awaited first goes out first, then the SET, then the rest in order', async () => {
    const f = taggedFake();
    const tx = actorInTransaction(f.t, PARAMS) as unknown as PgSql & {
      unsafe: (
        q: string,
      ) => PromiseLike<unknown> & { simple: () => unknown; values: () => unknown };
    };
    const all = Promise.all([
      tx.unsafe('set transaction read only'),
      tx.unsafe('select 1').simple(),
      tx.unsafe('select 2').values(),
      tx`select 3`,
      tx.unsafe('select 4'),
    ]);
    await tick();
    expect(f.sent[0]).toBe('set transaction read only');
    expect(f.sent[1]).toMatch(/set_config\('mantle\.actor'/);
    expect(f.sent.slice(2)).toEqual(['select 1', 'select 2', 'select 3', 'select 4']);
    for (let i = 0; i < 3; i++) {
      f.release();
      await tick();
    }
    await all;
  });
});

describe("a begin's work that returns an array of statements", () => {
  /** A base whose begin reads its work's value as postgres.js does (an
   *  array is sent and awaited together before the COMMIT), and whose
   *  statements are sent on their first then. */
  function arrayBase() {
    const sent: string[] = [];
    const q = (text: string) => ({
      then: (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
        sent.push(text);
        return Promise.resolve([{ text }]).then(ok, bad);
      },
    });
    const t = { unsafe: (text: string) => q(text) } as unknown as PgSql;
    const base = {
      begin: async (fn: (t: PgSql) => unknown) => {
        sent.push('begin');
        const x = fn(t);
        const out = await Promise.resolve(Array.isArray(x) ? Promise.all(x) : x);
        sent.push('commit');
        return out;
      },
    } as unknown as PgSql;
    return { base, t, sent };
  }

  it('workResult sends an array together, in its order, and passes any other value on', async () => {
    const { t, sent } = arrayBase();
    expect(await workResult([t.unsafe('a'), t.unsafe('b')])).toEqual([
      [{ text: 'a' }],
      [{ text: 'b' }],
    ]);
    expect(sent).toEqual(['a', 'b']);
    expect(workResult(7)).toBe(7);
  });

  it("the system pool's begin sends both statements before the COMMIT and answers their results", async () => {
    const { base, sent } = arrayBase();
    const client = actorClient(base);
    const begin = client.begin as unknown as (fn: (t: PgSql) => unknown) => Promise<unknown>;
    const out = await begin((t) => [
      t.unsafe('insert into t values (1)'),
      t.unsafe('insert into t values (2)'),
    ]);
    // With the actor check on, the actor's SET goes with the first
    // statement; with it off (test:actor-off), none is sent.
    const actorSet = /set_config\('mantle\.actor'/;
    expect(sent.filter((q) => !actorSet.test(q))).toEqual([
      'begin',
      'insert into t values (1)',
      'insert into t values (2)',
      'commit',
    ]);
    expect(sent.filter((q) => actorSet.test(q)).length).toBeLessThanOrEqual(1);
    expect(out).toEqual([
      [{ text: 'insert into t values (1)' }],
      [{ text: 'insert into t values (2)' }],
    ]);
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
    // The acting login of an exit (plan v3.2 S7b): a uuid only.
    const L = '0f0e0d0c-0b0a-4908-8706-050403020100';
    expect(setActorSql(['system:http:admin-area', 'rw', 'off', undefined, L])).toContain(
      `set_config('mantle.acting_login', '${L}', true)`,
    );
    expect(() => setActorSql(['system:x', 'rw', 'off', undefined, "x'; reset role"])).toThrow(
      /acting login/,
    );
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

describe('a write outside a transaction (A2b1 audit, Q1): SET, write, RESET', () => {
  /** A pool whose reserved connection holds the RESET's answer until
   *  `answerReset`, and records what is sent and when it is released. */
  function resetPool(
    o: { failReset?: boolean; killed?: boolean; failWrite?: boolean; throwWrite?: boolean } = {},
  ) {
    const sent: string[] = [];
    let released = false;
    let reserved = 0;
    let answerReset: () => void = () => {};
    const stmt = (q: string) => {
      sent.push(q);
      let p: Promise<unknown>;
      if (q.startsWith('/* mantle:actor */ reset')) {
        p = new Promise((ok, bad) => {
          answerReset = () =>
            o.killed
              ? bad(Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED' }))
              : o.failReset
                ? bad(new Error('reset failed'))
                : ok([]);
        });
      } else if (o.throwWrite && q.startsWith('insert')) {
        throw new Error('write would not build');
      } else if (o.failWrite && q.startsWith('insert')) {
        p = Promise.reject(new Error('write failed'));
      } else {
        p = Promise.resolve([{ q }]);
      }
      p.catch(() => {});
      return Object.assign(p, { values: () => p, simple: () => p });
    };
    const conn = { unsafe: (q: string) => stmt(q), release: () => (released = true) };
    const base = {
      unsafe: (q: string) =>
        q.includes('mantle_actor_check_mode')
          ? Promise.resolve([{ m: 'warn' }])
          : stmt(`pool: ${q}`),
      reserve: async () => {
        reserved += 1;
        return conn;
      },
      end: async () => {},
    } as unknown as PgSql;
    return {
      base,
      sent,
      released: () => released,
      reserved: () => reserved,
      answerReset: () => answerReset(),
    };
  }

  const inWarn = async (base: PgSql, fn: () => Promise<void>) => {
    const own = process.env.MANTLE_ACTOR_CHECK;
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    globalThis.__mantleSql = base;
    try {
      await fn();
    } finally {
      await closeDb();
      if (own === undefined) delete process.env.MANTLE_ACTOR_CHECK;
      else process.env.MANTLE_ACTOR_CHECK = own;
    }
  };

  it('the caller has the write’s answer before the RESET answers; the connection waits for it', () => {
    const f = resetPool();
    return inWarn(f.base, async () => {
      const client = actorClient(f.base);
      const r = await runAsSystem('worker:test', () =>
        Promise.resolve(client.unsafe('insert into t values (1)')),
      );
      expect(r).toEqual([{ q: 'insert into t values (1)' }]);
      expect(f.sent[0]).toMatch(/set_config\('mantle\.actor', 'system:worker:test', false\)/);
      expect(f.sent[1]).toBe('insert into t values (1)');
      expect(f.sent[2]).toMatch(
        /reset mantle\.actor; reset mantle\.write_mode; reset mantle\.actor_check/,
      );
      expect(f.sent.some((q) => /\b(begin|commit)\b/i.test(q))).toBe(false);
      expect(f.released()).toBe(false);
      f.answerReset();
      await tick();
      expect(f.released()).toBe(true);
    });
  });

  it('a failed write is reported, and the RESET still runs', () => {
    const f = resetPool({ failWrite: true });
    return inWarn(f.base, async () => {
      const client = actorClient(f.base);
      await expect(
        runAsSystem('worker:test', () =>
          Promise.resolve(client.unsafe('insert into t values (1)')),
        ),
      ).rejects.toThrow('write failed');
      expect(f.sent.at(-1)).toMatch(/^\/\* mantle:actor \*\/ reset/);
      f.answerReset();
      await tick();
      expect(f.released()).toBe(true);
    });
  });

  it('a failed RESET ends the connection, which never goes back', () => {
    const f = resetPool({ failReset: true });
    return inWarn(f.base, async () => {
      const client = actorClient(f.base);
      await runAsSystem('worker:test', () =>
        Promise.resolve(client.unsafe('insert into t values (1)')),
      );
      f.answerReset();
      await tick();
      await tick();
      expect(f.sent).toContain(END_SESSION_SQL);
      expect(f.released()).toBe(false);
    });
  });

  it('a connection that died under the RESET: nothing more is sent, it never goes back', () => {
    const f = resetPool({ killed: true });
    return inWarn(f.base, async () => {
      const client = actorClient(f.base);
      await runAsSystem('worker:test', () =>
        Promise.resolve(client.unsafe('insert into t values (1)')),
      );
      f.answerReset();
      await tick();
      await tick();
      expect(f.sent.at(-1)).toMatch(/^\/\* mantle:actor \*\/ reset/);
      expect(f.released()).toBe(false);
    });
  });

  it('a value the SET refuses fails the caller and takes no connection (A2b1 fix round 2, L1)', () => {
    const f = resetPool();
    return inWarn(f.base, async () => {
      const client = actorClient(f.base);
      const bad = { kind: 'login', mode: 'rw', loginId: "x' or true" } as never;
      await expect(
        runAsActor(bad, () => Promise.resolve(client.unsafe('insert into t values (1)'))),
      ).rejects.toThrow(/not an actor/);
      expect(f.reserved()).toBe(0);
      expect(f.sent).toEqual([]);
    });
  });

  it('a throw after the connection is taken fails the caller and ends the connection (L1)', () => {
    const f = resetPool({ throwWrite: true });
    return inWarn(f.base, async () => {
      const client = actorClient(f.base);
      await expect(
        runAsSystem('worker:test', () =>
          Promise.resolve(client.unsafe('insert into t values (1)')),
        ),
      ).rejects.toThrow('write would not build');
      await tick();
      expect(f.reserved()).toBe(1);
      // The SET went out: the connection may hold it, so it ends.
      expect(f.sent).toContain(END_SESSION_SQL);
      expect(f.released()).toBe(false);
    });
  });
});

describe('the write role SET (arch A2b2b): one statement, transaction-local, checked literals', () => {
  const login = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const ws = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const scope = { kind: 'user' as const, loginId: login, ws: [ws], modWs: [ws] };
  it('sets the scope, the login, the actor and the create home, every one local', () => {
    const text = writeRoleSettingsSql(scope, [`login:rw:${login}`, 'rw', 'warn'], {
      createWs: ws,
      privateWs: null,
      stamp: { snapshot_of: "it's" },
    });
    expect(text.startsWith('/* mantle:actor */ select set_config(')).toBe(true);
    for (const name of [
      'mantle.actor',
      'mantle.write_mode',
      'mantle.actor_check',
      'mantle.ws',
      'mantle.mod_ws',
      'mantle.login_id',
      'mantle.create_ws',
      'mantle.private_ws',
      'mantle.ingest_notify',
      'mantle.create_stamp',
    ]) {
      expect(text).toContain(`set_config('${name}', `);
    }
    expect(text).not.toMatch(/, false\)/);
    expect(text).toContain(`'{${ws}}'`);
    expect(text).toContain(`"snapshot_of":"it''s"`);
    expect(text).not.toContain('$1');
  });
  it('refuses a value it cannot inline', () => {
    expect(() =>
      writeRoleSettingsSql(
        { ...scope, ws: ["x'); drop table nodes; --"] },
        ['link', 'ro', 'on'],
        null,
      ),
    ).toThrow(/not a uuid/);
    expect(() =>
      writeRoleSettingsSql({ ...scope, loginId: 'nope' }, ['link', 'ro', 'on'], null),
    ).toThrow(/login/);
    expect(() => writeRoleSettingsSql(scope, ["x'y", 'rw', 'on'], null)).toThrow(/not an actor/);
  });
});
