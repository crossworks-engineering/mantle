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
 *  - The acting login (S10 r3 LOW-1, 0314): a request exit's actor carries
 *    it, on the narrow route and on the full route in every check mode;
 *    mantle_tg_chat_set and mantle_access_key_revoke with no scope take
 *    only it.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase, ensureTestAnchor } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const NARROW = 'mantle_system_narrow';

describe.skipIf(!URL)('the narrow route logs in as the narrow role (plan v3.2 S7b)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let m: typeof import('./index');
  let v: typeof import('./viewer');
  let rr: typeof import('./runtime-role');
  let ns: typeof import('./gateway/narrow-sendable');
  let su: ReturnType<typeof postgres>;
  /** A session logged in as the narrow role, one connection. */
  let nl: ReturnType<typeof postgres>;
  let brain = '';
  let dbName = '';

  const KEY = () => process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';

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
  const narrowBackends = async () =>
    (
      await su<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where usename = ${NARROW} and datname = ${dbName}`
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
    m = await import('./index');
    v = await import('./viewer');
    ns = await import('./gateway/narrow-sendable');
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
    // The session SET is reset behind the statement: the next statement on
    // the pool (no actor bound) sees none.
    const tx = (await v.asSystem(
      () =>
        m.db.transaction((t) =>
          t.execute(sql`select current_user::text as u, session_user::text as s`),
        ),
      'admin-area',
    )) as unknown as { u: string; s: string }[];
    expect(tx[0]).toEqual({ u: NARROW, s: NARROW });
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

  it('mantle_tg_chat_set and mantle_access_key_revoke with no scope take only the acting login (0314)', async () => {
    const login = randomUUID();
    const other = randomUUID();
    /** Sent as the narrow login with no scope, `acting` as the gateway
     *  would send it; rolled back. */
    const call = async (fn: string, acting: string | null, on = nl) =>
      on
        .begin(async (t) => {
          if (acting) await t`select set_config('mantle.acting_login', ${acting}, true)`;
          await t.unsafe(fn);
          throw Object.assign(new Error('rollback'), { ok: true });
        })
        .then(
          () => 'ok',
          (err: { ok?: boolean; code?: string; message?: string }) =>
            err.ok ? 'ok' : `${err.code}: ${err.message}`,
        );
    const tg = `select * from public.mantle_tg_chat_set('${brain}'::uuid, '${login}'::uuid,
                  '${randomUUID()}'::uuid, 'unpair', null)`;
    const key = `select * from public.mantle_access_key_revoke('${randomUUID()}'::uuid, '${login}'::uuid)`;
    // The Telegram write as the narrow login (its EXECUTE); the key revoke
    // as the superuser (the narrow role may not run it: the rule is the
    // definer's, whoever calls it with no scope).
    for (const [name, fn, on] of [
      ['mantle_tg_chat_set', tg, nl],
      ['mantle_access_key_revoke', key, su],
    ] as const) {
      expect(await call(fn, null, on), `${name}, none`).toMatch(/^42501: .*only the acting login/);
      expect(await call(fn, other, on), `${name}, another`).toMatch(
        /^42501: .*only the acting login/,
      );
      // The acting login itself: the call runs (no chat or key by that id:
      // no row, no error).
      expect(await call(fn, login, on), `${name}, its own`).toBe('ok');
    }
    // In a scope the scope's own login rules, as before (0313, 0293): the
    // acting login is not read there.
    const scoped = await su
      .begin(async (t) => {
        await t`select set_config('mantle.scope_login', ${login}, true),
                       set_config('mantle.acting_login', ${other}, true)`;
        await t.unsafe(tg);
        throw Object.assign(new Error('rollback'), { ok: true });
      })
      .then(
        () => 'ok',
        (err: { ok?: boolean; code?: string }) => (err.ok ? 'ok' : err.code),
      );
    expect(scoped).toBe('ok');
  });
});
