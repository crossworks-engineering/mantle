/**
 * A reserve queued behind a full pool is answered when one of the pool's
 * connections closes, on every pool (the b1 re-audit's MED-A). In
 * postgres.js 3.4.9 a closing connection took the next queued request as
 * the one to open for; a reserve is never a statement to run, so the
 * connection's ReadyForQuery dropped it and its promise never settled. The
 * caller hung, and closeDb behind it (it waits for every pipeline). A pool
 * of 2 (the narrow pool) makes a queued reserve routine, and the pipeline
 * ends its own connection after a failed SET or RESET.
 *
 * Two layers, each with cells here:
 *  - patches/postgres@3.4.9.patch: the close keeps a queued reserve queued
 *    while it opens for it (as reserve() itself does), a reserve whose
 *    connect failed leaves the queue, and a reserve that opens a connection
 *    with fetch_types off takes it;
 *  - reserved.ts reserveLease: every reserve, on every pool, waits a bounded
 *    time (a busy error, the late connection handed back).
 *
 * The shapes the re-audit proved: P2 (the narrow pool, a held connection, a
 * pipeline whose SET fails, a pipeline queued behind it), P3 (the real
 * route under an Admin-area exit, 4 at once, one backend killed: closeDb
 * returns), P6 (the system pool, one connection), and the write pool.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/reserve-queue.db.test.ts
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const NARROW = 'mantle_system_narrow';

/** `p`, or 'pending' when it has not settled within `ms`. */
const within = <T>(p: Promise<T>, ms: number): Promise<T | 'pending'> =>
  Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms).unref())]);

describe.skipIf(!URL)('a reserve queued when a connection of its pool closes is answered', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let su: ReturnType<typeof postgres>;
  let m: typeof import('./index');
  let v: typeof import('./viewer');
  let rr: typeof import('./runtime-role');
  let pools: typeof import('./gateway/pools');
  let as: typeof import('./gateway/actor-sql');
  let rt: typeof import('./gateway/role-tx');
  let reserved: typeof import('./reserved');
  let dbName = '';
  const KEY = () => process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    dbName = new globalThis.URL(scratch.url).pathname.slice(1);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    rr = await import('./runtime-role');
    m = await import('./index');
    v = await import('./viewer');
    pools = await import('./gateway/pools');
    as = await import('./gateway/actor-sql');
    rt = await import('./gateway/role-tx');
    reserved = await import('./reserved');
  }, 120_000);

  afterAll(async () => {
    rr?.setNarrowSystemForTests(null);
    reserved?.setReserveWaitForTests(null);
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
  });

  const pidOf = async (c: { unsafe: (q: string) => PromiseLike<{ p: number }[]> }) =>
    (await c.unsafe('select pg_backend_pid() as p'))[0]!.p;
  const kill = (pid: number) => su`select pg_terminate_backend(${pid})`;
  const narrowUrl = () =>
    rr.runtimeDatabaseUrl(scratch.url, rr.narrowRolePassword(KEY()), rr.NARROW_ROLE);
  const SET = `select set_config('mantle.cell', 'x', false)`;
  const READ = `select pg_backend_pid() as p, current_setting('mantle.cell', true) as c`;
  const pipeline = (pool: ReturnType<typeof postgres>, set = SET) =>
    as
      .settingsPipeline(pool, () => set, READ, [], 'rows', 'reset mantle.cell')
      .then((rows) => (rows as { p: number; c: string }[])[0]!);

  it('P2, the narrow pool: queued behind a held connection and a pipeline whose SET fails, answered; the pool ends', async () => {
    const pool = pools.newNarrowPool(narrowUrl(), su);
    expect(pool.options.max).toBe(2);
    const held = await pool.reserve();
    try {
      // The pipeline whose SET fails ends its connection (lease.end) while
      // the second waits for the pool's other connection.
      const failing = pipeline(pool, 'select 1/0');
      const queued = pipeline(pool);
      const [a, b] = await Promise.all([within(failing, 5000), within(queued, 5000)]);
      // The failing one: the statement's own answer, with none of the SET.
      expect(a).not.toBe('pending');
      expect(['', null]).toContain((a as { c: string | null }).c);
      expect(b).toMatchObject({ c: 'x' });
    } finally {
      held.release();
    }
    // As closeDb: the pipelines first (a connection whose reservation ends
    // after the pool's end began is never ended: postgres.js).
    await as.actorPipelinesDone();
    await expect(within(pool.end(), 5000)).resolves.toBeUndefined();
  });

  it('the narrow pool: a queued pipeline is answered after a kill of a held connection', async () => {
    const pool = pools.newNarrowPool(narrowUrl(), su);
    const held = await Promise.all([pool.reserve(), pool.reserve()]);
    const pids = await Promise.all(held.map(pidOf));
    const queued = pipeline(pool);
    await new Promise((r) => setTimeout(r, 50));
    await kill(pids[0]!);
    const answer = await within(queued, 5000);
    expect(answer).toMatchObject({ c: 'x' });
    expect((answer as { p: number }).p).not.toBe(pids[0]);
    held[0]!.release();
    held[1]!.release();
    // As closeDb: the pipelines first (a connection whose reservation ends
    // after the pool's end began is never ended: postgres.js).
    await as.actorPipelinesDone();
    await expect(within(pool.end(), 5000)).resolves.toBeUndefined();
  });

  it('P3, the real route: 4 narrow statements of an Admin-area exit at once, one backend killed; every one settles and closeDb returns', async () => {
    await m.closeDb();
    rr.setNarrowSystemForTests(true);
    await m.systemDb.execute(sql`select 1`);
    const runs = Array.from({ length: 4 }, () =>
      v
        .asSystem(
          () =>
            m.db.execute(
              sql`select pg_backend_pid() as p, session_user::text as s, pg_sleep(0.4) is null as z`,
            ),
          'admin-area',
        )
        .then(
          (rows) => ({ ok: (rows as unknown as { p: number; s: string }[])[0]! }),
          (err: { code?: string; cause?: { code?: string } }) => ({
            err: err.cause?.code ?? err.code,
          }),
        ),
    );
    // Two run (the pool's 2), two wait; one running is killed.
    let victim = 0;
    for (let i = 0; i < 40 && !victim; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const [row] = await su<{ p: number }[]>`
        select pid as p from pg_stat_activity
         where usename = ${NARROW} and datname = ${dbName} and query like '%pg_sleep(0.4)%'
         limit 1`;
      victim = row?.p ?? 0;
    }
    expect(victim).toBeGreaterThan(0);
    await kill(victim);
    const out = await within(Promise.all(runs), 8000);
    expect(out).not.toBe('pending');
    const answers = out as { ok?: { s: string }; err?: string }[];
    // The killed one fails as the kill (57P01), every other answers as the
    // narrow role.
    expect(answers.filter((a) => a.ok).map((a) => a.ok!.s)).toEqual(
      Array.from({ length: answers.filter((a) => a.ok).length }, () => NARROW),
    );
    expect(answers.filter((a) => a.err).length).toBeLessThanOrEqual(1);
    expect(answers.filter((a) => a.ok).length).toBeGreaterThanOrEqual(3);
    await expect(within(m.closeDb(), 8000)).resolves.toBeUndefined();
  });

  it('P6, the system pool of one connection: a write pipeline queued behind one whose SET fails, answered; closeDb returns', async () => {
    await m.closeDb();
    // The system pool itself (getAdminDb takes a pool already made).
    const one = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    (globalThis as unknown as { __mantleSql?: unknown }).__mantleSql = one;
    await m.systemDb.execute(sql`select 1`);
    expect((globalThis as unknown as { __mantleSql?: unknown }).__mantleSql).toBe(one);
    const failing = pipeline(one, 'select 1/0');
    const queued = pipeline(one);
    const [a, b] = await Promise.all([within(failing, 5000), within(queued, 5000)]);
    expect(a).not.toBe('pending');
    expect(b).toMatchObject({ c: 'x' });
    // And one queued as a held connection is killed.
    const held = await one.reserve();
    const pid = await pidOf(held);
    const late = pipeline(one);
    await new Promise((r) => setTimeout(r, 50));
    await kill(pid);
    expect(await within(late, 5000)).toMatchObject({ c: 'x' });
    held.release();
    // closeDb waits for every pipeline, and none is left unsettled.
    await expect(within(m.closeDb(), 8000)).resolves.toBeUndefined();
  });

  it('the write pool: a bounded reserve queued behind every connection held is answered when one is killed', async () => {
    await m.closeDb();
    const write = pools.writePoolSql();
    const max = write.options.max;
    const held = await Promise.all(Array.from({ length: max }, () => rt.boundedReserve()));
    const pids = await Promise.all(held.map((l) => pidOf(l.sql)));
    const queued = rt.boundedReserve();
    await new Promise((r) => setTimeout(r, 50));
    await kill(pids[0]!);
    const lease = await within(queued, 5000);
    expect(lease).not.toBe('pending');
    const got = lease as Awaited<ReturnType<typeof rt.boundedReserve>>;
    expect(await pidOf(got.sql)).not.toBe(pids[0]);
    got.release();
    // The killed one is gone: its release hands nothing back.
    for (const l of held) l.release();
    await expect(within(m.closeDb(), 8000)).resolves.toBeUndefined();
  });

  it('the bounded wait: a reserve on a pool held whole fails busy, and the late connection goes back', async () => {
    const pool = pools.newNarrowPool(narrowUrl(), su);
    const held = await Promise.all([pool.reserve(), pool.reserve()]);
    const error = console.error;
    console.error = () => {};
    reserved.setReserveWaitForTests(200);
    try {
      const err = await pipeline(pool).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(reserved.PoolBusyError);
    } finally {
      reserved.setReserveWaitForTests(null);
      console.error = error;
    }
    for (const h of held) h.release();
    // The late reserve took a connection and handed it back: the pool
    // answers on both, and ends.
    const both = await Promise.all([pipeline(pool), pipeline(pool)]);
    expect(both.map((x) => x.c)).toEqual(['x', 'x']);
    // As closeDb: the pipelines first (a connection whose reservation ends
    // after the pool's end began is never ended: postgres.js).
    await as.actorPipelinesDone();
    await expect(within(pool.end(), 5000)).resolves.toBeUndefined();
  });

  it('postgres.js: with fetch_types off a reserve that opens a connection takes it, cold and queued after a kill', async () => {
    const pool = postgres(scratch.url, {
      max: 1,
      prepare: false,
      fetch_types: false,
      onnotice: () => {},
    });
    try {
      const cold = await within(pool.reserve(), 5000);
      expect(cold).not.toBe('pending');
      const conn = cold as Awaited<ReturnType<typeof pool.reserve>>;
      const pid = await pidOf(conn);
      const queued = pool.reserve();
      await new Promise((r) => setTimeout(r, 50));
      await kill(pid);
      const next = await within(queued, 5000);
      expect(next).not.toBe('pending');
      const second = next as Awaited<ReturnType<typeof pool.reserve>>;
      expect(await pidOf(second)).not.toBe(pid);
      conn.release();
      second.release();
      await expect(within(pool.end(), 5000)).resolves.toBeUndefined();
    } finally {
      await pool.end({ timeout: 1 });
    }
  });

  it('postgres.js: a queued reserve whose connect is refused fails and leaves the queue; the pool stops trying', async () => {
    const bad = postgres(
      rr.runtimeDatabaseUrl(scratch.url, 'not-the-derived-one', rr.NARROW_ROLE),
      { max: 1, prepare: false, onnotice: () => {} },
    );
    try {
      const first = await bad.reserve().then(
        () => null,
        (e: { code?: string }) => e.code,
      );
      expect(first).toBe('28P01');
      const second = await within(
        bad.reserve().then(
          () => null,
          (e: { code?: string }) => e.code,
        ),
        5000,
      );
      expect(second).toBe('28P01');
      // Nothing keeps logging in: the pool ends without its timeout.
      await expect(within(bad.end(), 5000)).resolves.toBeUndefined();
    } finally {
      await bad.end({ timeout: 1 });
    }
  });
  it("the waits per pool: the narrow pool's runs out while the system pool's still waits, on the real route", async () => {
    await m.closeDb();
    rr.setNarrowSystemForTests(true);
    await m.systemDb.execute(sql`select 1`);
    // Warm the route's narrow pool, then hold it whole (2).
    await v.asSystem(() => m.db.execute(sql`select 1`), 'admin-area');
    const g = globalThis as unknown as { __mantleNarrowSql: ReturnType<typeof postgres> };
    const narrowPool = g.__mantleNarrowSql;
    const held = await Promise.all([narrowPool.reserve(), narrowPool.reserve()]);
    const error = console.error;
    const logged: string[] = [];
    console.error = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
    reserved.setReserveWaitForTests(300, 'narrow');
    try {
      expect(reserved.reserveWaitMs('pool')).toBe(reserved.RESERVE_WAIT_MS);
      expect(reserved.RESERVE_WAIT_MS).toBe(120_000);
      // A narrow statement of an Admin-area exit: busy at the narrow wait.
      const t0 = Date.now();
      const err = await v
        .asSystem(() => m.db.execute(sql`select 1`), 'admin-area')
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(m.isBusy(err)).toBe(true);
      expect(m.busyMessage(err)).toBe(m.POOL_BUSY_MESSAGE);
      expect(logged.some((l) => l.includes('of the narrow pool within 300 ms'))).toBe(true);
      // The system pool held whole: its pipeline still waits past the
      // narrow wait (the long one), and is answered once a connection
      // comes back.
      const system = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
      try {
        const hold = await system.reserve();
        const queued = pipeline(system);
        expect(await within(queued, 1000)).toBe('pending');
        hold.release();
        expect(await within(queued, 5000)).toMatchObject({ c: 'x' });
        await as.actorPipelinesDone();
      } finally {
        await system.end({ timeout: 5 });
      }
    } finally {
      reserved.setReserveWaitForTests(null);
      console.error = error;
      for (const h of held) h.release();
    }
    await expect(within(m.closeDb(), 8000)).resolves.toBeUndefined();
  });

  /** Backends of this database with `app` as their application_name. */
  const backendsOf = async (app: string) =>
    (
      await su<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where datname = ${dbName} and application_name = ${app}`
    )[0]!.n;

  it('postgres.js: an ending pool reserves nothing, refuses a reserve queued as it ends, and ends with no backend left', async () => {
    const app = `reserve-end-${process.pid}-a`;
    const pool = postgres(scratch.url, {
      max: 1,
      prepare: false,
      onnotice: () => {},
      connection: { application_name: app },
    });
    // The pool held by a long statement; a reserve queued behind it.
    const long = pool.unsafe('select pg_sleep(0.5)').then(() => 'ok');
    await new Promise((r) => setTimeout(r, 100));
    const queued = pool.reserve().then(
      (c) => (c.release(), 'reserved'),
      (e: { code?: string }) => e.code,
    );
    const ending = pool.end();
    const asked = await pool.reserve().then(
      (c) => (c.release(), 'reserved'),
      (e: { code?: string }) => e.code,
    );
    expect(asked).toBe('CONNECTION_ENDED');
    expect(await within(queued, 5000)).toBe('CONNECTION_ENDED');
    // The statement already running finishes; the end returns.
    expect(await long).toBe('ok');
    await expect(within(ending, 5000)).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 200));
    expect(await backendsOf(app)).toBe(0);
  });

  it("postgres.js: a reservation handed back after the pool's end began ends, and the end returns", async () => {
    const app = `reserve-end-${process.pid}-b`;
    const pool = postgres(scratch.url, {
      max: 2,
      prepare: false,
      onnotice: () => {},
      connection: { application_name: app },
    });
    const lease = await reserved.reserveLease(pool);
    await lease.sql.unsafe('select 1');
    expect(await backendsOf(app)).toBe(1);
    const ending = pool.end();
    // Still reserved: the end waits for it.
    expect(await within(ending, 300)).toBe('pending');
    lease.release();
    await expect(within(ending, 5000)).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 200));
    expect(await backendsOf(app)).toBe(0);
  });

  it('a CLI: a pipeline asked while a long statement holds the system pool, then closeDb: refused, 0 backends, the process exits', async () => {
    const app = `reserve-end-${process.pid}-cli`;
    const src = join(__dirname);
    // The child's own system pool of one connection (as P6), held by a
    // long statement; closeDb as a CLI's last step, and a pipeline asked of
    // the pool as it begins (the re-audit's shape: on the old patch the
    // queued reserve opened a connection after the end and the process
    // never exited). It must exit by itself.
    const script = `(async () => {
      const postgres = (await import('postgres')).default;
      const m = await import(${JSON.stringify(join(src, 'index.ts'))});
      const as = await import(${JSON.stringify(join(src, 'gateway', 'actor-sql.ts'))});
      const one = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
      globalThis.__mantleSql = one;
      await one.unsafe('select 1');
      const long = one.unsafe('select pg_sleep(1)').then(() => 'ok', (e) => e.code);
      await new Promise((r) => setTimeout(r, 100));
      // closeDb has begun (its wait for the pipelines found none); a caller
      // still holding the pool asks for a pipeline before the end begins.
      const closing = m.closeDb();
      const late = as
        .settingsPipeline(one, () => "select set_config('mantle.cell', 'x', false)", 'select 1 as one', [], 'rows', 'reset mantle.cell')
        .then(() => 'answered', (e) => e.code || e.name);
      await closing;
      console.log(JSON.stringify({ closed: true, late: await late, long: await long }));
    })().catch((e) => { console.error(e); process.exitCode = 3; });`;
    const tsx = join(__dirname, '..', 'node_modules', '.bin', 'tsx');
    const child = spawn(tsx, ['--eval', script], {
      cwd: join(__dirname, '..'),
      env: {
        ...process.env,
        DATABASE_URL: scratch.url,
        MANTLE_MASTER_KEY: KEY(),
        PGAPPNAME: app,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (errOut += d.toString()));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    const code = await within(exited, 20_000);
    if (code === 'pending') {
      // Hung: count what it holds, then end that one process (its pid).
      const live = await backendsOf(app);
      child.kill('SIGKILL');
      await exited;
      throw new Error(`the CLI did not exit; ${live} backend(s) live; stdout ${out}`);
    }
    expect({ code, err: code === 0 ? '' : errOut }).toEqual({ code: 0, err: '' });
    const line = JSON.parse(out.trim().split('\n').pop()!) as Record<string, unknown>;
    // The pipeline asked as the pool's end began: refused, never a
    // connection that outlives the end; the long statement finished.
    expect(line).toEqual({ closed: true, late: 'CONNECTION_ENDED', long: 'ok' });
    expect(await backendsOf(app)).toBe(0);
  }, 30_000);
});
