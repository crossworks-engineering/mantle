/**
 * POST /api/users makes a login and its workspace rows (by its role,
 * mantle_bridge_login: Admin for an admin login, as a Moderator; nothing for
 * a member login since 0286) in ONE transaction (W5b2 part B fix round 1):
 * when the rows fail after the insert, no half-made login stays. On a
 * scratch database of its own (a test trigger makes the bridge fail).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/login-create.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('a new login and its workspace rows, in one transaction', () => {
  type Scratch = Awaited<
    ReturnType<typeof import('@mantle/db/test-support').createMigratedScratchDatabase>
  >;
  let scratch: Scratch;
  let m: typeof import('@mantle/db');
  let create: typeof import('./login-create').insertLoginWithWorkspaces;
  const owner = randomUUID();
  let admin = '';

  /** A fixture only the superuser may run (a box mode, a table, a trigger):
   *  the app's pool may log in as the runtime role (arch A9). */
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const sys = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const row = (id: string, email: string, role: 'admin' | 'member') => ({
    id,
    email,
    passwordHash: 'x',
    isOwner: false,
    role,
  });

  beforeAll(async () => {
    const { createMigratedScratchDatabase } = await import('@mantle/db/test-support');
    scratch = await createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    create = (await import('./login-create')).insertLoginWithWorkspaces;
    await sys(sql`insert into auth.users (id, email, password_hash, role, is_owner)
      values (${owner}, ${`o-${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin', true)`);
    await sys(sql`select * from mantle_ws_migrate()`);
    const ws = await sys<{ id: string }>(
      sql`select id::text as id from workspaces where owner_id = ${owner} and is_admin`,
    );
    admin = ws[0]!.id;
    // A new brain has no Team (0286).
    expect(
      await sys(sql`select id from workspaces where owner_id = ${owner} and not is_admin`),
    ).toEqual([]);
    // The bridge fails for a login whose email marks it: after its insert,
    // inside the same transaction.
    await su(sql`create function test_bridge_fails() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from auth.users u
                    where u.id = new.login_id and u.email like 'bridge-fails-%') then
          raise exception 'the bridge failed (test)';
        end if;
        return new;
      end $$`);
    await su(sql`create trigger zz_test_bridge_fails before insert on workspace_users
      for each row execute function test_bridge_fails()`);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('a member login is made in no workspace (0286: no Team, no Moderator by itself)', async () => {
    const id = randomUUID();
    await create(row(id, `ok-${id.slice(0, 8)}@example.invalid`, 'member'));
    const users = await sys<{ id: string }>(
      sql`select id::text as id from auth.users where id = ${id}`,
    );
    expect(users).toHaveLength(1);
    const rows = await sys<{ ws: string; moderator: boolean }>(
      sql`select workspace_id::text as ws, moderator from workspace_users where login_id = ${id}`,
    );
    expect(rows).toEqual([]);
  });

  it('an admin login joins Admin only, as a Moderator', async () => {
    const id = randomUUID();
    await create(row(id, `ad-${id.slice(0, 8)}@example.invalid`, 'admin'));
    const rows = await sys<{ ws: string; moderator: boolean }>(
      sql`select workspace_id::text as ws, moderator from workspace_users where login_id = ${id}`,
    );
    expect(rows).toEqual([{ ws: admin, moderator: true }]);
  });

  it('a role change keeps only the Admin row in step, never another workspace', async () => {
    const id = randomUUID();
    await create(row(id, `rc-${id.slice(0, 8)}@example.invalid`, 'member'));
    const [other] = await sys<{ id: string }>(
      sql`insert into workspaces (owner_id, name) values (${owner}, 'Team') returning id::text as id`,
    );
    await sys(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${other!.id}, ${id}, false)`);
    const rowsOf = () =>
      sys<{ ws: string; moderator: boolean }>(
        sql`select workspace_id::text as ws, moderator from workspace_users
             where login_id = ${id} order by moderator desc, ws`,
      );
    await sys(sql`update auth.users set role = 'admin' where id = ${id}`);
    await sys(sql`select mantle_bridge_login(${id}::uuid)`);
    expect(await rowsOf()).toEqual([
      { ws: admin, moderator: true },
      { ws: other!.id, moderator: false },
    ]);
    await sys(sql`update auth.users set role = 'member' where id = ${id}`);
    await sys(sql`select mantle_bridge_login(${id}::uuid)`);
    expect(await rowsOf()).toEqual([{ ws: other!.id, moderator: false }]);
  });

  it('when the rows fail after the insert, no login is left', async () => {
    const id = randomUUID();
    await expect(
      // An admin login: the bridge writes its Admin row (a member's writes none).
      create(row(id, `bridge-fails-${id.slice(0, 8)}@example.invalid`, 'admin')),
    ).rejects.toThrow();
    const users = await sys<{ n: number }>(
      sql`select count(*)::int as n from auth.users where id = ${id}`,
    );
    expect(users[0]!.n).toBe(0);
    const rows = await sys<{ n: number }>(
      sql`select count(*)::int as n from workspace_users where login_id = ${id}`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('a duplicate email is refused and changes nothing', async () => {
    const id = randomUUID();
    const email = `dup-${id.slice(0, 8)}@example.invalid`;
    await create(row(id, email, 'admin'));
    const again = randomUUID();
    await expect(create(row(again, email, 'member'))).rejects.toThrow();
    const users = await sys<{ n: number }>(
      sql`select count(*)::int as n from auth.users where id = ${again}`,
    );
    expect(users[0]!.n).toBe(0);
    const rows = await sys<{ n: number }>(
      sql`select count(*)::int as n from workspace_users where login_id = ${id}`,
    );
    // The admin: Admin only.
    expect(rows[0]!.n).toBe(1);
  });
});
