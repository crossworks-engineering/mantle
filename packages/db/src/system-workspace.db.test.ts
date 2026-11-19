/**
 * The System workspace in SQL (owner decisions 2026-11-19; migration
 * 0386_system_workspace, renumbered 0391 at the merge), on a database of its
 * own (so mantle_brain_id() is this file's anchor) that the workspaces
 * switch made live:
 *
 *  - the area rule per persona and area: an Admin user in System holds every
 *    area, an Admin user outside System only `users`, the Admin row's limits
 *    still switch an area off, a disabled login and a member hold none; the
 *    same through mantle_login_areas, a login's own scope
 *    (mantle_scope_has_area) and an assistant answering each login;
 *  - the rules of the definers on System: only a System user adds (403
 *    system_users_only, an Admin user with the users area too), only an
 *    Admin user is added (409 not_admin_user), always ticked; anyone
 *    leaves, only a System user removes another; the anchor stays; the last
 *    System user stays (the definer, and the guard trigger at commit, a
 *    login's delete included); taken out of Admin is out of System; the tick
 *    is never cleared; System is never archived or renamed;
 *  - the operator's recovery as system work (system:system-add on
 *    mantle_ws_add_user only);
 *  - the migration: the switch makes System with every Admin user ticked
 *    (a fresh brain); a database just before it applies it and only it,
 *    seats every Admin user (enabled or not), once; the revert puts the
 *    bodies back byte for byte, drops the two functions, takes System and
 *    the ledger row out, refuses while System holds a grant; a roll forward
 *    applies it again;
 *  - the catalog: the two new definers' rights;
 *  - an Admin user outside System changes none of its row;
 *    "System" is a reserved name, the index its backstop, a workspace
 *    already called System kept with a NOTICE; the fact behind the
 *    one check of an act on a System user's login.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/db/src/system-workspace.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyJournal } from './migrate-runner';
import type { JournalEntry } from './migrate-plan';
import {
  createMigratedScratchDatabase,
  createScratchDatabaseBefore,
  ensureTestAnchor,
  runWorkspacesSwitch,
} from './test-support';
import { OWNER_ROLE } from './runtime-role';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const DIR = join(__dirname, '..', 'migrations');
const TAG = '0386_system_workspace';
const REVERT = join(__dirname, '..', 'rollback', `${TAG}.revert.sql`);
const AREAS = ['settings', 'users', 'assistants', 'connectors', 'keys'] as const;

const journal = (
  JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  }
).entries;
const at = journal.findIndex((e) => e.tag === TAG);

/** The functions the migration redefines, as the catalog names them. */
const REPLACED = [
  'public.mantle_area_rule(uuid,text)',
  'public.mantle_ws_add_user(uuid,uuid,uuid,boolean)',
  'public.mantle_ws_archive(uuid,uuid)',
  'public.mantle_ws_last_admin_mod_trg()',
  'public.mantle_ws_migrate()',
  'public.mantle_ws_remove_user(uuid,uuid,uuid)',
  'public.mantle_ws_set_moderator(uuid,uuid,uuid,boolean,text)',
  'public.mantle_ws_system_work(text)',
  'public.mantle_ws_update_about(uuid,uuid,jsonb)',
];
const ADDED = ['public.mantle_ws_ensure_system()', 'public.mantle_ws_system_id(uuid)'];

/** The revert's statements, split as the runner splits a migration. */
const revertStatements = (): string[] =>
  readFileSync(REVERT, 'utf8')
    .split('--> statement-breakpoint')
    .map((st) => st.trim())
    .filter((st) => st.replace(/^--.*$/gm, '').trim() !== '');

class Rollback extends Error {}
type Out = { ok: true; v: unknown } | { ok: false; state: string; msg: string };

describe('0386 is stamped above every `when` before it (renumber proof)', () => {
  it('is stamped above its predecessor; the revert names its own `when`', () => {
    expect(at).toBeGreaterThan(0);
    expect(journal[at]!.when).toBeGreaterThan(journal[at - 1]!.when);
    expect(readFileSync(REVERT, 'utf8')).toContain(
      `DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = ${journal[at]!.when};`,
    );
  });
});

describe.skipIf(!URL)('the System workspace (rules and areas)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let sql: ReturnType<typeof postgres>;
  let m: typeof import('./index');
  let brain = '';
  let adminWs = '';
  let sysWs = '';
  const tag = `sys${randomUUID().slice(0, 8)}`;
  const W = randomUUID(); // a normal workspace: mem is its Moderator
  const L = {
    sys: randomUUID(), // role admin: Admin and System (the switch)
    sys2: randomUUID(), // role admin: Admin and System
    lim: randomUUID(), // role admin: Admin and System, users and keys off on Admin
    dis: randomUUID(), // role admin: Admin and System, disabled
    adm: randomUUID(), // role admin: Admin only (taken out of System below)
    mem: randomUUID(), // member, Moderator of W
    out: randomUUID(), // member, in no workspace
  };

  const run = async (
    settings: Record<string, string>,
    q: (tx: postgres.TransactionSql) => Promise<unknown>,
  ): Promise<Out> => {
    let out: Out = { ok: false, state: 'none', msg: 'not run' };
    await sql
      .begin(async (tx) => {
        for (const [k, v] of Object.entries(settings)) {
          await tx`select set_config(${k}, ${v}, true)`;
        }
        try {
          out = { ok: true, v: await q(tx) };
        } catch (err) {
          const e = err as { code?: string; message?: string };
          out = { ok: false, state: e.code ?? '', msg: e.message ?? '' };
        }
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
    return out;
  };
  /** The write role's settings for `login` (writeRoleSettingsSql). */
  const asLogin = async (login: string): Promise<Record<string, string>> => {
    const scope = await m.loginScopeFor(login);
    const arr = (ids: readonly string[]) => `{${ids.join(',')}}`;
    return {
      'mantle.ws': arr(scope.ws),
      'mantle.mod_ws': arr(scope.modWs),
      'mantle.login_id': login,
      'mantle.actor': `login:rw:${login}`,
      'mantle.write_mode': 'rw',
    };
  };
  const asActor = (actor: string): Record<string, string> => ({
    'mantle.actor': actor,
    'mantle.write_mode': 'rw',
  });
  const add =
    (ws: string, login: string, tick = false) =>
    (tx: postgres.TransactionSql) =>
      tx`select mantle_ws_add_user(${brain}::uuid, ${ws}::uuid, ${login}::uuid, ${tick})`;
  const remove = (ws: string, login: string) => (tx: postgres.TransactionSql) =>
    tx`select mantle_ws_remove_user(${brain}::uuid, ${ws}::uuid, ${login}::uuid)`;
  const seat = async (tx: postgres.TransactionSql, ws: string, login: string) =>
    (
      await tx<{ moderator: boolean; added_by: string | null }[]>`
        select moderator, added_by::text from workspace_users
         where workspace_id = ${ws} and login_id = ${login}`
    )[0] ?? null;
  /** The event ids of `ws` now, and the rows written after them. */
  const eventIds = async (tx: postgres.TransactionSql, ws: string) =>
    (
      await tx<{ id: string }[]>`select id::text from workspace_events where workspace_id = ${ws}`
    ).map((r) => r.id);
  const events = async (tx: postgres.TransactionSql, ws: string, before: string[]) =>
    tx<{ actor: string | null; action: string; subject: unknown }[]>`
      select actor_id::text as actor, action, subject from workspace_events
       where workspace_id = ${ws} and id::text <> all (${before}::text[]) order by at, id`;
  /** Every pending deferred check now (the guard trigger), in the cell's tx. */
  const checkNow = (tx: postgres.TransactionSql) => tx`set constraints all immediate`;
  const refused = (out: Out, state: string, code: string) => {
    expect(out.ok, JSON.stringify(out)).toBe(false);
    if (out.ok) return;
    expect(out.state, out.msg).toBe(state);
    expect(out.msg).toMatch(new RegExp(`^mantle_ws:${code}\\b`));
  };
  const lastUser = (out: Out) => {
    expect(out.ok, JSON.stringify(out)).toBe(false);
    if (out.ok) return;
    expect(out.state, out.msg).toBe('23514');
    // System's own words (job 2: the routes answer last_system_user).
    expect(out.msg).toMatch(/^mantle_ws:last_system_user\b/);
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    brain = await ensureTestAnchor(sql);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    const email = (k: string) => `${tag}-${k}@example.invalid`;
    for (const [k, id] of Object.entries(L)) {
      const role = ['mem', 'out'].includes(k) ? 'member' : 'admin';
      await sql`insert into auth.users (id, email, password_hash, role, display_name)
                values (${id}, ${email(k)}, 'x', ${role}, ${k})`;
    }
    await sql`insert into spaces (id, kind, login_id) values (${brain}, 'brain', ${brain})
              on conflict (id) do nothing`;
    // A fresh brain's switch makes System with every Admin user (the cell
    // below checks it before the fixture changes anything).
    await runWorkspacesSwitch(scratch.url);
    m = await import('./index');
    adminWs = (
      await sql<
        { id: string }[]
      >`select id::text from workspaces where owner_id = ${brain} and is_admin`
    )[0]!.id;
    sysWs = (
      await sql<{ id: string }[]>`select mantle_ws_system_id(${brain}::uuid)::text as id`
    )[0]!.id;
    await sql`update workspace_users set limits = ${sql.json({ areas: { users: false, keys: 'false' } })}
               where workspace_id = ${adminWs} and login_id = ${L.lim}`;
    await sql`update auth.users set disabled_at = now() where id = ${L.dis}`;
    await sql`insert into workspaces (id, owner_id, name) values (${W}, ${brain}, ${`${tag} W`})`;
    await sql`insert into workspace_users (workspace_id, login_id, moderator) values (${W}, ${L.mem}, true)`;
  }, 300_000);

  afterAll(async () => {
    await m?.closeDb();
    await sql?.end();
    await scratch?.drop();
  });

  it('the switch made System: every Admin user ticked, one user.add event each (by 0391); again it seats nobody', async () => {
    const [w] = await sql<{ name: string; is_admin: boolean; archived: boolean; icon: string }[]>`
      select name, is_admin, archived_at is not null as archived, icon from workspaces where id = ${sysWs}`;
    expect(w).toEqual({ name: 'System', is_admin: false, archived: false, icon: 'lucide:cpu' });
    const users = await sql<{ id: string; moderator: boolean }[]>`
      select login_id::text as id, moderator from workspace_users where workspace_id = ${sysWs} order by 1`;
    const admins = await sql<{ id: string }[]>`
      select login_id::text as id from workspace_users where workspace_id = ${adminWs} order by 1`;
    expect(users.map((u) => u.id)).toEqual(admins.map((a) => a.id));
    expect(users.map((u) => u.id)).toEqual([brain, L.sys, L.sys2, L.lim, L.dis, L.adm].sort());
    expect(users.every((u) => u.moderator)).toBe(true);
    const evs = await sql<{ actor: string | null; login: string; by: string; mod: boolean }[]>`
      select actor_id::text as actor, subject ->> 'login' as login, subject ->> 'by' as by,
             (subject ->> 'moderator')::boolean as mod
        from workspace_events where workspace_id = ${sysWs} and action = 'user.add' order by 2`;
    expect(evs).toEqual(users.map((u) => ({ actor: null, login: u.id, by: '0391', mod: true })));
    expect(
      await run(
        {},
        async (tx) => (await tx<{ n: number }[]>`select mantle_ws_ensure_system() as n`)[0]!.n,
      ),
    ).toEqual({ ok: true, v: 0 });
    // The fixture's Admin-only user: out of System by hand (as the superuser).
    await sql`delete from workspace_users where workspace_id = ${sysWs} and login_id = ${L.adm}`;
  });

  it('mantle_ws_system_id: this brain`s System, never another`s', async () => {
    expect(
      (
        await sql<
          { id: string | null }[]
        >`select mantle_ws_system_id(${randomUUID()}::uuid)::text as id`
      )[0]!.id,
    ).toBeNull();
    expect(sysWs).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('the area rule: System for every area but users, the Admin seat and its limits as before', async () => {
    const want: Record<string, string[]> = {
      anchor: [...AREAS],
      sys: [...AREAS],
      lim: ['settings', 'assistants', 'connectors'],
      dis: [],
      adm: ['users'],
      mem: [],
      out: [],
    };
    const logins: Record<string, string> = { anchor: brain, ...L };
    const got: Record<string, string[]> = {};
    for (const k of Object.keys(want)) {
      const id = logins[k]!;
      const rule: string[] = [];
      for (const area of AREAS) {
        const [r] = await sql<{ a: boolean }[]>`select mantle_area_rule(${id}::uuid, ${area}) as a`;
        if (r!.a) rule.push(area);
      }
      const [areas] = await sql<{ a: string[] }[]>`select mantle_login_areas(${id}::uuid) as a`;
      expect(areas!.a, k).toEqual(rule);
      expect(await m.loginAreas(id), k).toEqual(rule);
      got[k] = rule;
    }
    expect(got).toEqual(want);
  });

  it('a scope asks the same rule: its own login, Admin in the scope; an assistant answering each login too', async () => {
    const scoped = async (login: string) =>
      run(await asLogin(login), async (tx) => {
        const out: string[] = [];
        for (const area of AREAS) {
          const [r] = await tx<{ a: boolean }[]>`select mantle_scope_has_area(${area}) as a`;
          if (r!.a) out.push(area);
        }
        return out;
      });
    expect(await scoped(L.sys)).toEqual({ ok: true, v: [...AREAS] });
    expect(await scoped(L.adm)).toEqual({ ok: true, v: ['users'] });
    expect(await scoped(L.mem)).toEqual({ ok: true, v: [] });
    const has = (loginId: string, ws: string[], area: (typeof AREAS)[number]) =>
      m.withScope({ kind: 'assistant', loginId, ws, modWs: [] }, () => m.scopeHasArea(area));
    expect(await has(L.sys, [adminWs], 'settings')).toBe(true);
    expect(await has(L.sys, [adminWs], 'keys')).toBe(true);
    expect(await has(L.adm, [adminWs], 'settings')).toBe(false);
    expect(await has(L.adm, [adminWs], 'users')).toBe(true);
    expect(await has(L.mem, [adminWs], 'users')).toBe(false);
    // System alone in a scope gives no area: Admin decides the scope.
    expect(await has(L.sys, [sysWs], 'settings')).toBe(false);
  });

  it('add: a System user adds an Admin user, always ticked; the event names the acting login', async () => {
    for (const who of [L.sys, L.lim]) {
      expect(
        await run(await asLogin(who), async (tx) => {
          const before = await eventIds(tx, sysWs);
          await add(sysWs, L.adm, false)(tx);
          return { seat: await seat(tx, sysWs, L.adm), ev: await events(tx, sysWs, before) };
        }),
        who,
      ).toEqual({
        ok: true,
        v: {
          seat: { moderator: true, added_by: who },
          ev: [{ actor: who, action: 'user.add', subject: { login: L.adm, moderator: true } }],
        },
      });
    }
  });

  it('add: only a System user (an Admin user with the users area too is refused), only an Admin user, not twice', async () => {
    refused(await run(await asLogin(L.adm), add(sysWs, L.adm, true)), '42501', 'system_users_only');
    refused(await run(await asLogin(L.adm), add(sysWs, L.out, true)), '42501', 'system_users_only');
    refused(await run(await asLogin(L.mem), add(sysWs, L.mem)), 'P0002', 'not_found');
    refused(await run(await asLogin(L.sys), add(sysWs, L.mem)), '55000', 'not_admin_user');
    refused(await run(await asLogin(L.sys), add(sysWs, L.out)), '55000', 'not_admin_user');
    // A disabled Admin user is no Admin user now.
    refused(
      await run(await asLogin(L.sys), async (tx) => {
        await tx`delete from workspace_users where workspace_id = ${sysWs} and login_id = ${L.dis}`;
        return add(sysWs, L.dis)(tx);
      }),
      '55000',
      'not_admin_user',
    );
    refused(await run(await asLogin(L.sys), add(sysWs, L.sys2)), '55000', 'already_user');
    // Who may add comes first: a refused caller learns nothing of the login.
    refused(
      await run(await asLogin(L.adm), add(sysWs, randomUUID())),
      '42501',
      'system_users_only',
    );
    // Other workspaces are as before: an Admin user adds anyone with the tick.
    expect((await run(await asLogin(L.adm), add(W, L.out, true))).ok).toBe(true);
  });

  it('remove: anyone leaves, a System user removes another, an Admin user outside System does not', async () => {
    expect(
      await run(await asLogin(L.sys2), async (tx) => {
        const before = await eventIds(tx, sysWs);
        await remove(sysWs, L.sys2)(tx);
        return { seat: await seat(tx, sysWs, L.sys2), ev: await events(tx, sysWs, before) };
      }),
    ).toEqual({
      ok: true,
      v: { seat: null, ev: [{ actor: L.sys2, action: 'user.leave', subject: { login: L.sys2 } }] },
    });
    for (const who of [L.sys, L.lim]) {
      expect((await run(await asLogin(who), remove(sysWs, L.sys2))).ok, who).toBe(true);
    }
    refused(await run(await asLogin(L.adm), remove(sysWs, L.sys2)), '42501', 'system_users_only');
    refused(await run(await asLogin(L.mem), remove(sysWs, L.sys2)), 'P0002', 'not_found');
    // The anchor stays, by anyone, itself too.
    refused(await run(await asLogin(L.sys), remove(sysWs, brain)), '42501', 'owner_stays_admin');
    refused(await run(await asLogin(brain), remove(sysWs, brain)), '42501', 'owner_stays_admin');
  });

  it('the last System user stays: the definer refuses, and the guard trigger at commit (a login`s delete too)', async () => {
    const onlySys2 = (tx: postgres.TransactionSql) =>
      tx`delete from workspace_users where workspace_id = ${sysWs} and login_id <> ${L.sys2}`;
    refused(
      await run(await asLogin(L.sys2), async (tx) => {
        await onlySys2(tx);
        return remove(sysWs, L.sys2)(tx);
      }),
      '55000',
      'last_moderator',
    );
    // A login's delete: with other System users it goes; as the last, never.
    expect(
      (
        await run({}, async (tx) => {
          await tx`delete from auth.users where id = ${L.sys2}`;
          return checkNow(tx);
        })
      ).ok,
    ).toBe(true);
    lastUser(
      await run({}, async (tx) => {
        await onlySys2(tx);
        await tx`delete from auth.users where id = ${L.sys2}`;
        return checkNow(tx);
      }),
    );
  });

  // The definer layer only: the SQL lets any Admin user take a System user
  // out of Admin. The route holds L1 above it (owner, 2026-11-19: only a
  // System user may, 403 system_user_target; lib/workspaces.ts
  // systemUserTarget, system-areas.db.test.ts).
  it('the definer: out of Admin is out of System, in the same step (SQL asks no System seat of the remover; the route does); never the last', async () => {
    expect(
      await run(await asLogin(L.adm), async (tx) => {
        const before = await eventIds(tx, sysWs);
        await remove(adminWs, L.sys2)(tx);
        await checkNow(tx);
        const [r] = await tx<{ role: string }[]>`select role from auth.users where id = ${L.sys2}`;
        return {
          admin: await seat(tx, adminWs, L.sys2),
          system: await seat(tx, sysWs, L.sys2),
          role: r!.role,
          ev: await events(tx, sysWs, before),
          areas: (await tx<{ a: string[] }[]>`select mantle_login_areas(${L.sys2}::uuid) as a`)[0]!
            .a,
        };
      }),
    ).toEqual({
      ok: true,
      v: {
        admin: null,
        system: null,
        role: 'member',
        ev: [{ actor: L.adm, action: 'user.remove', subject: { login: L.sys2, via: 'admin' } }],
        areas: [],
      },
    });
    // An Admin-only user leaves no System row behind and writes no System event.
    expect(
      await run(await asLogin(L.sys), async (tx) => {
        const before = await eventIds(tx, sysWs);
        await remove(adminWs, L.adm)(tx);
        return events(tx, sysWs, before);
      }),
    ).toEqual({ ok: true, v: [] });
    lastUser(
      await run(await asLogin(L.adm), async (tx) => {
        await tx`delete from workspace_users where workspace_id = ${sysWs} and login_id <> ${L.sys2}`;
        await remove(adminWs, L.sys2)(tx);
        return checkNow(tx);
      }),
    );
  });

  it('the tick on System is never cleared; System is never archived or renamed (its look and description change)', async () => {
    const setMod = (login: string, tick: boolean) => (tx: postgres.TransactionSql) =>
      tx`select mantle_ws_set_moderator(${brain}::uuid, ${sysWs}::uuid, ${login}::uuid, ${tick}, null)`;
    refused(await run(await asLogin(L.sys), setMod(L.sys2, false)), '55000', 'admin_workspace');
    expect(await run(await asLogin(L.sys), setMod(L.sys2, true))).toEqual({
      ok: true,
      v: expect.anything(),
    });
    const archive = (tx: postgres.TransactionSql) =>
      tx`select mantle_ws_archive(${brain}::uuid, ${sysWs}::uuid)`;
    refused(await run(await asLogin(L.sys), archive), '55000', 'archive_admin');
    refused(await run(await asLogin(L.adm), archive), '55000', 'archive_admin');
    const about = (patch: Record<string, unknown>) => (tx: postgres.TransactionSql) =>
      tx`select mantle_ws_update_about(${brain}::uuid, ${sysWs}::uuid, ${tx.json(patch as never)})`;
    refused(await run(await asLogin(L.sys), about({ name: 'Ops' })), '55000', 'admin_keeps_name');
    expect((await run(await asLogin(L.sys), about({ name: 'System' }))).ok).toBe(true);
    expect((await run(await asLogin(L.sys), about({ description: 'x', icon: null }))).ok).toBe(
      true,
    );
    refused(await run(await asLogin(L.mem), about({ description: 'x' })), 'P0002', 'not_found');
    // An Admin user outside System changes none of it.
    for (const patch of [{ description: 'x' }, { icon: null }, { color: null }]) {
      refused(await run(await asLogin(L.adm), about(patch)), '42501', 'about_forbidden');
    }
  });

  it('"System" is reserved for every other workspace, as "Admin" is', async () => {
    const rename = (name: string) => (tx: postgres.TransactionSql) =>
      tx`select mantle_ws_update_about(${brain}::uuid, ${W}::uuid, ${tx.json({ name } as never)})`;
    for (const name of ['System', ' system ', 'ADMIN']) {
      refused(await run(await asLogin(L.mem), rename(name)), '55000', 'reserved_name');
    }
    expect((await run(await asLogin(L.mem), rename(`${tag} W2`))).ok).toBe(true);
    // The index is the backstop: a live second "System" never lands.
    const [ix] = await sql<{ def: string }[]>`
      select indexdef as def from pg_indexes where indexname = 'workspaces_reserved_name_uq'`;
    expect(ix!.def).toContain(`'system'`);
    const insert = await run({}, async (tx) => {
      await tx`set local session_replication_role = replica`;
      return tx`insert into workspaces (owner_id, name) values (${brain}, ' SYSTEM ')`;
    });
    expect(insert.ok).toBe(false);
    if (!insert.ok) expect(insert.state).toBe('23505');
  });

  it("acting on a System user's login needs a System user, or your own", async () => {
    const no = (acting: string, target: string) => m.systemUserTargetRefused(acting, target);
    expect(await no(L.adm, L.sys)).toBe(true);
    expect(await no(L.adm, brain)).toBe(true);
    expect(await no(L.mem, L.sys2)).toBe(true);
    expect(await no(L.sys, L.sys2)).toBe(false);
    expect(await no(L.sys2, L.sys2)).toBe(false);
    expect(await no(L.adm, L.adm)).toBe(false);
    expect(await no(L.adm, L.mem)).toBe(false);
    expect(await no(L.sys, L.adm)).toBe(false);
    expect(await no('not-a-uuid', L.sys)).toBe(true);
    expect(await no(L.adm, 'not-a-uuid')).toBe(false);
  });

  it('recovery: system:system-add puts a login in Admin and then System, as system work; that actor on nothing else', async () => {
    const op = asActor('system:system-add');
    expect(
      await run(op, async (tx) => {
        await add(adminWs, L.out, true)(tx);
        await add(sysWs, L.out, false)(tx);
        const [r] = await tx<{ role: string }[]>`select role from auth.users where id = ${L.out}`;
        return {
          admin: await seat(tx, adminWs, L.out),
          system: await seat(tx, sysWs, L.out),
          role: r!.role,
          areas: (await tx<{ a: string[] }[]>`select mantle_login_areas(${L.out}::uuid) as a`)[0]!
            .a,
        };
      }),
    ).toEqual({
      ok: true,
      v: {
        admin: { moderator: true, added_by: null },
        system: { moderator: true, added_by: null },
        role: 'admin',
        areas: [...AREAS],
      },
    });
    // The rules still hold for system work: only an Admin user.
    refused(await run(op, add(sysWs, L.mem)), '55000', 'not_admin_user');
    // On another definer, or another actor on this one: refused.
    refused(await run(op, remove(sysWs, L.sys2)), '42501', 'no_acting_login');
    refused(
      await run(
        op,
        (tx) =>
          tx`select mantle_ws_set_moderator(${brain}::uuid, ${W}::uuid, ${L.mem}::uuid, false, null)`,
      ),
      '42501',
      'no_acting_login',
    );
    refused(
      await run(asActor('system:ws-clear-ticks'), add(sysWs, L.adm)),
      '42501',
      'no_acting_login',
    );
    refused(
      await run(asActor('system:system-add-x'), add(sysWs, L.adm)),
      '42501',
      'no_acting_login',
    );
    // Never inside a scope or read-only.
    refused(
      await run({ ...op, 'mantle.ws': `{${adminWs}}` }, add(sysWs, L.adm)),
      '42501',
      'no_acting_login',
    );
    refused(
      await run({ ...op, 'mantle.write_mode': 'ro' }, add(sysWs, L.adm)),
      '42501',
      'read_only',
    );
  });

  it('catalog: mantle_ws_system_id is the viewer`s read; mantle_ws_ensure_system runs for no app role', async () => {
    const rows = await sql<{ fn: string; definer: boolean; pub: boolean; path: string[] }[]>`
      select f.fn, p.prosecdef as definer, has_function_privilege('public', p.oid, 'EXECUTE') as pub,
             coalesce(p.proconfig, '{}') as path
        from unnest(${ADDED}::text[]) f(fn) join pg_proc p on p.oid = to_regprocedure(f.fn)`;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.definer, r.fn).toBe(true);
      expect(r.pub, r.fn).toBe(false);
      expect(r.path, r.fn).toContain('search_path=public, pg_temp');
    }
    const mayRun = async (fn: string) =>
      (
        await sql<{ r: string }[]>`
          select r.rolname::text as r from pg_roles r
           where not r.rolsuper and r.rolname <> ${OWNER_ROLE}
             and has_function_privilege(r.oid, to_regprocedure(${fn}), 'EXECUTE') order by 1`
      ).map((x) => x.r);
    expect(await mayRun('public.mantle_ws_ensure_system()')).toEqual([]);
    const [v] = await sql<{ ok: boolean }[]>`
      select has_function_privilege('mantle_view_user', to_regprocedure('public.mantle_ws_system_id(uuid)'), 'EXECUTE') as ok`;
    expect(v!.ok).toBe(true);
  });
});

describe.skipIf(!URL)('a database just before 0386 runs 0386 and only it; the revert', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>> | undefined;
  let sql: ReturnType<typeof postgres>;
  const all = readMigrationFiles({ migrationsFolder: DIR });
  const tag = `sysm${randomUUID().slice(0, 8)}`;
  const L = { a1: randomUUID(), a2: randomUUID(), mem: randomUUID() };
  let brain = '';
  type Def = { fn: string; def: string; acl: string | null };
  const defs = async (): Promise<Def[]> => [
    ...(await sql<Def[]>`
      select f.fn, pg_get_functiondef(p.oid) as def, p.proacl::text as acl
        from unnest(${REPLACED}::text[]) f(fn) join pg_proc p on p.oid = to_regprocedure(f.fn)
       order by 1`),
    // The reserved name index: Admin only before, Admin and System after.
    ...(await sql<Def[]>`
      select indexname::text as fn, indexdef as def, null as acl from pg_indexes
       where schemaname = 'public' and indexname = 'workspaces_reserved_name_uq'`),
  ];
  const added = async () =>
    (
      await sql<
        { fn: string | null }[]
      >`select to_regprocedure(f)::text as fn from unnest(${ADDED}::text[]) f`
    ).filter((r) => r.fn).length;
  const system = async () =>
    sql<{ id: string; moderator: boolean }[]>`
      select u.login_id::text as id, u.moderator from workspaces w
        join workspace_users u on u.workspace_id = w.id
       where w.bridge_key = 'system' order by 1`;
  const ledger = async () =>
    (
      await sql<{ n: number }[]>`
        select count(*)::int as n from "drizzle"."__drizzle_migrations"
         where created_at = ${journal[at]!.when}`
    )[0]!.n;
  const apply = async () => {
    const out = { lines: [] as string[], warnings: [] as string[] };
    const n = await applyJournal(sql, all.slice(0, at + 1), journal.slice(0, at + 1), {
      log: (l) => out.lines.push(l),
      warn: (l) => out.warnings.push(l),
    });
    expect(out.warnings).toEqual([]);
    return n;
  };
  let atBefore: Def[] = [];
  const notices: string[] = [];

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, TAG);
    sql = postgres(scratch.url, {
      max: 1,
      prepare: false,
      onnotice: (n) => notices.push(String(n.message)),
    });
    await sql`create schema if not exists "drizzle"`;
    await sql`create table if not exists "drizzle"."__drizzle_migrations" (
                id serial primary key, hash text not null, created_at bigint)`;
    for (const mg of all.slice(0, at)) {
      await sql`insert into "drizzle"."__drizzle_migrations" (hash, created_at)
                values (${mg.hash}, ${mg.folderMillis})`;
    }
    // A switched brain with two more Admin users (one disabled) and a member.
    brain = await ensureTestAnchor(sql);
    const email = (k: string) => `${tag}-${k}@example.invalid`;
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${L.a1}, ${email('a1')}, 'x', 'admin'), (${L.a2}, ${email('a2')}, 'x', 'admin'),
      (${L.mem}, ${email('mem')}, 'x', 'member')`;
    await sql`update auth.users set disabled_at = now() where id = ${L.a2}`;
    await sql`insert into spaces (id, kind, login_id) values (${brain}, 'brain', ${brain})
              on conflict (id) do nothing`;
    await sql.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true),
                      set_config('mantle.write_mode', 'rw', true)`;
      await tx`select * from mantle_ws_migrate()`;
    });
    atBefore = await defs();
    expect(atBefore).toHaveLength(REPLACED.length + 1);
  }, 300_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('the runner applies 0386 and only it: System with every Admin user (a disabled one too), ticked; again nothing', async () => {
    expect(await added()).toBe(0);
    expect(await system()).toEqual([]);
    expect(await apply()).toBe(1);
    expect(await added()).toBe(2);
    expect(await ledger()).toBe(1);
    const want = [brain, L.a1, L.a2].sort().map((id) => ({ id, moderator: true }));
    expect(await system()).toEqual(want);
    expect(await apply()).toBe(0);
    expect((await sql<{ n: number }[]>`select mantle_ws_ensure_system() as n`)[0]!.n).toBe(0);
    expect(await system()).toEqual(want);
  }, 120_000);

  it('rollback: refused while System holds a grant; else the bodies back byte for byte, System and the ledger row gone; a roll forward applies it again', async () => {
    const at0386 = await defs();
    expect(at0386).not.toEqual(atBefore);
    // A grant to System: the revert refuses, nothing changes.
    let refusal: { code?: string; message?: string } = {};
    await sql
      .begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        const [n] = await tx<{ id: string }[]>`
          insert into nodes (owner_id, type, title, path)
          values (${brain}, 'note', 'held', ${`${tag}held`}::ltree) returning id::text`;
        await tx`insert into item_grants (node_id, workspace_id)
                 select ${n!.id}::uuid, id from workspaces where bridge_key = 'system'`;
        await tx`set local session_replication_role = origin`;
        try {
          for (const st of revertStatements()) await tx.unsafe(st);
        } catch (err) {
          refusal = err as { code?: string; message?: string };
        }
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
    expect(refusal.code).toBe('55000');
    expect(refusal.message).toMatch(/System holds 1 grant/);
    expect(await defs()).toEqual(at0386);
    // No grant: it reverts.
    await sql.begin(async (tx) => {
      for (const st of revertStatements()) await tx.unsafe(st);
    });
    expect(await defs()).toEqual(atBefore);
    expect(await added()).toBe(0);
    expect(await system()).toEqual([]);
    expect(await ledger()).toBe(0);
    // Every Admin user holds every area again (the earlier rule).
    const [r] = await sql<{ a: string[] }[]>`select mantle_login_areas(${L.a1}::uuid) as a`;
    expect(r!.a).toEqual([...AREAS]);
    expect(await apply()).toBe(1);
    expect(await defs()).toEqual(at0386);
    expect((await system()).map((u) => u.id)).toEqual([brain, L.a1, L.a2].sort());
  }, 120_000);

  it('a workspace already called System: kept as it is, a NOTICE, the name index stays Admin only', async () => {
    await sql.begin(async (tx) => {
      for (const st of revertStatements()) await tx.unsafe(st);
    });
    const [mine] = await sql<{ id: string }[]>`
      insert into workspaces (owner_id, name) values (${brain}, 'System') returning id::text`;
    notices.length = 0;
    expect(await apply()).toBe(1);
    expect(notices.some((n) => /1 other workspace\(s\) already called System/.test(n))).toBe(true);
    const [w] = await sql<{ name: string; key: string | null }[]>`
      select name, bridge_key as key from workspaces where id = ${mine!.id}`;
    expect(w).toEqual({ name: 'System', key: null });
    expect((await system()).map((u) => u.id)).toEqual([brain, L.a1, L.a2].sort());
    const [ix] = await sql<{ def: string }[]>`
      select indexdef as def from pg_indexes where indexname = 'workspaces_reserved_name_uq'`;
    expect(ix!.def).not.toContain(`'system'`);
    expect(ix!.def).toContain(`'admin'`);
  }, 120_000);
});
