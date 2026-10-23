/**
 * The role follows Admin membership (plan v3.2 S8b, migration 0330), round
 * 4's cells, each on a database of its own (so mantle_brain_id() is this
 * file's anchor):
 *
 *  - the role guard (users_role_guard): the runtime, narrow and write roles
 *    cannot change auth.users.role nor insert a login with role admin; an
 *    update that leaves the role as it is, and a member insert, pass; the
 *    membership definers, run by the runtime role, write it; the first
 *    owner row (is_owner, role admin, the table empty) passes, a second
 *    one and any other admin insert do not; 0272's CHECK still holds;
 *  - mantle_bridge_login demotes only: a login whose role is not admin
 *    leaves Admin (the row, a 'bridge.login' event); a role admin login
 *    outside Admin is not added;
 *  - the Admin seat (mantle_admin_seat): mantle_login_is_admin and
 *    mantle_area_rule answer as 0304's own bodies over a grid of logins,
 *    mantle_login_role says admin for any user of Admin, no app role
 *    may run the seat itself, and the seat is inlinable (round 5).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/role-guard.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NARROW_ROLE, RUNTIME_ROLE } from './runtime-role';
import { createMigratedScratchDatabase, ensureAdminUsers, ensureTestAnchor } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const WRITER = 'mantle_write_user';

/** Rolls a cell's transaction back after its checks. */
class Rollback extends Error {}

type Out = { ok: true; v: unknown } | { ok: false; state: string; msg: string };

/** `q` in a transaction rolled back after it, as `role` when given (SET
 *  LOCAL ROLE), with `settings` set transaction-local first: its result,
 *  or its error's SQLSTATE and text. */
async function run(
  sql: postgres.Sql,
  role: string | null,
  q: (tx: postgres.TransactionSql) => Promise<unknown>,
  settings: Record<string, string> = {},
): Promise<Out> {
  let out: Out = { ok: false, state: 'none', msg: 'not run' };
  await sql
    .begin(async (tx) => {
      for (const [k, v] of Object.entries(settings)) {
        await tx`select set_config(${k}, ${v}, true)`;
      }
      if (role) await tx.unsafe(`set local role "${role}"`);
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
}

const roleExists = async (sql: postgres.Sql, role: string) =>
  (await sql<{ on: boolean }[]>`select to_regrole(${role}) is not null as on`)[0]!.on;

describe.skipIf(!URL)('the role guard: only the membership definers write the role (0330)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let sql: ReturnType<typeof postgres>;
  let brain = '';
  let adminWs = '';
  const tag = `rg${randomUUID().slice(0, 8)}`;
  const L = { adm: randomUUID(), mem: randomUUID() };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
  }, 180_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  const insertLogin =
    (role: 'admin' | 'member', owner = false, id = randomUUID()) =>
    (tx: postgres.TransactionSql) =>
      tx`insert into auth.users (id, email, password_hash, is_owner, role)
         values (${id}, ${`${tag}-${id.slice(0, 8)}@example.test`}, 'x', ${owner}, ${role})`;

  it('lets the first owner row in while the table is empty, and no second', async () => {
    // Before any login exists (this cell runs first): the first-run signup.
    expect((await sql`select 1 from auth.users`).length).toBe(0);
    for (const role of [RUNTIME_ROLE, NARROW_ROLE]) {
      if (!(await roleExists(sql, role))) continue;
      const first = await run(sql, role, insertLogin('admin', true));
      expect(first, role).toEqual({ ok: true, v: expect.anything() });
      const second = await run(sql, role, async (tx) => {
        await insertLogin('admin', true)(tx);
        return insertLogin('admin', true)(tx);
      });
      // The second owner meets the single-owner index (0111), as before.
      expect(second.ok ? '' : second.state, role).toBe('23505');
      const skipped = await run(sql, role, async (tx) => {
        await insertLogin('admin', true)(tx);
        return tx`insert into auth.users (id, email, password_hash, is_owner, role)
                  values (${randomUUID()}, ${`${tag}-o2@example.test`}, 'x', true, 'admin')
                  on conflict do nothing returning id`;
      });
      expect(skipped, role).toEqual({ ok: true, v: [] });
      const plainAdmin = await run(sql, role, insertLogin('admin', false));
      expect(plainAdmin.ok ? '' : plainAdmin.msg, role).toMatch(/^mantle_role:membership_only/);
    }
  });

  it('refuses a role change and an admin insert to the runtime, narrow and write roles', async () => {
    brain = await ensureTestAnchor(sql);
    await sql`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${L.adm}, ${`${tag}-adm@example.test`}, 'x', false, 'admin'),
      (${L.mem}, ${`${tag}-mem@example.test`}, 'x', false, 'member')`;
    adminWs = await ensureAdminUsers(sql, [L.adm]);
    for (const role of [RUNTIME_ROLE, NARROW_ROLE, WRITER]) {
      if (!(await roleExists(sql, role))) continue;
      const promote = await run(
        sql,
        role,
        (tx) => tx`update auth.users set role = 'admin' where id = ${L.mem}`,
      );
      expect(promote.ok, role).toBe(false);
      expect(promote.ok ? '' : promote.state, role).toBe('42501');
      const demote = await run(
        sql,
        role,
        (tx) => tx`update auth.users set role = 'member' where id = ${L.adm}`,
      );
      expect(demote.ok ? '' : demote.state, role).toBe('42501');
      const made = await run(sql, role, insertLogin('admin'));
      expect(made.ok ? '' : made.state, role).toBe('42501');
      if (role !== WRITER) {
        // The guard's own refusal (these roles hold UPDATE and INSERT).
        expect(promote.ok ? '' : promote.msg, role).toMatch(/^mantle_role:membership_only/);
        expect(made.ok ? '' : made.msg, role).toMatch(/^mantle_role:membership_only/);
        // The role left as it is, and a member login, pass.
        const same = await run(
          sql,
          role,
          (tx) =>
            tx`update auth.users set role = role, display_name = 'x' where id = ${L.adm} returning role`,
        );
        expect(same, role).toEqual({ ok: true, v: [{ role: 'admin' }] });
        expect((await run(sql, role, insertLogin('member'))).ok, role).toBe(true);
      }
    }
    // The superuser (the migrator here) may: the guard lets it through.
    const su = await run(
      sql,
      null,
      (tx) => tx`update auth.users set role = 'admin' where id = ${L.mem} returning role`,
    );
    expect(su).toEqual({ ok: true, v: [{ role: 'admin' }] });
  });

  it('lets the membership definers, run by the runtime role, write it', async () => {
    if (!(await roleExists(sql, RUNTIME_ROLE))) return;
    const as = {
      'mantle.ws': `{${adminWs}}`,
      'mantle.mod_ws': `{${adminWs}}`,
      'mantle.login_id': L.adm,
      'mantle.actor': `login:rw:${L.adm}`,
      'mantle.write_mode': 'rw',
    };
    const roleOf = async (tx: postgres.TransactionSql, id: string) =>
      (await tx<{ role: string }[]>`select role from auth.users where id = ${id}`)[0]!.role;
    const out = await run(
      sql,
      RUNTIME_ROLE,
      async (tx) => {
        await tx`select mantle_ws_add_user(${brain}::uuid, ${adminWs}::uuid, ${L.mem}::uuid, true)`;
        const added = await roleOf(tx, L.mem);
        await tx`select mantle_ws_remove_user(${brain}::uuid, ${adminWs}::uuid, ${L.mem}::uuid)`;
        return [added, await roleOf(tx, L.mem)];
      },
      as,
    );
    expect(out).toEqual({ ok: true, v: ['admin', 'member'] });
  });

  it('keeps 0272`s CHECK: admin and member only, the anchor an admin', async () => {
    const client = await run(
      sql,
      null,
      (tx) => tx`update auth.users set role = 'client' where id = ${L.mem}`,
    );
    expect(client.ok ? '' : client.state).toBe('23514');
    const anchor = await run(
      sql,
      null,
      (tx) => tx`update auth.users set role = 'member' where id = ${brain}`,
    );
    expect(anchor.ok ? '' : anchor.state).toBe('23514');
  });
});

describe.skipIf(!URL)('mantle_bridge_login demotes only (0330)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let sql: ReturnType<typeof postgres>;
  let adminWs = '';
  const tag = `rb${randomUUID().slice(0, 8)}`;
  const L = {
    adm: randomUUID(), // role admin, in Admin
    out: randomUUID(), // role admin, not in Admin (an older image's promotion)
    demoted: randomUUID(), // role member, in Admin (an older image's demotion)
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    const brain = await ensureTestAnchor(sql);
    // The switch's Admin workspace, by its bridge key, as the bridge finds it.
    await sql`insert into workspaces (owner_id, name, is_admin, bridge_key)
              values (${brain}, 'Admin', true, 'admin')`;
    await sql`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${L.adm}, ${`${tag}-adm@example.test`}, 'x', false, 'admin'),
      (${L.out}, ${`${tag}-out@example.test`}, 'x', false, 'admin'),
      (${L.demoted}, ${`${tag}-dem@example.test`}, 'x', false, 'member')`;
    adminWs = await ensureAdminUsers(sql, [L.adm, L.demoted]);
  }, 180_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  const state = async (login: string) => {
    const [r] = await sql<{ row: boolean; events: number }[]>`
      select exists (select 1 from workspace_users u
                      where u.workspace_id = ${adminWs} and u.login_id = ${login}) as row,
             (select count(*)::int from workspace_events e
               where e.workspace_id = ${adminWs} and e.action = 'bridge.login'
                 and e.subject ->> 'login' = ${login}) as events`;
    return r!;
  };

  it('takes a login whose role is not admin out of Admin, with its event', async () => {
    expect(await state(L.demoted)).toEqual({ row: true, events: 0 });
    await sql`select mantle_bridge_login(${L.demoted}::uuid)`;
    expect(await state(L.demoted)).toEqual({ row: false, events: 1 });
    const [ev] = await sql<{ role: string | null }[]>`
      select e.subject ->> 'role' as role from workspace_events e
       where e.workspace_id = ${adminWs} and e.subject ->> 'login' = ${L.demoted}`;
    expect(ev!.role).toBe('member');
    // Again: nothing left to take, no second event.
    await sql`select mantle_bridge_login(${L.demoted}::uuid)`;
    expect(await state(L.demoted)).toEqual({ row: false, events: 1 });
  });

  it('never adds: a role admin login outside Admin stays outside', async () => {
    await sql`select mantle_bridge_login(${L.out}::uuid)`;
    expect(await state(L.out)).toEqual({ row: false, events: 0 });
    // An Admin user with role admin is left as it is.
    await sql`select mantle_bridge_login(${L.adm}::uuid)`;
    expect(await state(L.adm)).toEqual({ row: true, events: 0 });
  });
});

describe.skipIf(!URL)('the Admin seat answers as 0304`s bodies (0330 gateway)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let sql: ReturnType<typeof postgres>;
  const tag = `rs${randomUUID().slice(0, 8)}`;
  const L = {
    adm: randomUUID(), // in Admin
    dis: randomUUID(), // in Admin, disabled
    noUsers: randomUUID(), // in Admin, the users area off
    mem: randomUUID(), // not in Admin
    none: randomUUID(), // no login
  };
  const AREAS = ['settings', 'users', 'assistants', 'connectors', 'keys', 'nope'];

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    await ensureTestAnchor(sql);
    await sql`insert into auth.users (id, email, password_hash, is_owner, role, disabled_at) values
      (${L.adm}, ${`${tag}-adm@example.test`}, 'x', false, 'admin', null),
      (${L.dis}, ${`${tag}-dis@example.test`}, 'x', false, 'admin', now()),
      (${L.noUsers}, ${`${tag}-nou@example.test`}, 'x', false, 'admin', null),
      (${L.mem}, ${`${tag}-mem@example.test`}, 'x', false, 'member', null)`;
    const ws = await ensureAdminUsers(sql, [L.adm, L.dis, L.noUsers]);
    await sql`update workspace_users set limits = '{"areas": {"users": false}}'::jsonb
               where workspace_id = ${ws} and login_id = ${L.noUsers}`;
  }, 180_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('mantle_login_is_admin, mantle_area_rule and mantle_login_role over the grid', async () => {
    for (const [name, id] of Object.entries(L)) {
      const [r] = await sql<{ now: boolean; was: boolean; shown: string }[]>`
        select mantle_login_is_admin(${id}::uuid) as now,
               exists (
                 select 1 from workspaces w
                   join workspace_users u on u.workspace_id = w.id and u.login_id = ${id}::uuid
                   join auth.users l on l.id = u.login_id and l.disabled_at is null
                  where w.owner_id = mantle_brain_id() and w.is_admin
                    and w.archived_at is null) as was,
               mantle_login_role(${id}::uuid) as shown`;
      expect(r!.now, name).toBe(r!.was);
      expect(r!.shown, name).toBe(['adm', 'dis', 'noUsers'].includes(name) ? 'admin' : 'member');
      for (const area of AREAS) {
        const [a] = await sql<{ now: boolean; was: boolean }[]>`
          select mantle_area_rule(${id}::uuid, ${area}) as now,
                 exists (
                   select 1 from workspaces w
                     join workspace_users u on u.workspace_id = w.id and u.login_id = ${id}::uuid
                     join auth.users l on l.id = u.login_id and l.disabled_at is null
                    where w.owner_id = mantle_brain_id() and w.is_admin
                      and w.archived_at is null
                      and ${area} in ('settings', 'users', 'assistants', 'connectors', 'keys')
                      and coalesce(u.limits -> 'areas' ->> ${area}, '') <> 'false') as was`;
        expect(a!.now, `${name} ${area}`).toBe(a!.was);
      }
    }
    expect(
      (await sql<{ a: boolean }[]>`select mantle_area_rule(${L.noUsers}::uuid, 'users') as a`)[0]!
        .a,
    ).toBe(false);
  });

  it('no app role may run the seat itself', async () => {
    const may = await sql<{ name: string }[]>`
      select r.rolname::text as name from pg_roles r
       where not r.rolsuper and r.rolname <> current_user and r.rolname <> 'mantle_owner'
         and has_function_privilege(r.oid, 'public.mantle_admin_seat(uuid)', 'EXECUTE')`;
    expect(may).toEqual([]);
  });

  it('the seat is inlinable: sql, stable, not a definer, no SET', async () => {
    const [f] = await sql<
      { lang: string; vol: string; secdef: boolean; config: string[] | null }[]
    >`
      select l.lanname::text as lang, p.provolatile::text as vol, p.prosecdef as secdef,
             p.proconfig as config
        from pg_proc p join pg_language l on l.oid = p.prolang
       where p.oid = 'public.mantle_admin_seat(uuid)'::regprocedure`;
    expect(f).toEqual({ lang: 'sql', vol: 's', secdef: false, config: null });
  });
});
