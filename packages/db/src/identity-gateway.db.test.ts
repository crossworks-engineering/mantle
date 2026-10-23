/**
 * The identity gateway (migration 0322, plan v3.2 S7b part b2 round 13,
 * the CEO's class rule: "a database rule that blocks this for the
 * restricted login everywhere, not one fix per function").
 *
 * 1. The catalog check reads no leak, and finds each planted form (a
 *    function, a key built at run time, pg_settings, a policy, a trigger
 *    condition on a table the narrow role writes).
 * 2. The readers answer no identity on the REAL narrow login (its derived
 *    password; session_user mantle_system_narrow) whatever the session set,
 *    and what was set anywhere else.
 * 3. The live sweep: every function the narrow role may EXECUTE, generated
 *    from the catalog, called as the narrow login with every identity
 *    setting forged to the owner and the Admin workspace (scoped, and with
 *    no scope), owner-shaped arguments: each refuses or changes no row
 *    (no transaction id). The four acting-login definers refuse by their own
 *    rule even with EXECUTE granted back.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityLeaks } from './identity-gateway';
import { createMigratedScratchDatabase, ensureTestAnchor } from './test-support';
import {
  FORGED_ACTOR,
  fillIdentity,
  IDENTITY_FORGE_SQL,
  IDENTITY_FORGE_UNSCOPED_SQL,
  IDENTITY_SWEEP_CALLS_SQL,
} from './test-support/identity-sweep';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const ACTING_DEFINERS = [
  'mantle_ws_set_moderator(uuid,uuid,uuid,boolean,text)',
  'mantle_tg_chat_set(uuid,uuid,uuid,text,uuid)',
  'mantle_structure_item(text,text,uuid,uuid,uuid[],jsonb)',
  'mantle_agent_delete(uuid,uuid,uuid,boolean)',
];

describe.skipIf(!URL)('round 13: the identity gateway (0322)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let su: ReturnType<typeof postgres>;
  let nl: ReturnType<typeof postgres>;
  const ids = { owner: '', ws: '', agent: 'c1300000-0000-4000-8000-000000000001' };
  const MEMBER = 'a1300000-0000-4000-8000-000000000002';

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    ids.owner = await ensureTestAnchor(su);
    const [admin] = await su`select id::text as id from workspaces where is_admin limit 1`;
    ids.ws =
      admin?.id ??
      (
        await su`insert into workspaces (owner_id, name, is_admin, bridge_key)
                  values (${ids.owner}, 'Admin', true, 'admin') returning id::text as id`
      )[0]!.id;
    await su`insert into workspace_users (workspace_id, login_id, moderator)
              values (${ids.ws}, ${ids.owner}, true) on conflict do nothing`;
    await su`insert into auth.users (id, email, password_hash, role)
              values (${MEMBER}, 'member13@example.invalid', 'x', 'member')`;
    await su`insert into workspace_users (workspace_id, login_id, moderator)
              values (${ids.ws}, ${MEMBER}, false) on conflict do nothing`;
    await su`insert into agents (id, owner_id, slug, name, provider, model, enabled, system_prompt)
              values (${ids.agent}, ${ids.owner}, 'gate-agent', 'Gate', 'openrouter', 'x/y', false, 'p')`;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    const rr = await import('./runtime-role');
    nl = postgres(
      rr.runtimeDatabaseUrl(
        scratch.url,
        rr.narrowRolePassword(process.env.MANTLE_MASTER_KEY),
        rr.NARROW_ROLE,
      ),
      { max: 1, prepare: false, onnotice: () => {} },
    );
  }, 180_000);

  afterAll(async () => {
    for (const c of [nl, su]) await c?.end();
    await scratch?.drop();
  });

  /** One call as the narrow login after `forge`, rolled back: 'nochange',
   *  'wrote', or the error's code. */
  const call = (forge: string, stmt: string) =>
    nl
      .begin(async (t) => {
        await t.unsafe(`set local statement_timeout = '5s'`);
        await t.unsafe(fillIdentity(forge, ids));
        await t.unsafe(stmt);
        const [r] = await t.unsafe(`select pg_current_xact_id_if_assigned() is not null as wrote`);
        throw Object.assign(new Error('rollback'), { got: r?.wrote ? 'wrote' : 'nochange' });
      })
      .then(
        () => 'error',
        (e: { got?: string; code?: string }) => e.got ?? e.code ?? 'error',
      );

  it('the catalog check reads no leak', async () => {
    expect(await identityLeaks(su)).toEqual([]);
  });

  it('the catalog check finds every planted form', async () => {
    const found = await su
      .begin(async (t) => {
        await t.unsafe(`create function public.r13_leak_a() returns uuid language sql stable as
          $$ select nullif(current_setting('mantle.login_id', true), '')::uuid $$`);
        await t.unsafe(`create function public.r13_leak_b(k text) returns text language sql stable as
          $$ select current_setting('mantle.' || k, true) $$`);
        await t.unsafe(`create function public.r13_leak_c() returns text language sql stable as
          $$ select setting from pg_settings where name = 'mantle.ws' $$`);
        await t.unsafe(`create function public.r13_leak_d() returns text language sql stable as
          $$ select current_setting('mantle.brand_new_key', true) $$`);
        await t.unsafe(`create policy r13_leak_p on public.agents for select
          using (current_setting('mantle.acting_login', true) <> '')`);
        await t.unsafe(`create trigger r13_leak_t before update on public.agents for each row
          when (current_setting('mantle.actor', true) = 'system:x') execute function touch_updated_at()`);
        // The forms the re-audit's DB LOW-2 named: a SQL-standard body (no
        // prosrc), a quoted and a schema-qualified current_setting,
        // pg_show_all_settings, a reader's name in another schema, a
        // domain's check.
        await t.unsafe(`create function public.r14_leak_e() returns text language sql stable
          begin atomic select current_setting('mantle.login_id', true); end`);
        await t.unsafe(`create function public.r14_leak_f() returns text language sql stable as
          $$ select pg_catalog."current_setting"('mantle.ws', true) $$`);
        await t.unsafe(`create function public.r14_leak_g() returns text language sql stable as
          $$ select setting from pg_show_all_settings() where name = 'mantle.scope_login' $$`);
        await t.unsafe(`create schema r14_other`);
        await t.unsafe(`create function r14_other.mantle_login_id() returns text language sql stable as
          $$ select current_setting('mantle.login_id', true) $$`);
        await t.unsafe(`create domain public.r14_leak_dom as text
          check (value <> current_setting('mantle.acting_login', true))`);
        // What a function sets (the round 16 re-audit's DB LOW-3): a body's
        // set_config and SET of an identity key, a key built at run time,
        // and a function's own SET clause naming one (or blanking one
        // outside the structure definer).
        await t.unsafe(`create function public.r16_set_a() returns text language sql volatile as
          $$ select set_config('mantle.login_id', '00000000-0000-4000-8000-000000000001', true) $$`);
        await t.unsafe(`create function public.r16_set_b(k text) returns text language sql volatile as
          $$ select set_config('mantle.' || k, 'x', true) $$`);
        await t.unsafe(`create function public.r16_set_c() returns void language plpgsql volatile as
          $$ begin set local mantle.acting_login = '00000000-0000-4000-8000-000000000001'; end $$`);
        await t.unsafe(`create function public.r16_set_d() returns text language sql volatile
          set mantle.ws = '{00000000-0000-4000-8000-000000000001}' as $$ select '' $$`);
        await t.unsafe(`create function public.r16_set_e() returns text language sql volatile
          set mantle.create_ws = '' as $$ select '' $$`);
        await t.unsafe(`create function public.r16_set_f() returns text language sql volatile as
          $$ select set_config('mantle.actor', 'system:x', true) $$`);
        // The SET forms the next re-audit named: quoted and spaced names,
        // a RESET, a dynamic SET, the role by SET, set_config and a SET
        // clause, and a role's default; an UPDATE of a column named role
        // is not one.
        await t.unsafe(`create function public.leak_set_quoted() returns void language plpgsql volatile as
          $$ begin set local "mantle"."acting_login" = '00000000-0000-4000-8000-000000000001'; end $$`);
        await t.unsafe(`create function public.leak_set_spaced() returns void language plpgsql volatile as
          $$ begin set mantle . login_id = '00000000-0000-4000-8000-000000000001'; end $$`);
        await t.unsafe(`create function public.leak_reset() returns void language plpgsql volatile as
          $$ begin reset mantle.scope_login; end $$`);
        await t.unsafe(`create function public.leak_set_dynamic(k text) returns void language plpgsql volatile as
          $$ begin execute format('set local %I = %L', k, 'x'); end $$`);
        await t.unsafe(`create function public.leak_set_concat(k text) returns void language plpgsql volatile as
          $$ begin execute 'set local ' || k || ' = ''x'''; end $$`);
        await t.unsafe(`create function public.leak_set_role() returns void language plpgsql volatile as
          $$ begin set local role mantle_runtime; end $$`);
        await t.unsafe(`create function public.leak_set_auth() returns text language sql volatile as
          $$ select set_config('session_authorization', 'postgres', true) $$`);
        await t.unsafe(`create function public.leak_clause_role() returns text language sql volatile
          set role = 'mantle_runtime' as $$ select '' $$`);
        await t.unsafe(
          `alter role current_user set mantle.acting_login = '00000000-0000-4000-8000-000000000001'`,
        );
        await t.unsafe(`create function public.leak_update_ok(u uuid) returns void language sql volatile as
          $$ update auth.users set role = 'member' where id = u $$`);
        // A setting the check allows: no row for it.
        await t.unsafe(`create function public.r16_set_ok() returns text language sql volatile as
          $$ select set_config('mantle.keep_updated_at', 'on', true) $$`);
        const rows = await identityLeaks(t as unknown as postgres.Sql);
        throw Object.assign(new Error('rollback'), { rows });
      })
      .catch((e: { rows?: { object: string }[] }) => e.rows ?? []);
    const objects = found.map((r) => r.object).join(' | ');
    for (const want of [
      'r14_leak_e()',
      'r14_leak_f()',
      'r14_leak_g()',
      'r14_other.mantle_login_id()',
      'r14_leak_dom',
      'r13_leak_a()',
      'r13_leak_b(text)',
      'r13_leak_c()',
      'r13_leak_d()',
      'agents r13_leak_p',
      'agents r13_leak_t',
      'r16_set_a()',
      'r16_set_b(text)',
      'r16_set_c()',
      'r16_set_d()',
      'r16_set_e()',
      'r16_set_f()',
      'leak_set_quoted()',
      'leak_set_spaced()',
      'leak_reset()',
      'leak_set_dynamic(text)',
      'leak_set_concat(text)',
      'leak_set_role()',
      'leak_set_auth()',
      'leak_clause_role()',
      ' in every database',
    ]) {
      expect(objects).toContain(want);
    }
    expect(objects).not.toContain('r16_set_ok()');
    expect(objects).not.toContain('leak_update_ok(');
  });

  it('a migration that leaves a leak fails before its commit and leaves nothing', async () => {
    const { applyJournal } = await import('./migrate-runner');
    // Above every journal stamp (the scratch copy may keep no ledger).
    const when = 9_000_000_000_000;
    const leak = {
      folderMillis: when,
      hash: 'r14-leak',
      sql: [
        `create function public.r14_migrated_leak() returns text language sql stable as
          $$ select current_setting('mantle.login_id', true) $$`,
      ],
    };
    const journal = [{ idx: 99999, version: '7', when, tag: '9999_r14_leak', breakpoints: true }];
    await expect(
      applyJournal(su, [leak], journal, { log: () => {}, warn: () => {} }),
    ).rejects.toThrow(/r14_migrated_leak/);
    const [left] = await su<{ fn: string | null; ledger: number }[]>`
      select to_regprocedure('public.r14_migrated_leak()')::text as fn,
             (select count(*)::int from "drizzle"."__drizzle_migrations" where hash = 'r14-leak') as ledger`;
    await su`delete from "drizzle"."__drizzle_migrations" where hash = 'r14-leak'`;
    expect(left).toEqual({ fn: null, ledger: 0 });
  });

  it('the readers answer no identity on the narrow login, and what was set elsewhere', async () => {
    const q = `select mantle_login_id()::text as login, mantle_scope_login_id()::text as scope_login,
                      mantle_scope_ws()::text as ws, mantle_scope_mod_ws()::text as mod_ws,
                      mantle_scope_active() as active, mantle_setting_uuid('mantle.create_ws')::text as create_ws,
                      mantle_identity_acting_login()::text as acting, mantle_identity_actor() as actor,
                      session_user::text as s`;
    const read = (c: ReturnType<typeof postgres>, extra = '') =>
      c.begin(async (t) => {
        if (extra) await t.unsafe(extra);
        await t.unsafe(fillIdentity(IDENTITY_FORGE_SQL, ids));
        return (await t.unsafe(q))[0];
      });
    expect(await read(nl)).toEqual({
      login: null,
      scope_login: null,
      ws: '{}',
      mod_ws: '{}',
      active: false,
      create_ws: null,
      acting: null,
      actor: 'system:narrow',
      s: 'mantle_system_narrow',
    });
    // The narrow role taken by SET on another login (the fallback route).
    expect((await read(su, 'set local role mantle_system_narrow'))?.login).toBeNull();
    const off = await read(su);
    expect(off).toMatchObject({
      login: ids.owner,
      scope_login: ids.owner,
      ws: `{${ids.ws}}`,
      active: true,
      create_ws: ids.ws,
      acting: ids.owner,
      actor: FORGED_ACTOR,
    });
  });

  it('the control: a write the narrow login may make shows as one', async () => {
    expect(
      await call(IDENTITY_FORGE_SQL, `update agents set name = name where id = '${ids.agent}'`),
    ).toBe('wrote');
  });

  it('every function the narrow role may run, with every identity forged, refuses or changes no row', async () => {
    const calls = (await su.unsafe(IDENTITY_SWEEP_CALLS_SQL)) as unknown as {
      sig: string;
      stmt: string;
    }[];
    expect(calls.length).toBeGreaterThan(100);
    const wrote: string[] = [];
    const tally: Record<string, number> = {};
    for (const forge of [IDENTITY_FORGE_SQL, IDENTITY_FORGE_UNSCOPED_SQL]) {
      for (const c of calls) {
        const got = await call(forge, fillIdentity(c.stmt, ids));
        const k = got === 'nochange' || got === 'wrote' ? got : 'refused';
        tally[k] = (tally[k] ?? 0) + 1;
        if (got === 'wrote') wrote.push(c.sig);
      }
    }
    expect(wrote).toEqual([]);
    expect(tally.nochange ?? 0).toBeGreaterThan(0);
  }, 600_000);

  it('the four acting-login definers are off the narrow list, and refuse by their own rule with EXECUTE granted back', async () => {
    for (const sig of ACTING_DEFINERS) {
      const [r] = await su.unsafe(
        `select has_function_privilege('mantle_system_narrow', 'public.${sig}', 'EXECUTE') as x`,
      );
      expect(r?.x, sig).toBe(false);
    }
    const sigs = ACTING_DEFINERS.map((s) => `public.${s}`).join(', ');
    await su.unsafe(`grant execute on function ${sigs} to mantle_system_narrow`);
    try {
      const forged: [string, string][] = [
        [
          'moderator',
          `select mantle_ws_set_moderator('${ids.owner}', '${ids.ws}', '${MEMBER}', true, null)`,
        ],
        [
          'agent delete',
          `select * from mantle_agent_delete('${ids.owner}', '${ids.owner}', '${ids.agent}', true)`,
        ],
        [
          'chat unpair',
          `select * from mantle_tg_chat_set('${ids.owner}', '${ids.owner}', gen_random_uuid(), 'unpair', null)`,
        ],
        [
          'chat unpair, no login named',
          `select * from mantle_tg_chat_set('${ids.owner}', null, gen_random_uuid(), 'unpair', null)`,
        ],
        [
          'structure delete',
          `select * from mantle_structure_item('secret-item', 'delete', '${ids.owner}', '${ids.owner}', array[gen_random_uuid()], null)`,
        ],
      ];
      const bad: string[] = [];
      for (const forge of [IDENTITY_FORGE_SQL, IDENTITY_FORGE_UNSCOPED_SQL]) {
        for (const [label, stmt] of forged) {
          const got = await call(forge, stmt);
          if (got !== '42501') bad.push(`${label}: ${got}`);
        }
      }
      expect(bad).toEqual([]);
    } finally {
      await su.unsafe(`revoke execute on function ${sigs} from mantle_system_narrow`);
    }
    const [m] = await su`select moderator from workspace_users
                          where workspace_id = ${ids.ws} and login_id = ${MEMBER}`;
    expect(m?.moderator).toBe(false);
    const [a] = await su`select count(*)::int as n from agents where id = ${ids.agent}`;
    expect(a?.n).toBe(1);
  });
});
