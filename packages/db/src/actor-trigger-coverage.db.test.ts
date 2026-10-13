/**
 * Every content table carries the actor check's write trigger (workspaces
 * arch A2a, migration 0275): each table ACCESS_MATRIX marks writer
 * 'content' that exists after migrate has the statement trigger
 * mantle_actor_check, so a write on it with no actor is a miss. A new
 * content table fails here until a migration gives it the trigger.
 *
 * The triggers follow the box mode (0277, A2b1 fix round 2 M1): disabled
 * while the box is off, so a write there calls no trigger at all (the
 * owner's scaling rule), enabled in warn and on. mantle_set_actor_check
 * switches the setting and the triggers together. And no limited role may
 * take heads or sign a held list (fix round 2, M2).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/actor-trigger-coverage.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_MATRIX } from './access-matrix';
import { ACTOR_CHECK_DRIFT_SQL } from './client';
import { createMigratedScratchDatabase, createScratchDatabaseBefore } from './test-support';

type Mode = 'off' | 'warn' | 'on';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the actor check trigger covers every content table (arch A2a)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('each content table that exists has mantle_actor_check', async () => {
    const content = ACCESS_MATRIX.filter((t) => t.writer === 'content').map((t) => t.table);
    expect(content.length).toBeGreaterThan(0);
    const rows = await sql<{ tbl: string; present: boolean; covered: boolean }[]>`
      select t.name as tbl,
             to_regclass(t.name) is not null as present,
             exists (select 1 from pg_trigger g
                      where g.tgrelid = to_regclass(t.name)
                        and g.tgname = 'mantle_actor_check'
                        and not g.tgisinternal) as covered
        from unnest(${content}::text[]) as t(name)`;
    const missing = rows.filter((r) => r.present && !r.covered).map((r) => r.tbl);
    expect(missing).toEqual([]);
    // The check reads real tables: most of the list exists.
    expect(rows.filter((r) => r.present).length).toBeGreaterThan(content.length / 2);
  });
  /** The box mode and each actor check trigger's state, from the catalog. */
  const state = async () => {
    const [b] = await sql<{ m: Mode }[]>`select mantle_actor_check_box_mode() as m`;
    const t = await sql<{ tbl: string; on: boolean }[]>`
      select g.tgrelid::regclass::text as tbl, g.tgenabled <> 'D' as on
        from pg_trigger g
       where g.tgname = 'mantle_actor_check' and not g.tgisinternal
       order by 1`;
    return { mode: b!.m, tables: t.map((r) => r.tbl), enabled: t.filter((r) => r.on).length };
  };

  /** Calls of the trigger function by one write that has an actor, in a
   *  session that raised its own check to warn (track_functions counts
   *  them; the counts not yet flushed can hold earlier transactions', so
   *  the write's own is the difference). */
  const triggerCalls = () =>
    sql.begin(async (tx) => {
      await tx`set local track_functions = 'pl'`;
      const calls = async () =>
        (
          await tx<{ n: number }[]>`
            select coalesce(sum(calls), 0)::int as n from pg_stat_xact_user_functions
             where funcname = 'mantle_actor_check_stmt'`
        )[0]!.n;
      await tx`select mantle_set_actor('system:test', 'rw', 'warn')`;
      const before = await calls();
      await tx`update nodes set title = title where id = ${randomUUID()}`;
      return (await calls()) - before;
    });

  it('the triggers follow the box mode: off disables them, a write calls none (M1)', async () => {
    // After migrate, on a box that is off (every box but dev).
    const fresh = await state();
    expect(fresh.mode).toBe('off');
    expect(fresh.tables.length).toBeGreaterThan(20);
    expect(fresh.enabled).toBe(0);
    // The list is derived from the triggers that exist.
    const listed = await sql<{ tbl: string }[]>`
      select tbl::text as tbl from mantle_actor_check_tables() order by 1`;
    expect(listed.map((r) => r.tbl)).toEqual(fresh.tables);
    expect(await triggerCalls()).toBe(0);
    try {
      for (const mode of ['warn', 'on', 'off', 'warn'] as const) {
        const [r] = await sql<{ m: string }[]>`select mantle_set_actor_check(${mode}) as m`;
        expect(r!.m).toBe(mode);
        const now = await state();
        expect(now.mode, mode).toBe(mode);
        expect(now.tables).toEqual(fresh.tables);
        expect(now.enabled, mode).toBe(mode === 'off' ? 0 : fresh.tables.length);
        expect(await triggerCalls(), mode).toBe(mode === 'off' ? 0 : 1);
      }
      // A call that changes nothing switches no trigger (takes no lock).
      const [n] = await sql<{ n: number }[]>`select mantle_actor_check_triggers(true) as n`;
      expect(n!.n).toBe(0);
    } finally {
      await sql`select mantle_set_actor_check('off')`;
    }
    expect((await state()).enabled).toBe(0);
  });

  it('a busy item table: the switch waits for no lock, fails with nothing changed, then works (re-audit L1)', async () => {
    const holder = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    // A writer's lock on one item table, kept open.
    const tx = holder.begin(async (t) => {
      await t`lock table pages in row exclusive mode`;
      locked();
      await held;
    });
    try {
      await isLocked;
      const started = Date.now();
      // 5 tries (the default is 50 since A3a fix round 1, M2: about 10 s).
      await expect(sql`select mantle_set_actor_check('warn', 5)`).rejects.toMatchObject({
        code: '55P03',
      });
      // 5 tries, 200 ms apart: about a second, never a wait per table.
      expect(Date.now() - started).toBeLessThan(5_000);
      const after = await state();
      expect(after.mode).toBe('off');
      expect(after.enabled).toBe(0);
      // No lock is left behind: other tables take writes at once.
      await sql`update nodes set title = title where id = ${randomUUID()}`;
    } finally {
      release();
      await tx;
      await holder.end();
    }
    try {
      await sql`select mantle_set_actor_check('warn')`;
      expect((await state()).enabled).toBe((await state()).tables.length);
    } finally {
      await sql`select mantle_set_actor_check('off')`;
    }
  });

  it('the drift row: none in step, one after a bare ALTER DATABASE (re-audit L2)', async () => {
    const drift = () => sql.unsafe(ACTOR_CHECK_DRIFT_SQL);
    expect(await drift()).toEqual([]);
    await sql.unsafe(`alter database "${scratch.name}" set mantle.actor_check = 'warn'`);
    try {
      // A new session sees the box setting; the triggers are still off.
      const fresh = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
      try {
        const rows = await fresh.unsafe(ACTOR_CHECK_DRIFT_SQL);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ mode: 'warn', enabled: 0 });
        expect(rows[0]!.total).toBeGreaterThan(20);
      } finally {
        await fresh.end();
      }
      await sql`select mantle_set_actor_check('warn')`;
      expect(await drift()).toEqual([]);
    } finally {
      await sql`select mantle_set_actor_check('off')`;
    }
    expect(await drift()).toEqual([]);
  });

  it('mantle_set_actor_check takes off, warn or on, and is not the workspace roles’', async () => {
    for (const bad of ['', 'Warn', 'strict']) {
      await expect(sql`select mantle_set_actor_check(${bad})`, bad).rejects.toMatchObject({
        code: '22023',
      });
    }
    for (const q of [
      `select mantle_set_actor_check('off')`,
      `select mantle_actor_check_triggers(false)`,
    ]) {
      await expect(
        sql.begin(async (tx) => {
          await tx`set local role mantle_view_user`;
          await tx.unsafe(q);
        }),
        q,
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('no limited role takes heads or signs a held list (M2)', async () => {
    // No heads or lock function is open to PUBLIC.
    const open = await sql<{ f: string }[]>`
      select p.oid::regprocedure::text as f
        from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and (p.proname like 'mantle\_heads\_%' or p.proname like 'mantle\_lock\_%')
         and (p.proacl is null
              or exists (select 1 from aclexplode(p.proacl) a
                          where a.grantee = 0 and a.privilege_type = 'EXECUTE'))`;
    expect(open.map((r) => r.f)).toEqual([]);
    // Nor to a view role. The write role (A2b2a) may get the lock
    // functions, never a signer or a bypass.
    const granted = await sql<{ f: string }[]>`
      select r.rolname || ' ' || p.oid::regprocedure::text as f
        from pg_proc p, pg_roles r
       where p.pronamespace = 'public'::regnamespace
         and (p.proname like 'mantle\_heads\_%' or p.proname like 'mantle\_lock\_%')
         and (r.rolname like 'mantle\_view\_%'
              or (r.rolname like 'mantle\_write\_user%'
                  and (p.proname in ('mantle_heads_set', 'mantle_heads_sig', 'mantle_heads_mac')
                       or p.proname like 'mantle\_heads\_bypass%')))
         and has_function_privilege(r.oid, p.oid, 'EXECUTE')`;
    expect(granted.map((r) => r.f)).toEqual([]);
    // The view role is refused at the call.
    for (const q of [
      `select mantle_heads_set('{}'::uuid[], '{}'::uuid[])`,
      `select mantle_heads_sig('', '')`,
      `select mantle_heads_mac('x')`,
      `select mantle_lock_heads_nested('{}'::uuid[], 'update')`,
      `select mantle_heads_taken()`,
    ]) {
      await expect(
        sql.begin(async (tx) => {
          await tx`set local role mantle_view_user`;
          await tx.unsafe(q);
        }),
        q,
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('a box that is warn before 0277 (dev) keeps its triggers enabled after migrate', async () => {
    const before = await createScratchDatabaseBefore(URL!, '0277_scoped_write_gate');
    try {
      const pre = postgres(before.url, { max: 1, prepare: false, onnotice: () => {} });
      try {
        await pre.unsafe(`alter database "${before.name}" set mantle.actor_check = 'warn'`);
      } finally {
        await pre.end();
      }
      await before.migrateRest();
      const post = postgres(before.url, { max: 1, prepare: false, onnotice: () => {} });
      try {
        const [r] = await post<{ mode: string; on: number; all: number }[]>`
          select mantle_actor_check_box_mode() as mode,
                 count(*) filter (where enabled)::int as on, count(*)::int as all
            from mantle_actor_check_tables()`;
        expect(r!.mode).toBe('warn');
        expect(r!.all).toBeGreaterThan(20);
        expect(r!.on).toBe(r!.all);
      } finally {
        await post.end();
      }
    } finally {
      await before.drop();
    }
  }, 120_000);
});
