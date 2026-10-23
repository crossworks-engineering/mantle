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
 *  - with no scope (an Admin area exit at the full-route spot), the
 *    membership definers act for the exit's acting login: the runtime
 *    role with an Admin user that holds the users area adds and removes
 *    and names it; the area off, a member, a disabled login, a read-only
 *    caller, another workspace, the write role and the narrow role are
 *    refused; no app role may run the helper (mantle_ws_exit_login);
 *  - the Admin seat (mantle_admin_seat): mantle_login_is_admin and
 *    mantle_area_rule answer as 0304's own bodies over a grid of logins,
 *    mantle_login_role says admin for any user of Admin, no app role
 *    may run the seat itself, and the seat is inlinable (round 5).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/role-guard.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NARROW_ROLE, RUNTIME_ROLE, runtimeRoleOn } from './runtime-role';
import {
  createMigratedScratchDatabase,
  createScratchDatabaseBefore,
  ensureAdminUsers,
  ensureTestAnchor,
  runWorkspacesSwitch,
} from './test-support';

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

/** Whether `role` holds `priv` on auth.users (INSERT) or on its role
 *  column (UPDATE): the narrow role's rights there are column-level since
 *  S7b and name no role column and no INSERT, so its write is refused by
 *  those rights (42501 permission denied) before the guard is asked. */
const holds = async (sql: postgres.Sql, role: string, priv: 'INSERT' | 'UPDATE') =>
  (
    await sql<{ on: boolean }[]>`
      select case when ${priv} = 'INSERT'
                  then has_table_privilege(${role}, 'auth.users', 'INSERT')
                  else has_column_privilege(${role}, 'auth.users', 'role', 'UPDATE') end as on`
  )[0]!.on;

const KEY = process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';

/** A client logged in as the runtime role itself (session_user
 *  mantle_runtime, as the app's system pool under MANTLE_DB_RUNTIME_ROLE),
 *  or null where the role has no login on this cluster (the lanes without
 *  the runtime role: the runtime-role lane runs every cell of this file
 *  through such a pool too). */
async function runtimeLogin(sql: postgres.Sql, url: string): Promise<postgres.Sql | null> {
  const [r] = await sql<{ on: boolean }[]>`
    select coalesce((select rolcanlogin from pg_roles where rolname = ${RUNTIME_ROLE}), false) as on`;
  if (!r!.on) return null;
  const rr = await import('./runtime-role');
  const on = postgres(rr.runtimeDatabaseUrl(url, rr.runtimeRolePassword(KEY), RUNTIME_ROLE), {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
  try {
    await on`select 1`;
  } catch {
    await on.end();
    return null;
  }
  return on;
}

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
      if (!(await holds(sql, role, 'INSERT'))) {
        // No INSERT on auth.users at all (the narrow role): no login of any
        // kind, the guard never asked.
        const none = await run(sql, role, insertLogin('admin', true));
        expect(none.ok ? '' : none.state, role).toBe('42501');
        continue;
      }
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
      // The guard's own refusal where the role holds the right (the runtime
      // role); where it does not (the write role, the narrow role's column
      // rights) the right refuses first.
      if (await holds(sql, role, 'UPDATE')) {
        expect(promote.ok ? '' : promote.msg, role).toMatch(/^mantle_role:membership_only/);
        // The role left as it is passes.
        const same = await run(
          sql,
          role,
          (tx) =>
            tx`update auth.users set role = role, display_name = 'x' where id = ${L.adm} returning role`,
        );
        expect(same, role).toEqual({ ok: true, v: [{ role: 'admin' }] });
      }
      if (await holds(sql, role, 'INSERT')) {
        expect(made.ok ? '' : made.msg, role).toMatch(/^mantle_role:membership_only/);
        // A member login passes.
        expect((await run(sql, role, insertLogin('member'))).ok, role).toBe(true);
      }
    }
    // The same through a real runtime login (session_user mantle_runtime,
    // not a superuser's SET ROLE): the guard's own refusal, and a member
    // insert passes.
    const rt = await runtimeLogin(sql, scratch!.url);
    // The runtime-role lane logs in as the runtime role: never skipped there.
    if (!rt) expect(runtimeRoleOn()).toBe(false);
    if (rt) {
      try {
        const promote = await run(
          rt,
          null,
          (tx) => tx`update auth.users set role = 'admin' where id = ${L.mem}`,
        );
        expect(promote.ok ? '' : `${promote.state} ${promote.msg}`).toMatch(
          /^42501 mantle_role:membership_only/,
        );
        const demote = await run(
          rt,
          null,
          (tx) => tx`update auth.users set role = 'member' where id = ${L.adm}`,
        );
        expect(demote.ok ? '' : `${demote.state} ${demote.msg}`).toMatch(
          /^42501 mantle_role:membership_only/,
        );
        const made = await run(rt, null, insertLogin('admin'));
        expect(made.ok ? '' : `${made.state} ${made.msg}`).toMatch(
          /^42501 mantle_role:membership_only/,
        );
        expect((await run(rt, null, insertLogin('member'))).ok).toBe(true);
      } finally {
        await rt.end();
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

  it('with no scope, the definers act for the exit`s acting login: a system session, Admin only, the users area', async () => {
    if (!(await roleExists(sql, RUNTIME_ROLE))) return;
    // An Admin user with the users area off, and a disabled Admin user: in
    // this transaction only (run() rolls it back).
    const noU = randomUUID();
    const dis = randomUUID();
    const fixtures = async (tx: postgres.TransactionSql) => {
      await tx`insert into auth.users (id, email, password_hash, is_owner, role, disabled_at) values
        (${noU}, ${`${tag}-nou@example.test`}, 'x', false, 'admin', null),
        (${dis}, ${`${tag}-dis@example.test`}, 'x', false, 'admin', now())`;
      await tx`insert into workspace_users (workspace_id, login_id, moderator, limits) values
        (${adminWs}, ${noU}, true, '{"areas": {"users": false}}'::jsonb),
        (${adminWs}, ${dis}, true, '{}'::jsonb)`;
    };
    // What a request exit's system actor sends (the gateway's own SET).
    const exit = (acting: string) => ({
      'mantle.actor': 'system:http:area',
      'mantle.write_mode': 'rw',
      'mantle.acting_login': acting,
    });
    const team = (
      await sql<{ id: string }[]>`insert into workspaces (owner_id, name)
        values (${brain}, ${`${tag} team`}) returning id::text as id`
    )[0]!.id;
    const add = (ws: string) => (tx: postgres.TransactionSql) =>
      tx`select mantle_ws_add_user(${brain}::uuid, ${ws}::uuid, ${L.mem}::uuid, true)`;
    const remove = (tx: postgres.TransactionSql) =>
      tx`select mantle_ws_remove_user(${brain}::uuid, ${adminWs}::uuid, ${L.adm}::uuid)`;
    const roleOf = async (tx: postgres.TransactionSql, id: string) =>
      (await tx<{ role: string }[]>`select role from auth.users where id = ${id}`)[0]!.role;
    const lastActor = async (tx: postgres.TransactionSql, id: string) =>
      (
        await tx<{ a: string | null; act: string }[]>`
          select actor_id::text as a, action as act from workspace_events
           where workspace_id = ${adminWs} and subject->>'login' = ${id} and at = now()`
      )[0];
    // The runtime role (the system pool at the spot), an Admin user with the
    // users area: the add and the removal run, write the role, name the caller.
    const added = await run(
      sql,
      RUNTIME_ROLE,
      async (tx) => {
        await add(adminWs)(tx);
        return [await roleOf(tx, L.mem), await lastActor(tx, L.mem)];
      },
      exit(L.adm),
    );
    expect(added).toEqual({
      ok: true,
      v: ['admin', { a: L.adm, act: 'user.add' }],
    });
    const removed = await run(
      sql,
      RUNTIME_ROLE,
      async (tx) => {
        await remove(tx);
        return [await roleOf(tx, L.adm), await lastActor(tx, L.adm)];
      },
      exit(brain),
    );
    expect(removed).toEqual({ ok: true, v: ['member', { a: brain, act: 'user.remove' }] });
    const refused = async (
      role: string,
      settings: Record<string, string>,
      q: (tx: postgres.TransactionSql) => Promise<unknown>,
    ) => {
      const out = await run(
        sql,
        role,
        async (tx) => {
          await tx`reset role`;
          await fixtures(tx);
          await tx.unsafe(`set local role "${role}"`);
          return q(tx);
        },
        settings,
      );
      return out.ok ? 'WROTE' : `${out.state} ${out.msg.split(':').slice(0, 2).join(':')}`;
    };
    // The acting login holds Admin but not the users area: refused.
    expect(await refused(RUNTIME_ROLE, exit(noU), add(adminWs))).toMatch(
      /^42501 mantle_ws:admin_users_only/,
    );
    // A member (no Admin seat) as the acting login: refused, nothing learnt.
    expect(await refused(RUNTIME_ROLE, exit(L.mem), remove)).toMatch(/^P0002 mantle_ws:not_found/);
    // A disabled acting login: refused.
    expect(await refused(RUNTIME_ROLE, exit(dis), add(adminWs))).toMatch(
      /^42501 mantle_ws:no_acting_login/,
    );
    // A read-only caller: refused.
    expect(
      await refused(RUNTIME_ROLE, { ...exit(L.adm), 'mantle.write_mode': 'ro' }, add(adminWs)),
    ).toMatch(/^42501 mantle_ws:read_only/);
    // Another workspace than Admin: the acting login is never taken there.
    expect(await refused(RUNTIME_ROLE, exit(L.adm), add(team))).toMatch(
      /^42501 mantle_ws:no_acting_login/,
    );
    // A system session that SET ROLE to the write role is the write role
    // now (r6 DB LOW-2): its acting login is never taken, as
    // mantle_ws_system_work's test.
    expect(
      await refused(RUNTIME_ROLE, exit(L.adm), async (tx) => {
        await tx.unsafe(`set local role "${WRITER}"`);
        return add(adminWs)(tx);
      }),
    ).toMatch(/^42501 mantle_ws:no_acting_login/);
    // Through a real runtime login: the exit runs and names the caller;
    // after SET ROLE to the write role (where the runtime role may) it is
    // refused the same way.
    const rt = await runtimeLogin(sql, scratch!.url);
    // The runtime-role lane logs in as the runtime role: never skipped there.
    if (!rt) expect(runtimeRoleOn()).toBe(false);
    if (rt) {
      try {
        const viaRuntime = await run(
          rt,
          null,
          async (tx) => {
            await add(adminWs)(tx);
            return [await roleOf(tx, L.mem), await lastActor(tx, L.mem)];
          },
          exit(L.adm),
        );
        expect(viaRuntime).toEqual({ ok: true, v: ['admin', { a: L.adm, act: 'user.add' }] });
        const [m] = await sql<{ may: boolean }[]>`
          select pg_has_role(${RUNTIME_ROLE}, ${WRITER}, 'MEMBER') as may`;
        if (m!.may) {
          const out = await run(
            rt,
            null,
            async (tx) => {
              await tx.unsafe(`set local role "${WRITER}"`);
              return add(adminWs)(tx);
            },
            exit(L.adm),
          );
          expect(out.ok ? 'WROTE' : `${out.state} ${out.msg}`).toMatch(
            /^42501 mantle_ws:no_acting_login/,
          );
        }
      } finally {
        await rt.end();
      }
    }
    // The write role and the narrow role, each logged in as itself (the
    // system session test reads session_user, which SET ROLE leaves the
    // superuser): the write role is no system session, so the acting login
    // it sets itself is never taken; the narrow role may not run the
    // definers, nor the helper.
    const rr = await import('./runtime-role');
    const v = await import('./viewer');
    const opts = { max: 1, prepare: false, onnotice: () => {} } as const;
    const asLogin = async (url: string, q: (tx: postgres.TransactionSql) => Promise<unknown>) => {
      const on = postgres(url, opts);
      try {
        const out = await run(on, null, q, exit(L.adm));
        return out.ok ? 'WROTE' : `${out.state} ${out.msg.split(':').slice(0, 2).join(':')}`;
      } finally {
        await on.end();
      }
    };
    if (await roleExists(sql, WRITER)) {
      const wr = v.viewerDatabaseUrl(scratch!.url, 'write', v.viewerRolePassword(KEY, 'write'));
      const who = await asLogin(wr, (tx) => tx`select session_user::text as s`);
      expect(who).toBe('WROTE');
      expect(await asLogin(wr, add(adminWs))).toMatch(/^42501 mantle_ws:no_acting_login/);
    }
    if (await roleExists(sql, NARROW_ROLE)) {
      const nl = rr.runtimeDatabaseUrl(scratch!.url, rr.narrowRolePassword(KEY), NARROW_ROLE);
      expect(await asLogin(nl, add(adminWs))).toMatch(/^42501 /);
      expect(
        await asLogin(
          nl,
          (tx) => tx`select mantle_ws_exit_login('x', ${brain}::uuid, ${adminWs}::uuid)`,
        ),
      ).toMatch(/^42501 /);
    }
    // No app role may run the helper itself.
    for (const role of [RUNTIME_ROLE, NARROW_ROLE, WRITER, 'mantle_view_user']) {
      if (!(await roleExists(sql, role))) continue;
      const [r] = await sql<{ may: boolean }[]>`
        select has_function_privilege(${role}, 'public.mantle_ws_exit_login(text,uuid,uuid)',
                                      'EXECUTE') as may`;
      expect(r!.may, role).toBe(false);
    }
  });

  it('the guard and the two membership definers share one owner (r6 DB LOW-3)', async () => {
    // The guard lets its own owner through as the definers' owner: true
    // only while one role owns all three.
    const owners = await sql<{ fn: string; owner: string }[]>`
      select p.oid::regprocedure::text as fn, p.proowner::regrole::text as owner
        from pg_proc p
       where p.oid in ('public.mantle_login_role_guard()'::regprocedure,
                       'public.mantle_ws_add_user(uuid,uuid,uuid,boolean)'::regprocedure,
                       'public.mantle_ws_remove_user(uuid,uuid,uuid)'::regprocedure)`;
    expect(owners).toHaveLength(3);
    expect(new Set(owners.map((o) => o.owner)).size, JSON.stringify(owners)).toBe(1);
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

  it('never takes the anchor out, nor an Admin user a former-client row names (r6 DB LOW-1)', async () => {
    const [b] = await sql<{ id: string }[]>`select mantle_brain_id()::text as id`;
    for (const id of [b!.id, L.adm]) {
      // A former-client row for the login (written by the superuser here;
      // whoever can write one), then the bridge as the runtime role, which
      // may run it (an image one release back calls it).
      const out = await run(sql, RUNTIME_ROLE, async (tx) => {
        await tx`reset role`;
        await tx`insert into archive_client_logins (login_id, email, created_at, session_epoch)
                 values (${id}, ${`${tag}-arc@example.test`}, now(), 0) on conflict do nothing`;
        await tx.unsafe(`set local role "${RUNTIME_ROLE}"`);
        await tx`select mantle_bridge_login(${id}::uuid)`;
        const [r] = await tx<{ row: boolean }[]>`
          select exists (select 1 from workspace_users u
                          where u.workspace_id = ${adminWs} and u.login_id = ${id}) as row`;
        return r!.row;
      });
      expect(out, id === b!.id ? 'anchor' : 'admin').toEqual({ ok: true, v: true });
    }
    // The anchor even with a role other than admin in the row (0272's CHECK
    // refuses that, so the guard is the early return, asked directly).
    const [src] = await sql<{ body: string }[]>`
      select prosrc as body from pg_proc
       where oid = 'public.mantle_bridge_login(uuid)'::regprocedure`;
    expect(src!.body).toMatch(
      /IF login IS NOT DISTINCT FROM "public"\."mantle_brain_id"\(\) THEN RETURN;/,
    );
    expect(src!.body).not.toMatch(/FROM "public"\."archive_client_logins"/);
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

describe.skipIf(!URL)('0330 refuses the migrate on the looser drift only (r6 DB MED-1)', () => {
  const TAG = '0330_s8b_role_follows_membership';
  const tag = `rm${randomUUID().slice(0, 8)}`;
  const dbs: Awaited<ReturnType<typeof createScratchDatabaseBefore>>[] = [];
  const open = async () => {
    const db = await createScratchDatabaseBefore(URL!, TAG);
    dbs.push(db);
    return { db, sql: postgres(db.url, { max: 1, prepare: false, onnotice: () => {} }) };
  };
  const guardThere = async (sql: postgres.Sql) =>
    (
      await sql<{ on: boolean }[]>`
        select exists (select 1 from pg_trigger t
                        where t.tgrelid = 'auth.users'::regclass
                          and t.tgname = 'users_role_guard') as on`
    )[0]!.on;
  const login = (sql: postgres.Sql, id: string, role: 'admin' | 'member') =>
    sql`insert into auth.users (id, email, password_hash, is_owner, role)
        values (${id}, ${`${tag}-${id.slice(0, 8)}@example.test`}, 'x', false, ${role})`;

  /** The migrate's refusal (null when it went through). */
  const refusal = (db: Awaited<ReturnType<typeof createScratchDatabaseBefore>>) =>
    db.migrateRest().then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    );

  afterAll(async () => {
    for (const db of dbs) await db.drop();
  });

  it('an Admin seat without role admin refuses (42501, nothing written); repaired, it migrates; role admin without a seat does not refuse', async () => {
    const { db, sql } = await open();
    try {
      await ensureTestAnchor(sql);
      const seated = randomUUID(); // a seat, role member: the looser drift
      const unseated = randomUUID(); // role admin, no seat: the narrower drift
      await login(sql, seated, 'member');
      await login(sql, unseated, 'admin');
      await ensureAdminUsers(sql, [seated]);
      const err = await refusal(db);
      expect(err?.code).toBe('42501');
      expect(err?.message).toMatch(
        /^mantle S8b: 1 login\(s\) hold an Admin seat without role admin/,
      );
      // 0330 rolled back whole: no guard, the membership-only fact not in.
      expect(await guardThere(sql)).toBe(false);
      // The second repair the hint names, a grant (the image one release
      // back's promotion: the role written, the seat already there).
      await sql`update auth.users set role = 'admin' where id = ${seated}`;
      await db.migrateRest();
      expect(await guardThere(sql)).toBe(true);
      const [r] = await sql<{ drift: number; seated: boolean; unseated: boolean }[]>`
        select mantle_role_drift() as drift,
               mantle_login_is_admin_user(${seated}::uuid) as seated,
               mantle_login_is_admin_user(${unseated}::uuid) as unseated`;
      // The narrower drift is left (the NOTICE counts it); nobody looser.
      expect(r).toEqual({ drift: 1, seated: true, unseated: false });
    } finally {
      await sql.end();
    }
  }, 300_000);

  // r7 DB LOW-B and LOW-A: a disabled login's seat makes it an Admin user on
  // its re-enable (which writes no role), and a former client is a member
  // like any other login: each alone refuses. The first repair the hint
  // names (the seat taken away) then lets the migrate through.
  it('a disabled member with a seat refuses, and so does a re-enabled former client with a seat and role member', async () => {
    for (const kind of ['disabled', 'former client'] as const) {
      const { db, sql } = await open();
      try {
        const brain = await ensureTestAnchor(sql);
        const id = randomUUID();
        await login(sql, id, 'member');
        if (kind === 'disabled') {
          await sql`update auth.users set disabled_at = now() where id = ${id}`;
        } else {
          // Archived as a client once, enabled again since (disabled_at null).
          await sql`insert into archive_client_logins (login_id, email, created_at, disabled_at, session_epoch)
                    values (${id}, ${`${tag}-arc-${id.slice(0, 8)}@example.test`}, now(), now(), 0)`;
        }
        await ensureAdminUsers(sql, [id]);
        const err = await refusal(db);
        expect(err?.code, kind).toBe('42501');
        expect(err?.message, kind).toMatch(/^mantle S8b: 1 login\(s\) hold an Admin seat/);
        expect(await guardThere(sql), kind).toBe(false);
        // The first repair: the seat taken away (as the older image's
        // removal does), the role left member.
        await sql`delete from workspace_users u using workspaces w
                   where u.workspace_id = w.id and w.owner_id = ${brain} and w.is_admin
                     and u.login_id = ${id}`;
        await db.migrateRest();
        expect(await guardThere(sql), kind).toBe(true);
        const [r] = await sql<{ role: string; admin: boolean }[]>`
          select mantle_login_role(${id}::uuid) as role, mantle_login_is_admin_user(${id}::uuid) as admin`;
        expect(r, kind).toEqual({ role: 'member', admin: false });
      } finally {
        await sql.end();
      }
    }
  }, 600_000);

  // r7 DB LOW-C: the revert puts back what 0330 dropped as main has it: the
  // three bridge functions (body, owner, rights) everywhere, the two
  // bridge triggers only on a brain that never took the switch (no
  // nodes_levels_frozen), and mantle_role_drift's 0304 body. The rollback
  // drill diffs the whole schema; this cell also takes the unswitched path.
  it('the revert puts the bridges back as they stood, the triggers only where the switch never ran', async () => {
    const REVERT = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'rollback',
      `${TAG}.revert.sql`,
    );
    const statements = readFileSync(REVERT, 'utf8')
      .split('--> statement-breakpoint')
      .map((st) => st.trim())
      .filter((st) => st.replace(/^--.*$/gm, '').trim() !== '');
    const catalog = async (sql: postgres.Sql) =>
      sql<{ what: string; v: string }[]>`
        select p.proname::text as what,
               md5(p.prosrc) || ' ' || pg_get_userbyid(p.proowner) || ' ' ||
               coalesce(p.proacl::text, '-') || ' ' || p.prosecdef::text as v
          from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and p.proname in ('mantle_bridge_connector', 'mantle_bridge_connector_trg',
                             'mantle_bridge_login_trg', 'mantle_role_drift')
        union all
        select t.tgname::text, pg_get_triggerdef(t.oid) || ' ' || t.tgenabled::text
          from pg_trigger t
         where t.tgname in ('users_zz_bridge', 'tool_groups_zz_bridge')
         order by 1`;
    for (const switched of [true, false]) {
      const { db, sql } = await open();
      try {
        if (!switched) {
          // A brain that never took the switch, as 0251 left it.
          await sql`drop trigger if exists nodes_levels_frozen on public.nodes`;
          await sql.unsafe(`CREATE TRIGGER "tool_groups_zz_bridge"
            AFTER INSERT OR DELETE OR UPDATE OF "audience", "enabled", "integration", "slug", "owner_id"
            ON "public"."tool_groups"
            FOR EACH ROW EXECUTE FUNCTION "public"."mantle_bridge_connector_trg"()`);
          await sql.unsafe(`CREATE TRIGGER "users_zz_bridge" AFTER INSERT OR UPDATE OF "role" ON auth.users
            FOR EACH ROW EXECUTE FUNCTION "public"."mantle_bridge_login_trg"()`);
        }
        const before = await catalog(sql);
        expect(before.filter((r) => r.what.endsWith('_zz_bridge')).length, String(switched)).toBe(
          switched ? 0 : 2,
        );
        await db.migrateRest();
        expect(
          (await catalog(sql)).map((r) => r.what),
          String(switched),
        ).toEqual(['mantle_role_drift']);
        await sql.begin(async (tx) => {
          for (const st of statements) await tx.unsafe(st);
        });
        expect(await catalog(sql), String(switched)).toEqual(before);
      } finally {
        await sql.end();
      }
    }
  }, 600_000);

  it('a brain still off workspaces migrates; its switch after migrate seats the role admin logins, no drift', async () => {
    const { db, sql } = await open();
    try {
      const brain = await ensureTestAnchor(sql);
      const adm = randomUUID();
      const mem = randomUUID();
      await login(sql, adm, 'admin');
      await login(sql, mem, 'member');
      const [w] = await sql<{ n: number }[]>`
        select count(*)::int as n from workspaces where owner_id = ${brain} and is_admin`;
      expect(w!.n).toBe(0);
      await db.migrateRest();
      expect(await guardThere(sql)).toBe(true);
      // The boot's switch, after migrate (server/main.ts).
      await runWorkspacesSwitch(db.url);
      const [r] = await sql<{ drift: number; adm: boolean; mem: boolean; owner: boolean }[]>`
        select mantle_role_drift() as drift, mantle_login_is_admin(${adm}::uuid) as adm,
               mantle_login_is_admin(${mem}::uuid) as mem,
               mantle_login_is_admin(${brain}::uuid) as owner`;
      expect(r).toEqual({ drift: 0, adm: true, mem: false, owner: true });
    } finally {
      await sql.end();
    }
  }, 300_000);
});
