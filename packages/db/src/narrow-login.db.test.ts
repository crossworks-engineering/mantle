/**
 * The narrow route's own login (plan v3.2 S7b part b1): the route's pool
 * logs in as mantle_system_narrow itself, so a narrow session holds no
 * other role to go back to. The class the S7a audits found form by form
 * (MED-A, MED-1: a statement that resets or changes the role) closes.
 *
 *  - Every escape form the S7a audits found, sent with no guard on a
 *    session logged in as the narrow role: the session is the narrow role
 *    after it, and a content write refused (42501), its row absent.
 *  - The narrow login may SET ROLE to nothing, has no SET SESSION
 *    AUTHORIZATION, makes no temporary object, may run no pg-boss routine,
 *    and runs only the definers on NARROW_SYSTEM_FUNCTIONS and
 *    NARROW_PUBLIC_DEFINERS.
 *  - The route: a narrow statement and a transaction run on the login pool
 *    (session_user is the narrow role), opened on the first narrow
 *    statement; no gateway setting may be named by a narrow statement, one
 *    cell per name.
 *  - The acting login: a request exit's actor carries it, on the narrow
 *    route and on the full route in every check mode. The definers that
 *    take only it with no scope land with part b2.
 */
import { createHash, createHmac, pbkdf2Sync, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase, ensureTestAnchor } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const NARROW = 'mantle_system_narrow';

/** Whether a SCRAM-SHA-256 verifier (pg_authid.rolpassword) is the one of
 *  `password` (RFC 5802: StoredKey = H(HMAC(SaltedPassword, "Client Key"))). */
function scramMatches(verifier: string, password: string): boolean {
  const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):/.exec(verifier);
  if (!m) return false;
  const salted = pbkdf2Sync(password, Buffer.from(m[2]!, 'base64'), Number(m[1]), 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  return createHash('sha256').update(clientKey).digest('base64') === m[3];
}

describe.skipIf(!URL)('the narrow route logs in as the narrow role (plan v3.2 S7b)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let m: typeof import('./index');
  let v: typeof import('./viewer');
  let rr: typeof import('./runtime-role');
  let ns: typeof import('./gateway/narrow-sendable');
  let pools: typeof import('./gateway/pools');
  let as: typeof import('./gateway/actor-sql');
  let nr: typeof import('./gateway/narrow-route');
  let su: ReturnType<typeof postgres>;
  /** A session logged in as the narrow role, one connection. */
  let nl: ReturnType<typeof postgres>;
  let brain = '';
  let dbName = '';

  const KEY = () => process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';
  /** The narrow role's own URL, with its derived password. */
  const narrowUrlOf = () =>
    rr.runtimeDatabaseUrl(scratch.url, rr.narrowRolePassword(KEY()), rr.NARROW_ROLE);

  /** The error a promise failed with (drizzle wraps the driver's). */
  const failure = async (p: PromiseLike<unknown>): Promise<{ code?: string; message?: string }> => {
    try {
      await p;
    } catch (err) {
      const e = err as { cause?: unknown };
      return (e.cause ?? err) as { code?: string; message?: string };
    }
    throw new Error('expected a failure');
  };
  /** A content write as the session's role: refused on the narrow role. */
  const contentProbe = (marker: string) =>
    `insert into public.nodes (id, owner_id, type, title, path)
       values ('${randomUUID()}', '${brain}', 'note', '${marker}', 'notes')`;
  const probeRows = async (marker: string) =>
    (
      await su<{ n: number }[]>`select count(*)::int as n from public.nodes where title = ${marker}`
    )[0]!.n;
  const whoNl = async () =>
    (
      await nl.unsafe<{ u: string; s: string }[]>(
        'select current_user::text as u, session_user::text as s',
      )
    )[0]!;
  const reopen = async (on: boolean) => {
    await m.closeDb();
    rr.setNarrowSystemForTests(on);
    await m.systemDb.execute(sql`select 1`);
  };
  /** The test's own narrow session's backend: not the pool's. */
  let nlPid = 0;
  const narrowBackends = async () =>
    (
      await su<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where usename = ${NARROW} and datname = ${dbName} and pid <> ${nlPid}`
    )[0]!.n;

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    brain = await ensureTestAnchor(su);
    dbName = new globalThis.URL(scratch.url).pathname.slice(1);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    rr = await import('./runtime-role');
    nl = postgres(
      rr.runtimeDatabaseUrl(scratch.url, rr.narrowRolePassword(KEY()), rr.NARROW_ROLE),
      { max: 1, prepare: false, onnotice: () => {} },
    );
    nlPid = (await nl.unsafe<{ p: number }[]>('select pg_backend_pid() as p'))[0]!.p;
    m = await import('./index');
    v = await import('./viewer');
    ns = await import('./gateway/narrow-sendable');
    pools = await import('./gateway/pools');
    as = await import('./gateway/actor-sql');
    nr = await import('./gateway/narrow-route');
  }, 120_000);

  afterAll(async () => {
    rr?.setNarrowSystemForTests(null);
    await m?.closeDb();
    await nl?.end();
    await su?.end();
    await scratch?.drop();
  });

  it('logs in as the narrow role: no superuser, a member of nothing', async () => {
    expect(await whoNl()).toEqual({ u: NARROW, s: NARROW });
    const [r] = await nl.unsafe<{ su: boolean; member: number }[]>(
      `select (select rolsuper from pg_roles where rolname = current_user) as su,
              (select count(*)::int from pg_auth_members m join pg_roles u on u.oid = m.member
                where u.rolname = current_user) as member`,
    );
    expect(r).toEqual({ su: false, member: 0 });
  });

  it("every S7a audit's escape form leaves the session the narrow role, and a content write after it is refused (row absent)", async () => {
    const forms: [string, string][] = [
      ['concatenated role name', "select set_config('ro' || 'le', 'none', false)"],
      ['session SET of the role', 'set role none'],
      ['reset role', 'reset role'],
      ['reset all', 'reset all'],
      ['U& name', 'set U&"r\\006Fle" to none'],
      ['comment to CR', 'select 1 --x\r; reset role'],
      ['typed literal', "select text'\\'; reset role; select '1'"],
      ['nested comment', "select 1 /* /* */ ' */; reset role; select ' '"],
      [
        'text runner',
        "select query_to_xml('select set_config(''role'', ''none'', false)', true, false, '')",
      ],
      [
        'COMMIT inside a transaction',
        "begin; select set_config('role', 'none', true); commit; reset role",
      ],
      ['pg_settings', "update pg_settings set setting = 'none' where name = 'role'"],
    ];
    for (const [name, form] of forms) {
      await nl
        .unsafe(form)
        .simple()
        .catch(() => undefined);
      expect(await whoNl(), name).toEqual({ u: NARROW, s: NARROW });
      const marker = `narrow-login-${randomUUID()}`;
      expect((await failure(nl.unsafe(contentProbe(marker)))).code, name).toBe('42501');
      expect(await probeRows(marker), name).toBe(0);
    }
    // Bound set_config: the name never shows in the text.
    await nl`select set_config(${'role'}, ${'none'}, false)`;
    expect(await whoNl()).toEqual({ u: NARROW, s: NARROW });
    // A DO block that leaves the role, writes content and takes it back:
    // there is nowhere to leave to, so its write is refused and the block
    // fails whole.
    const marker = `narrow-login-do-${randomUUID()}`;
    const doErr = await failure(
      nl.unsafe(`do $$ begin
        perform set_config('role', 'none', true);
        ${contentProbe(marker)};
        perform set_config('role', '${NARROW}', true);
      end $$`),
    );
    expect(doErr.code).toBe('42501');
    expect(await probeRows(marker)).toBe(0);
    // A function made in pg_temp: no temporary object at all.
    const temp = await failure(
      nl.unsafe(
        "create function pg_temp.narrow_leave() returns void language sql as $$ select set_config('role', 'none', true) $$",
      ),
    );
    expect(temp.code).toBe('42501');
    expect(await whoNl()).toEqual({ u: NARROW, s: NARROW });
  });

  it('may SET ROLE to nothing, has no SET SESSION AUTHORIZATION, no TEMP, no pg-boss routine', async () => {
    const [me] = await su<{ s: string }[]>`select session_user::text as s`;
    const targets = [
      'mantle_runtime',
      'mantle_owner',
      'mantle_system',
      'mantle_write_user',
      'mantle_view_user',
      me!.s,
    ];
    for (const r of targets) {
      const e = await failure(nl.unsafe(`set role "${r}"`));
      expect(e.code, r).toBe('42501');
      expect(await whoNl(), r).toEqual({ u: NARROW, s: NARROW });
    }
    expect((await failure(nl.unsafe(`set session authorization "${me!.s}"`))).code).toBe('42501');
    expect((await failure(nl.unsafe('create temp table narrow_t (x int)'))).code).toBe('42501');
    const [t] = await nl.unsafe<{ temp: boolean }[]>(
      "select has_database_privilege(current_user, current_database(), 'TEMP') as temp",
    );
    expect(t!.temp).toBe(false);
    const [pg] = await nl.unsafe<{ n: number }[]>(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'pgboss' and has_function_privilege(current_user, p.oid, 'EXECUTE')`,
    );
    expect(pg!.n).toBe(0);
  });

  it('runs no definer but those on NARROW_SYSTEM_FUNCTIONS and NARROW_PUBLIC_DEFINERS', async () => {
    const listed = [
      ...Object.keys(rr.NARROW_SYSTEM_FUNCTIONS),
      ...Object.keys(rr.NARROW_PUBLIC_DEFINERS),
    ];
    const rows = await nl.unsafe<{ fn: string }[]>(
      `select p.oid::regprocedure::text as fn
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')
          and has_function_privilege(current_user, p.oid, 'EXECUTE')
          and p.oid not in (select to_regprocedure(x) from unnest($1::text[]) x
                             where to_regprocedure(x) is not null)
        order by 1`,
      [listed],
    );
    expect(rows.map((r) => r.fn)).toEqual([]);
    // A denied content writer, called: refused.
    const e = await failure(
      nl.unsafe('select public.mantle_entity_merge_rows(null::uuid, null::uuid, null::uuid)'),
    );
    expect(['42501', '42883']).toContain(e.code);
  });

  it('the route runs on the login pool, opened on the first narrow statement', async () => {
    await reopen(true);
    // System statements only: no narrow connection yet.
    await m.systemDb.execute(sql`select 1`);
    // The closed pool's backends leave the server a moment after its end.
    let before = await narrowBackends();
    for (let i = 0; i < 40 && before > 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      before = await narrowBackends();
    }
    expect(before).toBe(0);
    const one = (await v.asSystem(
      () =>
        m.db.execute(sql`select current_user::text as u, session_user::text as s,
                                     current_setting('mantle.actor', true) as a`),
      'admin-area',
    )) as unknown as { u: string; s: string; a: string }[];
    expect(one[0]).toEqual({ u: NARROW, s: NARROW, a: 'system:admin-area' });
    expect(await narrowBackends()).toBeGreaterThan(0);
    const tx = (await v.asSystem(
      () =>
        m.db.transaction((t) =>
          t.execute(sql`select current_user::text as u, session_user::text as s`),
        ),
      'admin-area',
    )) as unknown as { u: string; s: string }[];
    expect(tx[0]).toEqual({ u: NARROW, s: NARROW });
  });

  /** A narrow statement outside a transaction in a request exit of
   *  `login` (the Admin area's: the narrow route), its backend and what it
   *  saw of the gateway's settings. */
  const exitRead = (login: string) =>
    m.runInRequestSlot(async () => {
      m.setRequestActor(m.loginActor(login, 'rw'));
      m.noteRequestSystem('area');
      const rows = (await m.db.execute(sql`select pg_backend_pid() as p,
               session_user::text as s,
               coalesce(current_setting('mantle.acting_login', true), '') as l,
               coalesce(current_setting('mantle.actor', true), '') as a`)) as unknown as {
        p: number;
        s: string;
        l: string;
        a: string;
      }[];
      return rows[0]!;
    });

  /** Every connection of the narrow pool, held at once (so the one a
   *  statement used is among them, once its RESET let it go), with what
   *  each session holds of the gateway's settings, outside a transaction. */
  const narrowPoolSessions = async () => {
    const pool = (globalThis as unknown as { __mantleNarrowSql: ReturnType<typeof postgres> })
      .__mantleNarrowSql;
    const held = await Promise.all(
      Array.from({ length: pools.NARROW_POOL_MAX }, () => pool.reserve()),
    );
    try {
      return await Promise.all(
        held.map(async (r) => {
          const [row] = await r.unsafe<{ p: number; l: string; a: string }[]>(
            `select pg_backend_pid() as p,
                    coalesce(current_setting('mantle.acting_login', true), '') as l,
                    coalesce(current_setting('mantle.actor', true), '') as a`,
          );
          return row!;
        }),
      );
    } finally {
      for (const r of held) r.release();
    }
  };

  it('the session SET is gone after the statement: the same connection, outside a transaction, holds none of it', async () => {
    await reopen(true);
    const login = randomUUID();
    const seen = await exitRead(login);
    expect(seen).toMatchObject({ s: NARROW, l: login, a: 'system:http:admin-area' });
    const sessions = await narrowPoolSessions();
    // The statement's own connection is one of them, and it holds nothing.
    expect(sessions.map((x) => x.p)).toContain(seen.p);
    for (const x of sessions) expect(x).toEqual({ p: x.p, l: '', a: '' });
  });

  it('60 parallel narrow statements of two acting logins: each sees its own, none crosses', async () => {
    await reopen(true);
    const a = randomUUID();
    const b = randomUUID();
    const runs = Array.from({ length: 60 }, (_, i) => (i % 2 ? a : b));
    const seen = await Promise.all(runs.map((login) => exitRead(login)));
    const cross = seen.filter((x, i) => x.l !== runs[i]).length;
    expect({ cross, sessions: new Set(seen.map((x) => x.s)) }).toEqual({
      cross: 0,
      sessions: new Set([NARROW]),
    });
    // At most the pool's size of connections served the 60.
    expect(new Set(seen.map((x) => x.p)).size).toBeLessThanOrEqual(pools.NARROW_POOL_MAX);
    for (const x of await narrowPoolSessions()) expect([x.l, x.a]).toEqual(['', '']);
  });

  it("the narrow pool's startup parameters: the app's values and the system pool's session-start ones, over any setting stored on the role", async () => {
    await reopen(true);
    // The system pool's session-start values, read once (a session SET of
    // the system pool after it never reaches a narrow connect).
    await nr.systemStartup(su);
    await su.unsafe(`set timezone = 'Pacific/Chatham'`);
    expect(su.parameters.TimeZone).toBe('Pacific/Chatham');
    const pool = pools.newNarrowPool(
      rr.runtimeDatabaseUrl(scratch.url, rr.narrowRolePassword(KEY()), rr.NARROW_ROLE),
      su,
    );
    try {
      const start = nr.systemStartupOf(su)!;
      expect(start.TimeZone).not.toBe('Pacific/Chatham');
      const want = pools.narrowStartup(start);
      const keys = Object.keys(want);
      const [row] = await pool.unsafe<Record<string, string>[]>(
        `select ${keys.map((k) => `current_setting('${k}') as "${k}"`).join(', ')}`,
      );
      expect(row).toEqual(want);
      // The fixed ones, and the system pool's own TimeZone and DateStyle.
      expect(want).toMatchObject({
        search_path: '"$user", public',
        statement_timeout: '0',
        TimeZone: start.TimeZone,
        DateStyle: start.DateStyle,
      });
      expect(pool.options.max).toBe(pools.NARROW_POOL_MAX);
    } finally {
      await su.unsafe('reset timezone');
      await pool.end();
    }
  });

  it('a setting the narrow login stores on itself: the pool overrides it, the boot line names it, migrate takes it back', async () => {
    // Stored by the narrow login itself: every database's (a harmless one,
    // the role is the cluster's and other test files use it now) and this
    // database's own (search_path: a session without the startup
    // parameters would take it).
    await nl.unsafe(`alter role current_user set application_name = 'narrow-cell'`);
    await nl.unsafe(`alter role current_user in database "${dbName}" set search_path = pg_catalog`);
    const stored = async () =>
      (
        await su<{ n: number }[]>`
          select count(*)::int as n from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
           where r.rolname = ${NARROW}`
      )[0]!.n;
    expect(await stored()).toBe(2);
    const raw = postgres(
      rr.runtimeDatabaseUrl(scratch.url, rr.narrowRolePassword(KEY()), rr.NARROW_ROLE),
      { max: 1, prepare: false, onnotice: () => {} },
    );
    const pool = pools.newNarrowPool(
      rr.runtimeDatabaseUrl(scratch.url, rr.narrowRolePassword(KEY()), rr.NARROW_ROLE),
      su,
    );
    try {
      const sp = `select current_setting('search_path') as sp`;
      expect((await raw.unsafe<{ sp: string }[]>(sp))[0]!.sp).toBe('pg_catalog');
      expect((await pool.unsafe<{ sp: string }[]>(sp))[0]!.sp).toBe('"$user", public');
    } finally {
      await raw.end();
      await pool.end();
    }
    // The boot line names it (read as the system pool reads it).
    const probe = await rr.readNarrowLogin(su);
    expect(probe).toEqual({ login: true, settings: 2 });
    expect(rr.narrowLoginNote(probe!, true)).toMatch(/2 stored setting row\(s\).*next migrate/);
    // migrate's role step takes every one back.
    await rr.ensureRuntimeRoles(su, KEY(), { login: true, narrowLogin: true, warn: () => {} });
    expect(await stored()).toBe(0);
  });

  it('every pinned setting, stored by the narrow login: a raw session takes it, the pool pins it, migrate takes it back', async () => {
    // This database's own (IN DATABASE): the role is the cluster's, and the
    // test files beside this one log in as it.
    const stored: [string, string][] = [
      ['default_transaction_read_only', 'on'],
      ['default_transaction_isolation', 'serializable'],
      ['row_security', 'off'],
      ['statement_timeout', '50'],
      ['lock_timeout', '1'],
      ['idle_in_transaction_session_timeout', '600000'],
      ['idle_session_timeout', '600000'],
      ['transaction_timeout', '600000'],
      ['bytea_output', 'escape'],
      ['extra_float_digits', '-15'],
      ['exit_on_error', 'on'],
      ['synchronous_commit', 'off'],
      ['array_nulls', 'off'],
      ['transform_null_equals', 'on'],
      ['xmloption', 'document'],
      ['gin_fuzzy_search_limit', '1'],
      ['TimeZone', 'Pacific/Chatham'],
      ['DateStyle', 'German, DMY'],
      ['IntervalStyle', 'sql_standard'],
      ['timezone_abbreviations', 'India'],
    ];
    for (const [name, value] of stored) {
      await nl.unsafe(`alter role current_user in database "${dbName}" set ${name} = '${value}'`);
    }
    const count = async () =>
      (
        await su<{ n: number }[]>`
          select count(*)::int as n from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
           join pg_database d on d.oid = s.setdatabase
           where r.rolname = ${NARROW} and d.datname = ${dbName}`
      )[0]!.n;
    expect(await count()).toBe(1);
    const read = `select ${stored.map(([n]) => `current_setting('${n}') as "${n}"`).join(', ')},
                         current_setting('transaction_read_only') as ro`;
    // A session without the startup parameters takes them: read only, and
    // a statement cut short (the auditor's P4).
    const raw = postgres(narrowUrlOf(), { max: 1, prepare: false, onnotice: () => {} });
    // The route reads the system pool's session-start values before a
    // narrow connect (systemStartup); the pool takes them at connect.
    await nr.systemStartup(su);
    const pool = pools.newNarrowPool(narrowUrlOf(), su);
    try {
      const [rawRow] = await raw.unsafe<Record<string, string>[]>(read);
      expect(rawRow).toMatchObject({ default_transaction_read_only: 'on', ro: 'on' });
      expect(await failure(raw.unsafe('select pg_sleep(0.2)'))).toMatchObject({ code: '57014' });
      // The pool's session: every one at the value the app runs with.
      expect(rawRow).toMatchObject({ exit_on_error: 'on', array_nulls: 'off' });
      const [row] = await pool.unsafe<Record<string, string>[]>(read);
      const want = pools.narrowStartup(nr.systemStartupOf(su)!);
      for (const [name] of stored) {
        expect(row![name], name).toBe(want[name]);
        expect(want[name], name).toBeDefined();
      }
      expect(row!.ro).toBe('off');
      await pool.unsafe('select pg_sleep(0.2)');
    } finally {
      await raw.end();
      await pool.end();
    }
    // migrate's role step takes them back.
    await rr.ensureRuntimeRoles(su, KEY(), { login: true, narrowLogin: true, warn: () => {} });
    expect(await count()).toBe(0);
  });

  it('the narrow login may make no large object: EXECUTE on the creators is taken from PUBLIC at migrate', async () => {
    for (const q of [
      'select lo_create(0)',
      'select lo_creat(-1)',
      "select lo_from_bytea(0, '\\x01'::bytea)",
      "select pg_catalog.lo_from_bytea(0, '\\x01'::bytea)",
      "select lo_import('/etc/hosts')",
    ]) {
      expect(await failure(nl.unsafe(q)), q).toMatchObject({ code: '42501' });
    }
    const [n] = await su<{ n: number }[]>`select count(*)::int as n from pg_largeobject_metadata`;
    expect(n!.n).toBe(0);
    const [acl] = await su<{ pub: number }[]>`
      select count(*)::int as pub from pg_proc p
       where p.oid = any(${[...rr.LARGE_OBJECT_CREATORS]}::regprocedure[])
         and has_function_privilege('public', p.oid, 'EXECUTE')`;
    expect(acl!.pub).toBe(0);
  });

  it('every migrate run sets the derived password again (the login changing its own, committed: narrow-password.serial.db.test.ts)', async () => {
    // Each run's statement for the role carries the derived password.
    const stmts = rr.runtimeRoleStatements(new Set([NARROW]), null, rr.narrowRolePassword(KEY()));
    expect(stmts.filter((x) => x.startsWith(`ALTER ROLE "${NARROW}"`))).toEqual([
      expect.stringContaining(`PASSWORD '${rr.narrowRolePassword(KEY())}'`),
    ]);
    // And after a run the stored verifier is the derived password's.
    await rr.ensureRuntimeRoles(su, KEY(), { login: true, narrowLogin: true, warn: () => {} });
    const [auth] = await su<{ v: string }[]>`
      select rolpassword as v from pg_authid where rolname = ${NARROW}`;
    expect(scramMatches(auth!.v, rr.narrowRolePassword(KEY()))).toBe(true);
    expect(scramMatches(auth!.v, 'not-the-derived-one')).toBe(false);
  });

  it('a pool that cannot log in as the narrow role fails the statement, closed, with the fix named', async () => {
    await reopen(true);
    const bad = pools.newNarrowPool(
      rr.runtimeDatabaseUrl(scratch.url, 'not-the-derived-one', rr.NARROW_ROLE),
      su,
    );
    const g = globalThis as unknown as { __mantleNarrowSql?: unknown };
    const good = g.__mantleNarrowSql;
    g.__mantleNarrowSql = bad;
    try {
      for (const run of [
        () => m.db.execute(sql`select 1`),
        () => m.db.transaction((t) => t.execute(sql`select 1`)),
      ]) {
        const err = await v.asSystem(run, 'admin-area').then(
          () => null,
          (e: unknown) => e,
        );
        const named = [err, (err as { cause?: unknown })?.cause].find(
          (e) => e instanceof nr.NarrowLoginError,
        ) as Error | undefined;
        expect(named?.message).toMatch(
          /cannot log in as mantle_system_narrow \(28P01\).*run migrate with MANTLE_NARROW_SYSTEM on/,
        );
      }
    } finally {
      g.__mantleNarrowSql = good;
      // A pool whose logins all failed ends only by its timeout.
      await bad.end({ timeout: 1 });
    }
    expect(rr.narrowLoginNote({ login: false, settings: 0 }, true)).toMatch(
      /cannot log in: every narrow statement fails until you run migrate with MANTLE_NARROW_SYSTEM on/,
    );
  });

  it('one pipeline for both pools, one failure answer (settingsPipeline), on one pool of one connection', async () => {
    // One pool of ONE connection for every case: each case's connection is
    // the one the next statement gets, and a case whose connection ended
    // leaves the pool to open it again for the next (a reserve queued as a
    // connection closes is answered: patches/postgres@3.4.9.patch).
    const pool = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    const alive = async (pid: number) =>
      (
        await su<
          { n: number }[]
        >`select count(*)::int as n from pg_stat_activity where pid = ${pid}`
      )[0]!.n === 1;
    const gone = async (pid: number) => {
      for (let i = 0; i < 40 && (await alive(pid)); i++)
        await new Promise((r) => setTimeout(r, 50));
      return !(await alive(pid));
    };
    const run = (set: string, query: string, reset = 'reset mantle.cell') =>
      as
        .settingsPipeline(pool, () => set, query, [], 'rows', reset)
        .then(
          (rows) => ({ ok: (rows as { p: number; c: string }[])[0]! }),
          (err: { code?: string }) => ({ err: err.code }),
        );
    const SET = `select set_config('mantle.cell', 'x', false)`;
    const READ = `select pg_backend_pid() as p, current_setting('mantle.cell', true) as c`;
    const next = async () => (await pool.unsafe<{ p: number; c: string | null }[]>(READ))[0]!;
    try {
      // All well: the statement's answer, the setting on while it ran, the
      // connection handed back with it reset.
      const ok = await run(SET, READ);
      expect(ok).toMatchObject({ ok: { c: 'x' } });
      expect(await next()).toEqual({ p: (ok as { ok: { p: number } }).ok.p, c: '' });
      // The SET failed, the statement ran: the statement's own answer (it
      // committed), and the connection ends; the pool answers on a new one.
      const setFailed = await run('select 1/0', READ);
      expect(['', null]).toContain((setFailed as { ok: { c: string | null } }).ok.c);
      const setFailedPid = (setFailed as { ok: { p: number } }).ok.p;
      expect(await gone(setFailedPid)).toBe(true);
      expect((await next()).p).not.toBe(setFailedPid);
      // Both failed: the SET's error (the cause).
      expect(await run('select 1/0', 'select no_such_column')).toEqual({ err: '22012' });
      // The statement failed alone: its own error; the connection goes back.
      const pid = (await next()).p;
      expect(await run(SET, 'select no_such_column')).toEqual({ err: '42703' });
      expect(await next()).toEqual({ p: pid, c: '' });
      // The RESET failed: the caller has its answer, the connection ends.
      const resetFailed = await run(SET, READ, 'select 1/0');
      expect(resetFailed).toMatchObject({ ok: { c: 'x' } });
      expect(await gone((resetFailed as { ok: { p: number } }).ok.p)).toBe(true);
      expect(['', null]).toContain((await next()).c);
      // A SET text that throws: that error, before any connection is taken.
      const thrown = await as
        .settingsPipeline(
          pool,
          () => {
            throw Object.assign(new Error('refused'), { code: 'SETX' });
          },
          READ,
          [],
          'rows',
          'reset mantle.cell',
        )
        .then(
          () => null,
          (e: { code?: string }) => e.code,
        );
      expect(thrown).toBe('SETX');
      // A pipeline queued behind one whose SET fails (its connection ends
      // as the second waits for the pool's only connection): answered.
      const [first, second] = await Promise.all([run('select 1/0', READ), run(SET, READ)]);
      expect(first).toHaveProperty('ok');
      expect(second).toMatchObject({ ok: { c: 'x' } });
      // The pool ends without a timeout once the pipelines are done (as
      // closeDb waits for them): no reserve was left unsettled.
      await as.actorPipelinesDone();
      await pool.end();
    } finally {
      // Ends in time: no reserve was left unsettled.
      await pool.end({ timeout: 5 });
    }
  });

  it("the role's CONNECTION LIMIT holds every process's narrow pool at full use: all connect, one more is refused", async () => {
    // The narrow role's own limit is the one migrate sets.
    const [lim] = await su<{ n: number }[]>`
      select rolconnlimit as n from pg_roles where rolname = ${NARROW}`;
    expect(lim!.n).toBe(rr.NARROW_CONNECTION_LIMIT);
    // Measured on a role of its own with the same limit (the narrow role's
    // connections are shared with the test files running now): as many
    // pools as the limit is sized for (every box process, the stdio MCP
    // servers and the operator runs), each at NARROW_POOL_MAX, all busy at
    // once, each made by the narrow pool's own factory.
    const role = `narrow_ceiling_${randomUUID().slice(0, 8)}`;
    const pw = 'ceilingcellpw';
    await su.unsafe(
      `create role "${role}" login password '${pw}' connection limit ${rr.NARROW_CONNECTION_LIMIT}`,
    );
    await su.unsafe(`grant connect on database "${dbName}" to "${role}"`);
    const url = new globalThis.URL(scratch.url);
    url.username = role;
    url.password = pw;
    const n = rr.NARROW_CONNECTION_LIMIT / pools.NARROW_POOL_MAX;
    const procs = Array.from({ length: n }, () => pools.newNarrowPool(url.toString(), su));
    try {
      const all = await Promise.allSettled(
        procs.flatMap((p) =>
          Array.from({ length: pools.NARROW_POOL_MAX }, () =>
            p.unsafe('select pg_backend_pid() as p, pg_sleep(0.5)'),
          ),
        ),
      );
      const refused = all.filter((r) => r.status === 'rejected').length;
      const pids = new Set(
        all.flatMap((r) =>
          r.status === 'fulfilled' ? [(r.value[0] as unknown as { p: number }).p] : [],
        ),
      );
      expect({ asked: all.length, refused, backends: pids.size }).toEqual({
        asked: rr.NARROW_CONNECTION_LIMIT,
        refused: 0,
        backends: rr.NARROW_CONNECTION_LIMIT,
      });
      // One more process's connection, while every one is held: 53300.
      const held = await Promise.all(procs.map((p) => p.reserve()));
      const more = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
      try {
        expect((await failure(more.unsafe('select 1'))).code).toBe('53300');
      } finally {
        for (const r of held) r.release();
        await more.end();
      }
    } finally {
      await Promise.all(procs.map((p) => p.end()));
      await su.unsafe(`revoke connect on database "${dbName}" from "${role}"`);
      await su.unsafe(`drop role "${role}"`);
    }
  });

  it('a narrow statement may name no gateway setting (one cell per name)', async () => {
    await reopen(true);
    const names = [
      'mantle.actor',
      'mantle.actor_check',
      'mantle.write_mode',
      'mantle.route',
      'mantle.acting_login',
      'mantle.login_id',
      'mantle.ws',
      'mantle.mod_ws',
      'mantle.scope_ws',
      'mantle.scope_mod_ws',
      'mantle.scope_login',
      'mantle.scope_kind',
      'mantle.create_ws',
      'mantle.private_ws',
      'mantle.create_stamp',
    ];
    for (const name of names) {
      for (const stmt of [
        sql.raw(`select set_config('${name}', '', true)`),
        sql.raw(`set local ${name} = ''`),
      ]) {
        expect(
          await failure(v.asSystem(() => m.db.transaction((t) => t.execute(stmt)), 'admin-area')),
          name,
        ).toBeInstanceOf(ns.NarrowRouteRefusedError);
      }
    }
  });

  it('the acting login: a request exit carries it on the narrow route, and on the full route with the check off', async () => {
    const login = randomUUID();
    const read = () =>
      m.runInRequestSlot(async () => {
        m.setRequestActor(m.loginActor(login, 'rw'));
        m.noteRequestSystem('area');
        const rows = (await m.db.transaction((t) =>
          t.execute(sql`select current_user::text as u,
                               current_setting('mantle.acting_login', true) as l,
                               current_setting('mantle.actor', true) as a`),
        )) as unknown as { u: string; l: string; a: string }[];
        return rows[0]!;
      });
    await reopen(true);
    expect(await read()).toEqual({ u: NARROW, l: login, a: 'system:http:admin-area' });
    const saved = process.env.MANTLE_ACTOR_CHECK;
    delete process.env.MANTLE_ACTOR_CHECK;
    try {
      await reopen(false);
      const off = await read();
      expect(off.l).toBe(login);
      expect(off.u).not.toBe(NARROW);
    } finally {
      if (saved === undefined) delete process.env.MANTLE_ACTOR_CHECK;
      else process.env.MANTLE_ACTOR_CHECK = saved;
      await reopen(true);
    }
  });
});
