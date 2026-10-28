/**
 * The narrow system route on a real, migrated Postgres (plan v3.2 S7a part
 * a2, section 2.1 point 3): the system pool sends the work of a reason
 * routed 'narrow' (viewer.ts AS_SYSTEM_ROUTE, REQUEST_SYSTEM_ROUTE) as
 * mantle_system_narrow, with the actor's settings; a reason routed 'full',
 * system work and a rebound actor run as the pool's own login. The hold check
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
  /** A row the pool's own login may write (and the narrow role may not
   *  matter here): a miss row carrying `marker`. */
  const probeInsert = (marker: string) =>
    `insert into public.actor_check_misses (source, check_name, detail) values ('test', 'narrow-probe', '${marker}')`;
  const probeRows = async (marker: string) =>
    (
      await su<{ n: number }[]>`
        select count(*)::int as n from public.actor_check_misses
         where check_name = 'narrow-probe' and detail = ${marker}`
    )[0]!.n;
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
  /** The denials noted since the last take: each a text check's refusal
   *  (`text:<what>`, noted on the route since it is a bug of the statement),
   *  none a right the role lacks. */
  const textDenialsOnly = () => {
    const denied = actor.takeNarrowDenials();
    expect(denied.length).toBeGreaterThan(0);
    for (const d of denied) expect(d.what, d.what).toMatch(/^text:[a-z0-9-]+ \| /);
  };
  /** The pools, opened afresh. */
  const reopen = async () => {
    await m.closeDb();
    await m.systemDb.execute(sql`select 1`);
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    // No table of its own (one made and dropped races another file's GRANT
    // ... ON ALL TABLES): a row written after the role was left is a miss
    // row with the cell's marker (probeInsert), which must not survive.
    // A function that changes the role inside: no text check can see it, the
    // hold check must.
    await su.unsafe(`create function public.narrow_probe_leave() returns void
      language plpgsql as $$ begin perform set_config('role', 'none', true); end $$`);
    await su.unsafe('grant execute on function public.narrow_probe_leave() to public');
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    v = await import('./viewer');
    nr = await import('./gateway/narrow-route');
    ns = await import('./gateway/narrow-sendable');
    actor = await import('./actor');
    await reopen();
    pool = (await who()).u;
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
  });

  it('every reason picks a route', () => {
    const reasons = [...v.AS_SYSTEM_TURN_REASONS, ...v.AS_SYSTEM_OTHER_REASONS];
    expect(Object.keys(v.AS_SYSTEM_ROUTE).sort()).toEqual([...reasons].sort());
    expect(v.REQUEST_SYSTEM_ROUTE).toEqual({
      area: 'narrow',
      'login-self': 'narrow',
      'first-owner': 'full',
    });
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
      // On the measured allowlist (access-matrix.ts NARROW_WRITES): the
      // users area's delete of a login's unclaimed pairing codes (traces'
      // delete left the list with the ledger's own tokens; audit_log is
      // INSERT only).
      () => m.db.execute(sql`delete from public.pairing_codes where false`),
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

  it('a function that changes the role has nowhere to go on the login pool; the SET route (per-database) rolls it back; transaction control is refused', async () => {
    // The login pool (plan v3.2 S7b): the session is the narrow role's own,
    // so a role change inside a function lands on the narrow role again.
    const left = (await v.asSystem(
      () =>
        m.db.transaction(async (tx) => {
          await tx.execute(sql`select public.narrow_probe_leave()`);
          return tx.execute(sql`select current_user::text as u, session_user::text as s`);
        }),
      'admin-area',
    )) as unknown as { u: string; s: string }[];
    expect(left[0]).toEqual({ u: NARROW, s: NARROW });
    // The SET route, which a per-database box still takes (the role has no
    // login there): the hold check rolls the work back.
    const pools = await import('./gateway/pools');
    expect(
      await failure(
        v.asSystem(
          () =>
            nr.narrowStatement(
              pools.rawAdminSql(),
              'select public.narrow_probe_leave()',
              [],
              'rows',
            ),
          'admin-area',
        ),
      ),
    ).toBeInstanceOf(nr.NarrowRoleLeftError);
    const marker = `narrow-left-${randomUUID()}`;
    expect(
      await failure(
        v.asSystem(
          () =>
            nr.narrowBegin(pools.rawAdminSql(), [
              async (tx: postgres.TransactionSql) => {
                await tx.unsafe('select public.narrow_probe_leave()');
                // As the session's own login now: the hold check must undo this.
                await tx.unsafe(probeInsert(marker));
              },
            ]),
          'admin-area',
        ),
      ),
    ).toBeInstanceOf(nr.NarrowRoleLeftError);
    expect(await probeRows(marker)).toBe(0);
    for (const stmt of ['vacuum', 'commit', 'select 1; commit', 'select 1; set role none']) {
      expect(
        await failure(v.asSystem(() => m.db.execute(sql.raw(stmt)), 'admin-area')),
        stmt,
      ).toBeInstanceOf(ns.NarrowRouteRefusedError);
    }
    textDenialsOnly();
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
    textDenialsOnly();
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
          ${probeInsert(marker)};
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
    expect(await probeRows(marker)).toBe(0);
    // Sent: a literal mantle.* name with a bound value, a named local
    // setting, set_config inside an expression.
    for (const stmt of [
      sql`select set_config('mantle.ingest_notify', ${'x'}, true)`,
      sql`select set_config('lock_timeout', ${'5s'}, true)`,
      sql.raw("select (set_config('mantle.keep_updated_at', 'on', true))::text as v"),
      sql.raw("select 'set_config(''role'', ''none'', true)' as x"),
      sql.raw('select 1 as "do"'),
    ]) {
      await v.asSystem(() => m.db.transaction((tx) => tx.execute(stmt)), 'admin-area');
    }
    textDenialsOnly();
  });

  it("refuses the a3 audit's forms, each of which leaves the role on Postgres when sent unguarded", async () => {
    const pools = await import('./gateway/pools');
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
      // A line comment ends at a carriage return too: what follows it is a
      // statement of its own.
      ['comment to CR', 'select 1 --x\r; reset role', true],
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
    textDenialsOnly();
  });

  it('reads the text as Postgres does (one reader, sql-text.ts): each form leaves the role unguarded, and is refused', async () => {
    const forms: [string, string, boolean][] = [
      // Block comments nest: `/* /* */ ' */` is one comment.
      ['nested comment', "select 1 /* /* */ ' */; reset role; select ' '", true],
      // The same at the start (statementBody): `select */` is comment.
      ['nested leading comment', '/* /* */ select */ reset role', false],
      // A dollar quote's tag may hold characters that are not ASCII.
      ['tag not ASCII', "select $é$'$é$; reset role; select '1'", true],
      // A name may too: aé$q$ and b$q$ are names, no dollar quote between.
      ['name not ASCII', 'select 1 as aé$q$; reset role; select 1 as b$q$', true],
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
    // A function that runs its text as SQL: the text is a string the check
    // never reads. query_to_xml leaves the role unguarded; refused routed.
    const runner =
      "select query_to_xml('select set_config(''role'', ''none'', true)', true, true, '')";
    expect(await unguarded((t) => t.unsafe(runner)), 'query_to_xml: unguarded').toBe('postgres');
    for (const stmt of [
      runner,
      "select pgboss.job_table_run('select set_config(''role'', ''none'', true)')",
    ]) {
      expect(
        await failure(
          v.asSystem(() => m.db.transaction((tx) => tx.execute(sql.raw(stmt))), 'admin-area'),
        ),
        stmt,
      ).toBeInstanceOf(ns.NarrowRouteRefusedError);
    }
    // Text that never closes, or that Postgres may read otherwise.
    for (const stmt of ['select 1 /* x', "select 'a\\'"]) {
      expect(
        await failure(v.asSystem(() => m.db.execute(sql.raw(stmt)), 'admin-area')),
        stmt,
      ).toBeInstanceOf(ns.NarrowRouteRefusedError);
    }
    textDenialsOnly();
  });

  it("refuses a call whose effect outlives the transaction (each lasts past COMMIT sent unguarded); the transaction's own advisory locks are sent", async () => {
    /** Sent with no guard as the narrow role on the superuser's one
     *  session, and committed: what is left on the session afterwards. */
    const committed = <T extends object>(stmt: string) =>
      su.begin(async (t) => {
        await t.unsafe(`select set_config('role', '${NARROW}', true)`);
        return t.unsafe<T[]>(stmt);
      }) as Promise<T[]>;
    // pg_trgm's set_limit and setseed change the pooled session.
    await committed('select set_limit(0.11)');
    expect((await su<{ l: number }[]>`select show_limit() as l`)[0]!.l).toBeCloseTo(0.11);
    await su`select set_limit(0.3)`;
    await committed('select setseed(0.25)');
    const [after] = await su<{ r: number }[]>`select random() as r`;
    await su`select setseed(0.25)`;
    const [seeded] = await su<{ r: number }[]>`select random() as r`;
    expect(after!.r).toBe(seeded!.r);
    // A session advisory lock stays held on the session.
    const held = async () =>
      (
        await su<{ n: number }[]>`
          select count(*)::int as n from pg_locks
           where locktype = 'advisory' and pid = pg_backend_pid()`
      )[0]!.n;
    await committed('select pg_advisory_lock(7771)');
    expect(await held()).toBe(1);
    await su`select pg_advisory_unlock_all()`;
    expect(await held()).toBe(0);
    // A large object: the narrow role may make none (EXECUTE on the
    // creators is taken from PUBLIC at migrate, runtime-role.ts
    // revokeLargeObjectCreators), sent unguarded too.
    for (const stmt of ['select lo_create(0)', "select lo_from_bytea(0, '\\x01'::bytea)"]) {
      expect(await failure(committed(stmt)), stmt).toMatchObject({ code: '42501' });
    }

    // Routed: each refused, alone and in a transaction.
    for (const stmt of [
      'select set_limit(0.11)',
      'select setseed(0.25)',
      'select pg_advisory_lock(7771)',
      'select pg_advisory_lock_shared(7771)',
      'select pg_try_advisory_lock(7771)',
      'select pg_try_advisory_lock_shared(7771)',
      'select pg_advisory_unlock_all()',
      'select lo_create(0)',
      'select lo_creat(-1)',
      "select lo_from_bytea(0, '\\x01'::bytea)",
      "select lo_import('/etc/hosts')",
      "select lowrite(lo_open(1, 131072), '\\x01'::bytea)",
    ]) {
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
    expect(
      (await su<{ n: number }[]>`select count(*)::int as n from pg_largeobject_metadata`)[0]!.n,
    ).toBe(0);

    // The transaction's own advisory locks (share-lock.ts, advisory-lock.ts)
    // are sent on the narrow route and end with it.
    const al = await import('./advisory-lock');
    const xact = await v.asSystem(
      () =>
        m.db.transaction(async (tx) => {
          await al.advisoryXactLock(tx, 'narrow-probe-xact', 'hashtextextended');
          const locked = await al.tryAdvisoryXactLock(tx, 'narrow-probe-try', 'hashtext');
          await tx.execute(sql`select pg_advisory_xact_lock_shared(7772)`);
          const rows = (await tx.execute(sql`select current_user as u`)) as unknown as {
            u: string;
          }[];
          return { u: rows[0]!.u, locked };
        }),
      'admin-area',
    );
    expect(xact).toEqual({ u: NARROW, locked: true });
    expect(
      (
        await su<{ n: number }[]>`
          select count(*)::int as n from pg_locks
           where locktype = 'advisory'
             and database = (select oid from pg_database where datname = current_database())`
      )[0]!.n,
    ).toBe(0);
    textDenialsOnly();
  });

  it('a begin whose work returns an array of statements sends them all before the COMMIT and answers their results, on every route', async () => {
    const pools = await import('./gateway/pools');
    type Tx = postgres.TransactionSql & {
      unsafe: (q: string) => PromiseLike<unknown> & { values: () => PromiseLike<unknown> };
    };
    const insert = (marker: string) => `${probeInsert(marker)} returning detail`;
    const both = (a: string, b: string) =>
      pools.adminSql().begin((raw) => {
        const t = raw as unknown as Tx;
        return [t.unsafe(insert(a)), t.unsafe(insert(b)).values()];
      }) as unknown as Promise<[{ detail: string }[], string[][]]>;
    const full = (Object.keys(v.AS_SYSTEM_ROUTE) as (keyof typeof v.AS_SYSTEM_ROUTE)[]).find(
      (r) => v.AS_SYSTEM_ROUTE[r] === 'full',
    )!;
    const runs: [string, (w: () => Promise<unknown>) => Promise<unknown>][] = [
      ['narrow', (w) => v.asSystem(w, 'admin-area')],
      ['full', (w) => v.asSystem(w, full)],
      ['no exit', (w) => w()],
    ];
    for (const [route, run] of runs) {
      const a = `array-a-${route}-${randomUUID()}`;
      const b = `array-b-${route}-${randomUUID()}`;
      const out = (await run(() => both(a, b))) as [{ detail: string }[], string[][]];
      expect(
        out[0].map((r) => r.detail),
        route,
      ).toEqual([a]);
      expect(out[1], route).toEqual([[b]]);
      expect([await probeRows(a), await probeRows(b)], route).toEqual([1, 1]);
      await su`delete from public.actor_check_misses
                where check_name = 'narrow-probe' and detail in (${a}, ${b})`;
    }
    expect(actor.takeNarrowDenials()).toEqual([]);
  });

  it("sends a transaction's statements in the order they are awaited, on every route", async () => {
    const pools = await import('./gateway/pools');
    type Tx = postgres.TransactionSql & {
      unsafe: (q: string) => PromiseLike<unknown> & {
        simple: () => PromiseLike<unknown>;
        values: () => PromiseLike<unknown>;
      };
    };
    /** Pipelined, awaited together: SET TRANSACTION READ ONLY first, then
     *  five statements in every form a caller sends (plain, simple, values,
     *  a tagged template), each appending its letter to a setting and
     *  answering what it found: the order they ran in. */
    const pipelined = () =>
      pools.adminSql().begin(async (raw) => {
        const t = raw as unknown as Tx;
        const step = (c: string) =>
          `select current_setting('transaction_read_only') as ro, current_user as u, ` +
          `set_config('mantle.order_probe', coalesce(current_setting('mantle.order_probe', true), '') || '${c}', true) as seen`;
        const answers = (await Promise.all([
          t.unsafe('set transaction read only'),
          t.unsafe(step('a')),
          t.unsafe(step('b')).simple(),
          t.unsafe(step('c')).values(),
          t`select current_setting('transaction_read_only') as ro, current_user as u, set_config('mantle.order_probe', current_setting('mantle.order_probe', true) || 'd', true) as seen`,
          t.unsafe(step('e')),
        ])) as unknown[];
        const row = (r: unknown): string[] => {
          const first = (r as unknown[])[0] as Record<string, string> | string[];
          return Array.isArray(first) ? first : [first.ro!, first.u!, first.seen!];
        };
        return answers.slice(1).map(row);
      });
    const expected = (u: string) => [
      ['on', u, 'a'],
      ['on', u, 'ab'],
      ['on', u, 'abc'],
      ['on', u, 'abcd'],
      ['on', u, 'abcde'],
    ];
    // The narrow route (an Admin area exit), a full reason, and no exit.
    expect(await v.asSystem(pipelined, 'admin-area')).toEqual(expected(NARROW));
    const full = (Object.keys(v.AS_SYSTEM_ROUTE) as (keyof typeof v.AS_SYSTEM_ROUTE)[]).find(
      (r) => v.AS_SYSTEM_ROUTE[r] === 'full',
    )!;
    expect(await v.asSystem(pipelined, full)).toEqual(expected(pool));
    expect(await pipelined()).toEqual(expected(pool));
    // The same through drizzle: a SET TRANSACTION as its first statement
    // makes the transaction read only before the read.
    const ro = await v.asSystem(
      () =>
        m.db.transaction(
          async (tx) =>
            (
              (await tx.execute(
                sql`select current_setting('transaction_read_only') as ro, current_user as u`,
              )) as unknown as { ro: string; u: string }[]
            )[0]!,
          { accessMode: 'read only' },
        ),
      'admin-area',
    );
    expect(ro).toEqual({ ro: 'on', u: NARROW });
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

  it('notes a text refusal on the route once, as text:<what>: alone, in a transaction, a tagged template and a savepoint', async () => {
    actor.takeNarrowDenials();
    const pools = await import('./gateway/pools');
    // One after another: the notes' order is the sends'.
    const refused = [
      // Alone (narrowStatement: on the login pool and the SET route alike).
      () => v.asSystem(() => m.db.execute(sql.raw('commit')), 'admin-area'),
      // A transaction's statement.
      () =>
        v.asSystem(
          () => m.db.transaction((tx) => tx.execute(sql.raw('set role none'))),
          'admin-area',
        ),
      // A tagged template in a narrow transaction.
      () =>
        v.asSystem(
          () =>
            nr.narrowBegin(pools.rawAdminSql(), [
              async (tx: postgres.TransactionSql) => {
                await tx`do $$ begin perform 1; end $$`;
              },
            ]),
          'admin-area',
        ),
      // A savepoint's statement.
      () =>
        v.asSystem(
          () => m.db.transaction((tx) => tx.transaction((sp) => sp.execute(sql.raw('vacuum')))),
          'admin-area',
        ),
    ];
    for (const send of refused)
      expect(await failure(send())).toBeInstanceOf(ns.NarrowRouteRefusedError);
    expect(actor.takeNarrowDenials().map((d) => d.what.split(' | ')[0])).toEqual([
      'text:a-transaction-control-statement',
      'text:a-role-change',
      'text:a-do-block',
      'text:a-statement-outside-a-transaction',
    ]);
  });

  it('does not note a 42501 the work threw that no narrow statement raised', async () => {
    // Another pool's refusal (here its shape) thrown out of a narrow
    // transaction's work: the caller gets it, nothing is noted as narrow.
    const elsewhere = Object.assign(new Error('permission denied for table nodes'), {
      code: '42501',
    });
    const err = await failure(
      v.asSystem(
        () =>
          m.db.transaction(async (tx) => {
            await tx.execute(sql`select 1`);
            throw elsewhere;
          }),
        'admin-area',
      ),
    );
    expect(err).toBe(elsewhere);
    expect(actor.takeNarrowDenials()).toHaveLength(0);
    // A narrow statement's own refusal thrown out of the work: noted once.
    await failure(
      v.asSystem(
        () =>
          m.db.transaction(async (tx) => {
            await tx.execute(sql`update public.nodes set title = title where false`);
          }),
        'admin-area',
      ),
    );
    expect(actor.takeNarrowDenials()).toHaveLength(1);
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
