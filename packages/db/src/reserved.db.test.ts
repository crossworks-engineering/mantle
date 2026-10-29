/**
 * A reserved connection the server ended is never handed back, and nothing
 * is sent on it (hotfix after v0.300.13, whose release guard failed on an
 * uncaught "Cannot read properties of null (reading 'write')" from
 * postgres.js). In postgres.js 3.4.9 a connection the server closes (killed,
 * restarted, a dropped network) gets socket = null and goes to the pool's
 * closed queue, but stays usable for a reservation: `release()` moves it
 * back to open, and the next statement on it is written to the null socket
 * from a setImmediate, outside every promise. In a server that is a crash.
 *
 * Each case kills the backend of a pool of ONE connection from another
 * connection, so what the pool hands out next is the very connection that
 * died, then asks the pool for an answer:
 *
 *  - postgres.js itself (patches/postgres@3.4.9.patch): a release, and a
 *    statement, on a reservation the server ended; a transaction (begin,
 *    drizzle's db.transaction) killed mid-statement, whose ROLLBACK went to
 *    the null socket the same way; a reservation's new connection closed
 *    during its array-type lookup, whose promise nobody held;
 *  - the system pool's write as the actor (actorClient, pipelined): the
 *    connection killed during the write, and a RESET that fails on a live
 *    connection (it then ends on purpose and is not handed back);
 *  - a turn-scoped query (turnScopedClient);
 *  - a concurrent index build (ensureConcurrentIndexes).
 *
 * vitest fails the run on an uncaught error, so each case also proves none
 * was raised.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/reserved.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionGone } from './reserved';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('a reserved connection that dies is never handed back', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let admin: ReturnType<typeof postgres>;
  let m: typeof import('./index');
  let actorSql: typeof import('./gateway/actor-sql');
  let scopeModule: typeof import('./gateway/scope');
  // The write as the actor runs only while the check is not off: the file
  // sets warn, so it runs the same under `pnpm test:actor-off`.
  const suiteMode = process.env.MANTLE_ACTOR_CHECK;

  beforeAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    scratch = await createMigratedScratchDatabase(URL!);
    admin = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    actorSql = await import('./gateway/actor-sql');
    scopeModule = await import('./gateway/scope');
    await admin`create table rfix (id int primary key, a int not null)`;
    await admin`insert into rfix values (1, 0)`;
  }, 120_000);

  afterAll(async () => {
    if (suiteMode === undefined) delete process.env.MANTLE_ACTOR_CHECK;
    else process.env.MANTLE_ACTOR_CHECK = suiteMode;
    await m?.closeDb();
    await admin?.end();
    await scratch?.drop();
  });

  /** A pool of one connection: what it hands out next is what died. */
  const onePool = () => {
    let closes = 0;
    const pool = postgres(scratch.url, {
      max: 1,
      prepare: false,
      onnotice: () => {},
      onclose: () => {
        closes += 1;
      },
    });
    return { pool, closes: () => closes };
  };

  const pidOf = async (q: ReturnType<typeof postgres>): Promise<number> =>
    Number((await q`select pg_backend_pid() as pid`)[0]!.pid);

  /** Wait for `ok`, at most 10 s. */
  const until = async (ok: () => boolean | Promise<boolean>, what: string) => {
    for (let i = 0; i < 400; i += 1) {
      if (await ok()) return;
      await sleep(25);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  /** Kill backend `pid` once it runs a statement that contains `marker`. */
  const killWhenRunning = async (pid: number, marker: string) => {
    await until(async () => {
      const [r] = await admin`select state, query from pg_stat_activity where pid = ${pid}`;
      return r?.state === 'active' && String(r.query).includes(marker);
    }, `backend ${pid} to run ${marker}`);
    await admin`select pg_terminate_backend(${pid})`;
  };

  /** The pool answers its very next statement (on a fresh connection):
   *  nothing was written to the dead one, it was not handed back, and the
   *  reconnect carries nothing of it (before the patch, the FATAL a killed
   *  statement got failed the reconnect's first statement, a stale 57P01). */
  const answers = async (pool: ReturnType<typeof postgres>) => {
    expect(await pool`select 1 as one`).toEqual([{ one: 1 }]);
  };

  it('postgres.js: a close that lands while a write is buffered does not block the reconnect', async () => {
    // The pool's sockets are ours (postgres.js's `socket` option), so the
    // test can close one at the exact moment a statement's write waits in
    // postgres.js's buffer for its setImmediate.
    const target = new globalThis.URL(scratch.url);
    let sock: net.Socket | null = null;
    const pool = postgres(scratch.url, {
      max: 1,
      prepare: false,
      onnotice: () => {},
      connect_timeout: 3,
      // @ts-expect-error a runtime option (src/connection.js createSocket) its types omit
      socket: async () => {
        const s = net.connect(Number(target.port || 5432), target.hostname);
        await once(s, 'connect');
        sock = s;
        return s;
      },
    });
    try {
      await answers(pool);
      const first = sock!;
      const caught = pool`select 2 as two`.then(
        () => null,
        (err: unknown) => err,
      );
      // Microtasks only: the statement is sent to its connection and
      // buffered, and its flush (a setImmediate) has not run.
      for (let i = 0; i < 10; i += 1) await null;
      first.destroy();
      first.emit('close', false);
      expect(connectionGone(await caught)).toBe(true);
      // Before the patch the cleared flush timer stayed set: the reconnect's
      // startup message was never sent (CONNECT_TIMEOUT, for good).
      await answers(pool);
      expect(sock).not.toBe(first);
    } finally {
      await pool.end({ timeout: 1 });
    }
  });

  it('postgres.js: a reservation whose new connection dies during its type lookup leaves no unhandled rejection', async () => {
    // The first statement of a fresh connection is postgres.js's array-type
    // lookup. A reservation opens its connection with no statement of its
    // own, so before the patch nothing held that lookup's promise: a forced
    // DROP DATABASE at a test file's end killed one there, and vitest failed
    // a run whose tests all passed on the unhandled CONNECTION_CLOSED. The
    // pool's sockets are ours, so the first one closes exactly as the
    // lookup is written.
    const target = new globalThis.URL(scratch.url);
    const sockets: net.Socket[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const pool = postgres(scratch.url, {
      max: 1,
      prepare: false,
      onnotice: () => {},
      connect_timeout: 3,
      // @ts-expect-error a runtime option (src/connection.js createSocket) its types omit
      socket: async () => {
        const s = net.connect(Number(target.port || 5432), target.hostname);
        await once(s, 'connect');
        if (sockets.length === 0) {
          const write = s.write.bind(s) as (chunk: unknown) => boolean;
          Object.assign(s, {
            write: (chunk: unknown) => {
              if (!Buffer.isBuffer(chunk) || !chunk.includes('typarray')) return write(chunk);
              s.destroy();
              return false;
            },
          });
        }
        sockets.push(s);
        return s;
      },
    });
    try {
      // The close opens a second connection for the reservation, which
      // stays queued until that one is ready (patches/postgres@3.4.9.patch;
      // unpatched it left the queue, the second connection opened to no one
      // and the reservation never settled).
      const reservation = pool.reserve();
      await until(() => sockets.length === 2, 'the second connection');
      const conn = await reservation;
      await expect(conn`select 1 as one`).resolves.toEqual([{ one: 1 }]);
      conn.release();
      // The pool answers on the second connection, and nothing went unheld.
      await answers(pool);
      await sleep(50);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await pool.end({ timeout: 1 });
    }
  });

  it('postgres.js: releasing a reservation the server ended does not hand it back', async () => {
    const { pool, closes } = onePool();
    try {
      const conn = await pool.reserve();
      await admin`select pg_terminate_backend(${await pidOf(conn)})`;
      await until(() => closes() === 1, 'the connection to close');
      conn.release();
      await answers(pool);
    } finally {
      await pool.end({ timeout: 1 });
    }
  });

  it('postgres.js: a statement on a reservation the server ended fails, nothing is written', async () => {
    const { pool, closes } = onePool();
    try {
      const conn = await pool.reserve();
      await admin`select pg_terminate_backend(${await pidOf(conn)})`;
      await until(() => closes() === 1, 'the connection to close');
      await expect(conn`select 1`).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
      conn.release();
      await answers(pool);
    } finally {
      await pool.end({ timeout: 1 });
    }
  });

  it('postgres.js: a transaction whose connection is killed writes no ROLLBACK to it; the pool answers', async () => {
    const { pool } = onePool();
    try {
      const pid = await pidOf(pool);
      const tx = pool
        .begin(async (t) => {
          await t`select pg_sleep(5)`;
        })
        .then(
          () => null,
          (err: unknown) => err,
        );
      await killWhenRunning(pid, 'pg_sleep(5)');
      expect(connectionGone(await tx)).toBe(true);
      // The transaction's own ROLLBACK runs after begin's rejection.
      await sleep(100);
      await answers(pool);
    } finally {
      await pool.end({ timeout: 1 });
    }
  });

  /** Run `fn` with `pool` as the system pool (the write as the actor runs
   *  pipelined only there), then close it the way the app does: closeDb
   *  waits for the write's connection, so it never finishes while one is
   *  kept reserved. */
  const asSystemPool = async (pool: ReturnType<typeof postgres>, fn: () => Promise<void>) => {
    globalThis.__mantleSql = pool;
    try {
      await fn();
    } finally {
      await Promise.race([
        m.closeDb(),
        sleep(10_000).then(() => {
          throw new Error('closeDb did not finish: a connection was kept reserved');
        }),
      ]);
    }
  };

  // With a parameter (drizzle's every write) the write is described first,
  // and the RESET waits in the reservation's own queue: postgres.js 3.4.9
  // never settles a statement left there when the connection closes (the
  // patch rejects it), so the pipeline, and closeDb after it, waited forever.
  it.each([
    ['no parameter', 'update rfix set a = a + 1 where id = (select 1 from pg_sleep(5))', []],
    ['a parameter', 'update rfix set a = a + $1 where id = (select 1 from pg_sleep(5))', [1]],
  ])(
    'a write as the actor (%s) whose connection is killed mid-write fails; the pool answers',
    async (_, text, args) => {
      const { pool } = onePool();
      await asSystemPool(pool, async () => {
        const client = actorSql.actorClient(pool);
        const pid = await pidOf(pool);
        const write = m.runAsSystem('worker:test', () =>
          Promise.resolve(client.unsafe(text, args)),
        );
        const caught = write.then(
          () => null,
          (err: unknown) => err,
        );
        await killWhenRunning(pid, 'pg_sleep(5)');
        expect(connectionGone(await caught)).toBe(true);
        // The pipeline's own end (its RESET fails too) runs after the caller's
        // answer: give it its turn, then the pool must answer.
        await sleep(100);
        await answers(pool);
        const [row] = await pool`select a from rfix where id = 1`;
        expect(row!.a).toBe(0);
      });
    },
  );

  it('a RESET that fails on a live connection ends it on purpose; it is not handed back', async () => {
    const { pool } = onePool();
    await asSystemPool(pool, async () => {
      const client = actorSql.actorClient(pool);
      const before = await pidOf(pool);
      // Leaves the session in an aborted transaction block: the RESET after
      // it fails (25P02) on a connection that is still open.
      const write = m.runAsSystem('worker:test', () =>
        Promise.resolve(
          (
            client.unsafe('update rfix set a = a where id = 1; begin; select 1/0') as unknown as {
              simple: () => Promise<unknown>;
            }
          ).simple(),
        ),
      );
      await expect(write).rejects.toMatchObject({ code: '22012' });
      // The connection ended (a new backend answers), back at the defaults.
      await until(async () => (await pidOf(pool)) !== before, 'a new connection');
      const [s] = await pool`select current_setting('mantle.actor', true) as a,
                                    pg_catalog.txid_current_if_assigned() as tx`;
      expect(s!.a ?? '').toBe('');
      expect(s!.tx).toBeNull();
      const [gone] =
        await admin`select count(*)::int as n from pg_stat_activity where pid = ${before}`;
      expect(gone!.n).toBe(0);
    });
  });

  it('a turn-scoped query whose connection is killed fails; the pool answers', async () => {
    const { pool } = onePool();
    try {
      const client = scopeModule.turnScopedClient(pool);
      const pid = await pidOf(pool);
      const scope = { kind: 'assistant' as const, loginId: null, ws: [randomUUID()], modWs: [] };
      const q = m.withTurnScope(scope, async () => client.unsafe('select pg_sleep(5)'));
      const caught = q.then(
        () => null,
        (err: unknown) => err,
      );
      await killWhenRunning(pid, 'pg_sleep(5)');
      expect(connectionGone(await caught)).toBe(true);
      await answers(pool);
    } finally {
      await pool.end({ timeout: 1 });
    }
  });

  it('an index build whose connection is killed is reported failed, the rest too; the pool answers', async () => {
    const { pool } = onePool();
    try {
      const pid = await pidOf(pool);
      const seen: string[] = [];
      const run = m.ensureConcurrentIndexes(
        pool,
        [
          { name: 'rfix_slow_idx', create: 'select pg_sleep(5)' },
          {
            name: 'rfix_a_idx',
            create: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS rfix_a_idx ON rfix (a)',
          },
        ],
        { onError: (name) => seen.push(name) },
      );
      await killWhenRunning(pid, 'pg_sleep(5)');
      expect(await run).toEqual({ rfix_slow_idx: 'failed', rfix_a_idx: 'failed' });
      expect(seen).toEqual(['rfix_slow_idx', 'rfix_a_idx']);
      await answers(pool);
    } finally {
      await pool.end({ timeout: 1 });
    }
  });
});
