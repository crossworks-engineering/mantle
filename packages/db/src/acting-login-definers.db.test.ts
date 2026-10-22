/**
 * The definers that act for a login with no scope (migration 0314, plan
 * v3.2 S7b part b2): mantle_tg_chat_set and mantle_access_key_revoke take
 * only the acting login the gateway sends, and only from a system session
 * (session_user the runtime role, the narrow role or a superuser). The
 * write role clearing its own scope and setting mantle.acting_login itself
 * is refused (the b1 audit's E4). In a scope the scope's own login rules,
 * as before. The other definers that take a login with no scope (0314's
 * header) each get a cell: none writes for the login it is given.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase, ensureTestAnchor } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('0314: with no scope, only the acting login from a system session', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let rr: typeof import('./runtime-role');
  let v: typeof import('./viewer');
  let m: typeof import('./index');
  let su: ReturnType<typeof postgres>;
  /** Logged in as the narrow role. */
  let nl: ReturnType<typeof postgres>;
  /** Logged in as the write role (the scoped pool's login). */
  let wr: ReturnType<typeof postgres>;
  /** Logged in as the user role. */
  let ur: ReturnType<typeof postgres>;
  let brain = '';
  const KEY = () => process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    brain = await ensureTestAnchor(su);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    rr = await import('./runtime-role');
    v = await import('./viewer');
    m = await import('./index');
    const opts = { max: 1, prepare: false, onnotice: () => {} } as const;
    nl = postgres(
      rr.runtimeDatabaseUrl(scratch.url, rr.narrowRolePassword(KEY()), rr.NARROW_ROLE),
      opts,
    );
    wr = postgres(
      v.viewerDatabaseUrl(scratch.url, 'write', v.viewerRolePassword(KEY(), 'write')),
      opts,
    );
    ur = postgres(
      v.viewerDatabaseUrl(scratch.url, 'user', v.viewerRolePassword(KEY(), 'user')),
      opts,
    );
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    for (const c of [nl, wr, ur, su]) await c?.end();
    await scratch?.drop();
  });

  /** `fn` sent on `on` in a transaction that rolls back, after `pre`
   *  (the settings a caller sends): 'ok' or 'code: message'. */
  const call = async (on: ReturnType<typeof postgres>, fn: string, pre: string[] = []) =>
    on
      .begin(async (t) => {
        for (const p of pre) await t.unsafe(p);
        await t.unsafe(fn);
        throw Object.assign(new Error('rollback'), { ok: true });
      })
      .then(
        () => 'ok',
        (err: { ok?: boolean; code?: string; message?: string }) =>
          err.ok ? 'ok' : `${err.code}: ${err.message}`,
      );
  const acting = (login: string) => `select set_config('mantle.acting_login', '${login}', true)`;
  const tg = (login: string) =>
    `select * from public.mantle_tg_chat_set('${brain}'::uuid, '${login}'::uuid,
       '${randomUUID()}'::uuid, 'unpair', null)`;
  const key = (login: string) =>
    `select * from public.mantle_access_key_revoke('${randomUUID()}'::uuid, '${login}'::uuid)`;

  it('a system session with no scope: none or another acting login refused, its own runs', async () => {
    const login = randomUUID();
    const other = randomUUID();
    const sessions = [
      ['the narrow login', nl, 'mantle_system_narrow'],
      ['the superuser (the system pool, runtime role off)', su, null],
    ] as const;
    for (const [who, on, name] of sessions) {
      const [me] = await on.unsafe<{ s: string }[]>('select session_user::text as s');
      if (name) expect(me!.s).toBe(name);
      // The narrow role may run the Telegram definer only (its EXECUTE);
      // the key revoke is the write role's and the system pool's.
      // Since 0321 the narrow role runs neither (the full-route spot
      // acting-login): its call is refused before the rule.
      if (on === nl) {
        expect(await call(on, tg(login), [acting(login)]), `${who} tg, its own`).toMatch(
          /^42501: permission denied for function/,
        );
        continue;
      }
      const fns =
        on === nl
          ? [['tg', tg]]
          : [
              ['tg', tg],
              ['key', key],
            ];
      for (const [n, f] of fns as [string, (l: string) => string][]) {
        expect(await call(on, f(login)), `${who} ${n}, none`).toMatch(
          /^42501: .*(only the acting login|no acting login)/,
        );
        expect(await call(on, f(login), [acting(other)]), `${who} ${n}, another`).toMatch(
          /^42501: .*(only the acting login|no acting login)/,
        );
        // Its own: the call runs (no chat or key by that id: no row).
        expect(await call(on, f(login), [acting(login)]), `${who} ${n}, its own`).toBe('ok');
      }
    }
  });

  it("the app's system pool (the runtime role when MANTLE_DB_RUNTIME_ROLE is on): its own acting login runs", async () => {
    const login = randomUUID();
    const res = await m.systemDb.transaction(async (tx) => {
      const [me] = (await tx.execute(
        sql`select session_user::text as s, (select rolsuper from pg_roles where rolname = session_user) as su`,
      )) as unknown as { s: string; su: boolean }[];
      // The runtime role suite logs the system pool in as mantle_runtime.
      expect(me!.su || me!.s === 'mantle_runtime', JSON.stringify(me)).toBe(true);
      await tx.execute(sql`select set_config('mantle.acting_login', ${login}, true)`);
      return tx.execute(sql.raw(tg(login)));
    });
    expect([...(res as unknown as unknown[])]).toEqual([]);
  });

  it('the write role clearing its scope and setting the acting login itself is refused (E4)', async () => {
    const login = randomUUID();
    const [me] = await wr.unsafe<{ s: string }[]>('select session_user::text as s');
    expect(me!.s).toBe('mantle_write_user');
    // No scope: no workspace scope (mantle_scope_active), no scope login
    // (mantle_scope_login_id); then the acting login it names itself.
    const clear = [
      `select set_config('mantle.ws', '', true), set_config('mantle.scope_login', '', true),
              set_config('mantle.login_id', '', true)`,
      acting(login),
    ];
    for (const [n, f] of [
      ['mantle_tg_chat_set', tg],
      ['mantle_access_key_revoke', key],
    ] as const) {
      expect(await call(wr, f(login), clear), n).toMatch(/^42501: .*not a system session/);
      expect(await call(wr, f(login)), `${n}, no setting`).toMatch(
        /^42501: .*not a system session/,
      );
    }
    // The user role: no EXECUTE, or the same refusal.
    for (const f of [tg, key]) expect(await call(ur, f(login), clear)).toMatch(/^42501: /);
  });

  it("in a scope the scope's own login rules, as before (the acting login is not read)", async () => {
    const login = randomUUID();
    const other = randomUUID();
    const pre = [`select set_config('mantle.scope_login', '${login}', true)`, acting(other)];
    expect(await call(su, tg(login), pre)).toBe('ok');
    expect(await call(su, tg(other), pre)).toMatch(/^42501: .*only the scope's own login/);
  });

  it("the other definers that take a login with no scope (0314's header): none writes for the login it is given", async () => {
    // Each called with no scope as the superuser (every right), a login
    // that is no login of this brain, the brain as its owner argument:
    // refused, or it runs and changes no row (pg_stat_xact_* read before
    // and after the call). The narrow role may run none of the
    // readers.
    const readers = [
      'mantle_tg_my_chats',
      'mantle_tg_moderated_chats',
      'mantle_read_cursors',
      'mantle_login_connector_rows',
      'mantle_turn_heartbeats',
      'mantle_ws_seen',
      'mantle_access_keys_seen',
      'mantle_snapshot_bytes',
    ];
    const facts = [
      'mantle_area_rule',
      'mantle_login_area',
      'mantle_login_areas',
      'mantle_login_is_admin',
      'mantle_login_is_admin_user',
      'mantle_ws_private_for',
      'mantle_personal_space',
      'mantle_tg_login_moderates',
      'mantle_bridge_login',
    ];
    /** Refused with no acting login: each writes only for the scope's own. */
    const refused = ['mantle_ws_private_workspace', 'mantle_ws_remove_user'];
    const login = randomUUID();
    const WRITES = `select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::int as n
                      from pg_stat_xact_all_tables where schemaname in ('public', 'auth')`;
    const sigs = await su<
      { name: string; args: string; names: string[] | null; narrow: boolean }[]
    >`
      select p.proname::text as name,
             pg_get_function_identity_arguments(p.oid) as args,
             p.proargnames::text[] as names,
             has_function_privilege('mantle_system_narrow', p.oid, 'EXECUTE') as narrow
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = any(${[...readers, ...facts, ...refused]})`;
    const seen = new Set(sigs.map((s) => s.name));
    expect([...readers, ...facts, ...refused].filter((f) => !seen.has(f))).toEqual([]);
    const answers: Record<string, string> = {};
    for (const s of sigs) {
      const types = s.args ? s.args.split(',').map((a) => a.trim().split(/\s+/).pop()!) : [];
      const args = types.map((t, i) => {
        const n = s.names?.[i] ?? '';
        if (t === 'uuid') return /^(owner|brain)/.test(n) ? `'${brain}'::uuid` : `'${login}'::uuid`;
        if (t === 'text') return `'documents'::text`;
        if (t === 'boolean') return 'false';
        if (/^(integer|bigint|smallint)$/.test(t)) return `0::${t}`;
        return `null::${t}`;
      });
      const label = `${s.name}(${s.args})`;
      answers[label] = await su
        .begin(async (t) => {
          // The counts before and after, in the call's own transaction: a
          // backend's counts not yet flushed carry earlier transactions'.
          const before = await t.unsafe<{ n: number }[]>(WRITES);
          await t.unsafe(`select * from public.${s.name}(${args.join(', ')})`);
          const after = await t.unsafe<{ n: number }[]>(WRITES);
          throw Object.assign(new Error('rollback'), { writes: after[0]!.n - before[0]!.n });
        })
        .then(
          () => 'ran',
          (err: { writes?: number; code?: string }) =>
            err.writes !== undefined ? `ran, ${err.writes} rows written` : `refused ${err.code}`,
        );
      if (readers.includes(s.name))
        expect(s.narrow, `${label}: the narrow role runs it`).toBe(false);
    }
    if (process.env.MANTLE_ACTING_REPORT)
      process.stdout.write(`${JSON.stringify(answers, null, 1)}\n`);
    for (const [label, a] of Object.entries(answers)) {
      const name = label.slice(0, label.indexOf('('));
      if (refused.includes(name)) expect(a, label).toBe('refused 42501');
      else expect(a, label).toMatch(/^(ran, 0 rows written|refused \w+)$/);
    }
  });
});
