/**
 * The narrow system route on a real, migrated Postgres (plan v3.2 S7a part
 * a2, section 2.1 point 3): with MANTLE_NARROW_SYSTEM on, the system pool
 * sends the work of a reason routed 'narrow' (viewer.ts AS_SYSTEM_ROUTE,
 * REQUEST_SYSTEM_ROUTE) as mantle_system_narrow, taken per transaction with
 * the actor's settings; a reason routed 'full', system work and a rebound
 * actor run as the pool's own login; off, nothing changes. The hold check
 * rolls back a transaction that left the role. The archive path's write
 * scope carries the actor's write mode.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/narrow-route.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const NARROW = 'mantle_system_narrow';

describe.skipIf(!URL)('the narrow system route (plan v3.2 S7a)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let m: typeof import('./index');
  let v: typeof import('./viewer');
  let rr: typeof import('./runtime-role');
  let nr: typeof import('./gateway/narrow-route');
  let ns: typeof import('./gateway/narrow-sendable');
  let actor: typeof import('./actor');
  let su: ReturnType<typeof postgres>;
  let pool = '';

  /** Who the statement ran as, and the actor it carried. */
  type Who = { u: string; a: string };
  const who = async (): Promise<Who> => {
    const rows = (await m.db.execute(
      sql`select current_user as u, coalesce(current_setting('mantle.actor', true), '') as a`,
    )) as unknown as Who[];
    return rows[0]!;
  };
  const whoInTx = (): Promise<Who> =>
    m.db.transaction(async (tx) => {
      const rows = (await tx.execute(
        sql`select current_user as u, coalesce(current_setting('mantle.actor', true), '') as a`,
      )) as unknown as Who[];
      return rows[0]!;
    });
  /** The error a statement failed with: drizzle wraps the driver's. */
  const failure = async (p: Promise<unknown>): Promise<unknown> => {
    try {
      await p;
    } catch (err) {
      return (err as { cause?: unknown }).cause ?? err;
    }
    throw new Error('expected a failure');
  };
  /** The pool reads the switch once, when it opens. */
  const reopen = async (on: boolean) => {
    await m.closeDb();
    rr.setNarrowSystemForTests(on);
    await m.systemDb.execute(sql`select 1`);
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    // A probe table every role may write (this scratch database only): a
    // row written after the role was left must not survive.
    await su.unsafe('create table public.narrow_probe (x text)');
    await su.unsafe('grant select, insert on public.narrow_probe to public');
    // A function that changes the role inside: no text check can see it, the
    // hold check must.
    await su.unsafe(`create function public.narrow_probe_leave() returns void
      language plpgsql as $$ begin perform set_config('role', 'none', true); end $$`);
    await su.unsafe('grant execute on function public.narrow_probe_leave() to public');
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    v = await import('./viewer');
    rr = await import('./runtime-role');
    nr = await import('./gateway/narrow-route');
    ns = await import('./gateway/narrow-sendable');
    actor = await import('./actor');
    await reopen(true);
    pool = (await who()).u;
  }, 120_000);

  afterAll(async () => {
    rr?.setNarrowSystemForTests(null);
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
  });

  it('is on by default outside production, and every reason picks a route', () => {
    rr.setNarrowSystemForTests(null);
    // The default, unless the run sets the switch (the suite once with
    // MANTLE_NARROW_SYSTEM=0, the switch-off proof).
    if (process.env.MANTLE_NARROW_SYSTEM === undefined) expect(rr.narrowSystemOn()).toBe(true);
    rr.setNarrowSystemForTests(true);
    const reasons = [...v.AS_SYSTEM_TURN_REASONS, ...v.AS_SYSTEM_OTHER_REASONS];
    expect(Object.keys(v.AS_SYSTEM_ROUTE).sort()).toEqual([...reasons].sort());
    expect(v.REQUEST_SYSTEM_ROUTE).toEqual({ area: 'narrow', 'login-self': 'narrow' });
  });

  it('a narrow reason runs as the narrow role, a statement and a transaction, with its actor', async () => {
    expect(pool).not.toBe(NARROW);
    for (const reason of Object.keys(v.AS_SYSTEM_ROUTE) as (keyof typeof v.AS_SYSTEM_ROUTE)[]) {
      const route = v.AS_SYSTEM_ROUTE[reason];
      const want = route === 'narrow' ? NARROW : pool;
      expect(await v.asSystem(who, reason), reason).toEqual({ u: want, a: expect.any(String) });
      expect((await v.asSystem(whoInTx, reason)).u, `${reason} tx`).toBe(want);
    }
    expect(await v.asSystem(who, 'admin-area')).toEqual({ u: NARROW, a: 'system:admin-area' });
    // System work runs full whatever its reason; a rebound actor too.
    expect((await v.systemWork(who, 'admin-area')).u).toBe(pool);
    expect((await v.asSystem(() => actor.runAsSystem('probe', who), 'admin-area')).u).toBe(pool);
    // Outside any exit: full.
    expect((await who()).u).toBe(pool);
  });

  it('the request exits pick their route (area, login-self)', async () => {
    for (const [why, reason] of [
      ['area', 'http:admin-area'],
      ['login-self', 'http:login-self'],
    ] as const) {
      const got = await v.runInRequestSlot(async () => {
        v.noteRequestSystem(why);
        return { s: await who(), t: await whoInTx() };
      });
      expect(got.s, why).toEqual({ u: NARROW, a: `system:${reason}` });
      expect(got.t.u, why).toBe(NARROW);
    }
    // A request no exit let through: full.
    expect((await v.runInRequestSlot(() => who())).u).toBe(pool);
  });

  it('refuses a content write (noted), writes a system table', async () => {
    expect(
      await failure(
        v.asSystem(
          () => m.db.execute(sql`update public.nodes set title = title where false`),
          'admin-area',
        ),
      ),
    ).toMatchObject({ code: '42501' });
    const denied = actor.takeNarrowDenials();
    expect(denied).toHaveLength(1);
    expect(denied[0]!.actor).toBe('system:admin-area');
    await v.asSystem(
      () => m.db.execute(sql`delete from public.audit_log where false`),
      'admin-area',
    );
    expect(actor.takeNarrowDenials()).toEqual([]);
  });

  it('a full-route spot runs full with its actor inside a narrow exit, and changes nothing elsewhere', async () => {
    // Inside a narrow exit: the spot's statement and transaction run full,
    // as the same actor; around it the exit stays narrow.
    const got = await v.asSystem(
      async () => ({
        spot: await v.onFullSystemRoute('profile-row', who),
        spotTx: await v.onFullSystemRoute('profile-row', whoInTx),
        // A drizzle query handed back unawaited runs where it is awaited.
        spotLazy: await v.onFullSystemRoute('profile-row', () =>
          m.db.execute(sql`select current_user::text as u`),
        ),
        after: await who(),
      }),
      'admin-area',
    );
    expect(got.spot.u).toBe(pool);
    expect(got.spotTx.u).toBe(pool);
    expect((got.spotLazy as unknown as { u: string }[])[0]!.u).toBe(pool);
    expect(got.after).toEqual({ u: NARROW, a: 'system:admin-area' });
    // A content write in a spot is not refused; outside one it is.
    await v.asSystem(
      () =>
        v.onFullSystemRoute('profile-row', () =>
          m.db.execute(sql`update public.profiles set updated_at = updated_at where false`),
        ),
      'admin-area',
    );
    expect(actor.takeNarrowDenials()).toEqual([]);
    // In a request exit too.
    const req = await v.runInRequestSlot(async () => {
      v.noteRequestSystem('login-self');
      return { spot: await v.onFullSystemRoute('profile-row', who), after: await who() };
    });
    expect(req.spot.u).toBe(pool);
    expect(req.after.u).toBe(NARROW);
    // Outside a narrow exit (system work, no exit) the spot changes nothing.
    const work = await v.systemWork(() => v.onFullSystemRoute('profile-row', who), 'admin-area');
    expect(work.u).toBe(pool);
    expect((await v.onFullSystemRoute('profile-row', who)).u).toBe(pool);
  });

  it('rolls back a statement or a transaction that left the role, and refuses transaction control', async () => {
    // A function that changes the role (the text cannot show it): the hold
    // check rolls the work back.
    expect(
      await failure(
        v.asSystem(() => m.db.execute(sql`select public.narrow_probe_leave()`), 'admin-area'),
      ),
    ).toBeInstanceOf(nr.NarrowRoleLeftError);
    const marker = `narrow-left-${randomUUID()}`;
    expect(
      await failure(
        v.asSystem(
          () =>
            m.db.transaction(async (tx) => {
              await tx.execute(sql`select public.narrow_probe_leave()`);
              // As the session's own login now: the hold check must undo this.
              await tx.execute(sql`insert into public.narrow_probe (x) values (${marker})`);
            }),
          'admin-area',
        ),
      ),
    ).toBeInstanceOf(nr.NarrowRoleLeftError);
    const left = await su<{ n: number }[]>`
      select count(*)::int as n from public.narrow_probe where x = ${marker}`;
    expect(left[0]!.n).toBe(0);
    for (const stmt of ['vacuum', 'commit', 'select 1; commit', 'select 1; set role none']) {
      expect(
        await failure(v.asSystem(() => m.db.execute(sql.raw(stmt)), 'admin-area')),
        stmt,
      ).toBeInstanceOf(ns.NarrowRouteRefusedError);
    }
    expect(actor.takeNarrowDenials()).toEqual([]);
  });

  it('refuses a role change, a session setting and transaction control, by text, alone and in a transaction', async () => {
    const refused = [
      // A role change in any form, alone or after another statement.
      'set role none',
      'select 1; set role none',
      'reset role',
      'set local role none',
      'set session authorization default',
      "select set_config('role', 'none', false)",
      "select set_config('role', 'none', true)",
      // A session setting outlives the transaction.
      'set statement_timeout = 1234',
      'select 1; reset statement_timeout',
      "select set_config('statement_timeout', '1234', false)",
      // Transaction control.
      'commit',
      'select 1; commit',
      'savepoint s1',
    ];
    for (const stmt of refused) {
      expect(
        await failure(v.asSystem(() => m.db.execute(sql.raw(stmt)), 'admin-area')),
        stmt,
      ).toBeInstanceOf(ns.NarrowRouteRefusedError);
      expect(
        await failure(
          v.asSystem(() => m.db.transaction((tx) => tx.execute(sql.raw(stmt))), 'admin-area'),
        ),
        `${stmt} (in a transaction)`,
      ).toBeInstanceOf(ns.NarrowRouteRefusedError);
    }
    // In a savepoint's statements too.
    expect(
      await failure(
        v.asSystem(
          () => m.db.transaction((tx) => tx.transaction((sp) => sp.execute(sql.raw('commit')))),
          'admin-area',
        ),
      ),
    ).toBeInstanceOf(ns.NarrowRouteRefusedError);
    // A refused COMMIT never ends the transaction: what follows still runs
    // as the narrow role (before, it ran as the pool login and committed).
    const after = await v.asSystem(
      () =>
        m.db.transaction(async (tx) => {
          await tx.execute(sql.raw('commit')).catch(() => null);
          const r = (await tx.execute(sql`select current_user as u`)) as unknown as { u: string }[];
          return r[0]!.u;
        }),
      'admin-area',
    );
    expect(after).toBe(NARROW);
    // A transaction-local setting is the transaction's own: sent.
    await v.asSystem(
      () => m.db.transaction((tx) => tx.execute(sql.raw('set local statement_timeout = 12345'))),
      'admin-area',
    );
    // A verb inside a literal or a comment is no statement of its own.
    for (const stmt of [
      "select 'commit; set role none' as x",
      'select $$reset role$$ as x',
      "select E'a\\'; commit' as x",
      'select 1 /* ; commit */',
      "select 'set_config' as x -- ; set role none",
    ]) {
      await v.asSystem(() => m.db.execute(sql.raw(stmt)), 'admin-area');
    }
    // No session setting leaked to the pool's next statement.
    const timeout = await v.asSystem(
      () => m.db.execute(sql`select current_setting('statement_timeout') as t`),
      'admin-area',
    );
    expect((timeout as unknown as { t: string }[])[0]!.t).not.toBe('1234ms');
    expect(actor.takeNarrowDenials()).toEqual([]);
  });

  it('refuses the escapes no literal shows: a built role name, bound parameters, a DO block, pg_settings', async () => {
    const marker = `narrow-do-${randomUUID()}`;
    const refused: [string, ReturnType<typeof sql>][] = [
      // The role name built by concatenation.
      ['concat', sql.raw("select set_config('ro' || 'le', 'none', true)")],
      // set_config with bound parameters: the name never shows in the text.
      ['bound', sql`select set_config(${'role'}, ${'none'}, true)`],
      ['bound name', sql`select set_config(${'role'}, 'none', true)`],
      ['bound local', sql`select set_config('mantle.create_ws', 'x', ${true})`],
      // A DO block that leaves the role, writes as the pool login and takes
      // the role back before the hold check (which alone would pass it).
      [
        'do leave and return',
        sql.raw(`do $$ begin
          perform set_config('role', 'none', true);
          insert into public.narrow_probe (x) values ('${marker}');
          perform set_config('role', '${NARROW}', true);
        end $$`),
      ],
      // A DO block that only leaves.
      ['do leave', sql.raw("do $$ begin perform set_config('role', 'none', true); end $$")],
      ['do after', sql.raw('select 1; do $$ begin perform 1; end $$')],
      // pg_settings' rule is set_config(name, value, false).
      ['pg_settings', sql.raw("update pg_settings set setting = 'none' where name = 'role'")],
      ['quoted role', sql.raw('set local "role" none')],
      ['quoted call', sql.raw(`select pg_catalog."set_config"('role', 'none', true)`)],
      ['E string', sql.raw("select set_config(E'role', 'none', true)")],
      ['cast name', sql.raw("select set_config('role'::text, 'none', true)")],
      ['other setting', sql.raw("select set_config('search_path', 'pg_temp', true)")],
    ];
    for (const [name, stmt] of refused) {
      expect(
        await failure(v.asSystem(() => m.db.execute(stmt), 'admin-area')),
        name,
      ).toBeInstanceOf(ns.NarrowRouteRefusedError);
      expect(
        await failure(v.asSystem(() => m.db.transaction((tx) => tx.execute(stmt)), 'admin-area')),
        `${name} (in a transaction)`,
      ).toBeInstanceOf(ns.NarrowRouteRefusedError);
    }
    const left = await su<{ n: number }[]>`
      select count(*)::int as n from public.narrow_probe where x = ${marker}`;
    expect(left[0]!.n).toBe(0);
    // Sent: a literal mantle.* name with a bound value, a named local
    // setting, set_config inside an expression.
    for (const stmt of [
      sql`select set_config('mantle.create_ws', ${'x'}, true)`,
      sql`select set_config('lock_timeout', ${'5s'}, true)`,
      sql.raw("select (set_config('mantle.keep_updated_at', 'on', true))::text as v"),
      sql.raw("select 'set_config(''role'', ''none'', true)' as x"),
      sql.raw('select 1 as "do"'),
    ]) {
      await v.asSystem(() => m.db.transaction((tx) => tx.execute(stmt)), 'admin-area');
    }
    expect(actor.takeNarrowDenials()).toEqual([]);
  });

  it("refuses the a3 audit's forms, each of which leaves the role on Postgres when sent unguarded", async () => {
    const pools = await import('./gateway/pools');
    /** Sent with no guard, as the narrow role on a superuser's session: who
     *  the transaction is afterwards (the form works when it is not the
     *  narrow role). Rolled back. */
    const unguarded = (send: (t: postgres.TransactionSql) => Promise<unknown>) =>
      su
        .begin(async (t) => {
          await t.unsafe(`select set_config('role', '${NARROW}', true)`);
          await send(t);
          const [r] = await t.unsafe<{ u: string }[]>('select current_user as u');
          throw Object.assign(new Error('rollback'), { u: r!.u });
        })
        .catch((err: { u?: string }) => err.u ?? String(err));
    const forms: [string, string, boolean][] = [
      // (a) No space before a quoted setting name after SET or LOCAL.
      ['no space', 'set local"role" to none', false],
      ['no space, set', 'set"role" to none', false],
      // (b) A U& identifier spells the name.
      ['U&', 'set local U&"r\\006Fle" to none', false],
      // (d) A quote after a letter that is no token of its own is a plain
      // string: the backslash ends nothing (simple protocol, more than one
      // statement).
      ['typed literal', "select text'\\'; reset role; select '1'", true],
    ];
    for (const [name, stmt, simple] of forms) {
      expect(
        await unguarded((t) => (simple ? t.unsafe(stmt).simple() : t.unsafe(stmt))),
        `${name}: unguarded`,
      ).toBe('postgres');
      expect(
        await failure(v.asSystem(() => m.db.execute(sql.raw(stmt)), 'admin-area')),
        name,
      ).toBeInstanceOf(ns.NarrowRouteRefusedError);
      expect(
        await failure(
          v.asSystem(() => m.db.transaction((tx) => tx.execute(sql.raw(stmt))), 'admin-area'),
        ),
        `${name} (in a transaction)`,
      ).toBeInstanceOf(ns.NarrowRouteRefusedError);
    }
    // (e) An identifier helper in a tagged template where a function or a
    // setting is named.
    const tagged: [string, (t: postgres.Sql) => unknown][] = [
      ['helper as function', (t) => t`select ${t('pg_catalog.set_config')}('role', 'none', true)`],
      ['helper as setting', (t) => t`set local ${t('role')} to none`],
    ];
    for (const [name, send] of tagged) {
      expect(
        await unguarded(async (t) => send(t as unknown as postgres.Sql)),
        `${name}: unguarded`,
      ).toBe('postgres');
      expect(
        await failure(
          v.asSystem(
            () => pools.adminSql().begin(async (t) => send(t as unknown as postgres.Sql)),
            'admin-area',
          ),
        ),
        name,
      ).toBeInstanceOf(ns.NarrowRouteRefusedError);
    }
    // (c) A function made in pg_temp and called: no role the app runs as
    // may make a temporary object (TEMPORARY taken from PUBLIC), and the
    // route refuses any statement but a read or a row write.
    const [temp] = await su<{ narrow: boolean; runtime: boolean; pub: boolean }[]>`
      select has_database_privilege(${NARROW}, current_database(), 'TEMP') as narrow,
             has_database_privilege('mantle_runtime', current_database(), 'TEMP') as runtime,
             has_database_privilege('public', current_database(), 'TEMP') as pub`;
    expect(temp).toEqual({ narrow: false, runtime: false, pub: false });
    const makeTemp =
      'create function pg_temp.narrow_probe_temp() returns text language sql as $$ select current_user::text $$';
    expect(await unguarded((t) => t.unsafe(makeTemp))).toMatch(
      /permission denied to create temporary tables/,
    );
    expect(
      await failure(
        v.asSystem(() => m.db.transaction((tx) => tx.execute(sql.raw(makeTemp))), 'admin-area'),
      ),
    ).toBeInstanceOf(ns.NarrowRouteRefusedError);
    // The gateway's own settings: a narrow statement never names them; the
    // gateway's scope SET still does (the archive path's write scope).
    for (const stmt of [
      "select set_config('mantle.route', 'full', true)",
      "select set_config('mantle.actor', 'system:test', true)",
      "select set_config('mantle.actor_check', 'off', true)",
      "select set_config('mantle.scope_login', '00000000-0000-0000-0000-000000000000', true)",
      "set local mantle.write_mode = 'rw'",
    ]) {
      expect(
        await failure(
          v.asSystem(() => m.db.transaction((tx) => tx.execute(sql.raw(stmt))), 'admin-area'),
        ),
        stmt,
      ).toBeInstanceOf(ns.NarrowRouteRefusedError);
    }
    const scoped = await v.asSystem(
      () =>
        m.systemPoolTxInScope({ loginId: null, ws: [], modWs: [] }, async (tx) => {
          const rows = (await tx.execute(
            sql`select current_user as u, current_setting('mantle.ws', true) as ws`,
          )) as unknown as { u: string; ws: string }[];
          return rows[0]!;
        }),
      'admin-area',
    );
    expect(scoped).toEqual({ u: NARROW, ws: '{}' });
    expect(actor.takeNarrowDenials()).toEqual([]);
  });

  it('notes a denial a savepoint caught, and gives the real error when the work caught it', async () => {
    // Caught in a savepoint: the transaction goes on, the denial is noted.
    await v.asSystem(
      () =>
        m.db.transaction(async (tx) => {
          await tx
            .transaction((sp) => sp.execute(sql`update public.nodes set title = title where false`))
            .catch(() => null);
          await tx.execute(sql`select 1`);
        }),
      'admin-area',
    );
    expect(actor.takeNarrowDenials()).toHaveLength(1);
    // Caught by the work without a savepoint: the transaction is aborted;
    // the caller gets the refusal itself (42501), noted once, never
    // NarrowRoleLeftError.
    const err = await failure(
      v.asSystem(
        () =>
          m.db.transaction(async (tx) => {
            await tx
              .execute(sql`update public.nodes set title = title where false`)
              .catch(() => null);
          }),
        'admin-area',
      ),
    );
    expect(err).not.toBeInstanceOf(nr.NarrowRoleLeftError);
    expect(err).toMatchObject({ code: '42501' });
    expect(actor.takeNarrowDenials()).toHaveLength(1);
  });

  it('off: every reason runs as the pool login', async () => {
    await reopen(false);
    try {
      expect((await v.asSystem(who, 'admin-area')).u).toBe(pool);
      expect((await v.asSystem(whoInTx, 'admin-area')).u).toBe(pool);
      const got = await v.runInRequestSlot(async () => {
        v.noteRequestSystem('area');
        return who();
      });
      expect(got.u).toBe(pool);
      expect(actor.takeNarrowUses()).toEqual({});
    } finally {
      await reopen(true);
    }
  });

  it('the system-pool write scope carries the actor write mode (the archive path)', async () => {
    const login = randomUUID();
    const mode = (a: ReturnType<typeof actor.loginActor>) =>
      actor.runAsActor(a, () =>
        m.systemPoolTxInScope({ loginId: login, ws: [], modWs: [] }, async (tx) => {
          const rows = (await tx.execute(
            sql`select current_setting('mantle.write_mode', true) as w`,
          )) as unknown as { w: string }[];
          return rows[0]!.w;
        }),
      );
    expect(await mode(actor.loginActor(login, 'ro'))).toBe('ro');
    expect(await mode(actor.loginActor(login, 'rw'))).toBe('rw');
  });
});
