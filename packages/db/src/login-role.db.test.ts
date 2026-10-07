/**
 * Login rows on a real, MIGRATED Postgres (client logins audit, 2026-09-29):
 *
 *  - A14: auth.users.role has no default (0190). An insert that forgets the
 *    role fails, where it used to make an ADMIN login.
 *  - A16: withSpace checks the pair it is given in the same query that reads
 *    the level: the space must be the login's own, and the login active. A
 *    mixed-up pair (a real space, another real login) or a disabled login
 *    throws before anything runs.
 *  - I8 (0200): a login's role never changes to or from client, by any
 *    UPDATE; admin and member still change into each other.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/login-role.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const NOT_NULL_VIOLATION = '23502';
const CHECK_VIOLATION = '23514';

describe.skipIf(!URL)('login rows: the role is always named, withSpace checks the pair', () => {
  type Db = typeof import('./index');
  let m: Db;
  let sql: Parameters<Db['ensureViewerRoles']>[0];
  const tag = `login-role-${randomUUID().slice(0, 8)}`;
  const member = randomUUID();
  const other = randomUUID();
  const client = randomUUID();
  const logins = [member, other, client];
  const spaceOf: Record<string, string> = {};

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    await m.ensureViewerRoles(sql, process.env.MANTLE_MASTER_KEY);
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member'),
      (${other}, ${`${tag}-o@example.invalid`}, 'x', 'member'),
      (${client}, ${`${tag}-c@example.invalid`}, 'x', 'client')`;
    const rows = await sql<{ id: string; login_id: string }[]>`
      select id, login_id from spaces where kind = 'personal' and login_id in ${sql(logins)}`;
    for (const r of rows) spaceOf[r.login_id] = r.id;
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from spaces where login_id in ${sql(logins)}`;
    await sql`delete from auth.users where id in ${sql(logins)}`;
    await m.closeDb();
  });

  it('auth.users.role has no column default', async () => {
    const [col] = await sql<{ d: string | null; nullable: string }[]>`
      select column_default as d, is_nullable as nullable from information_schema.columns
       where table_schema = 'auth' and table_name = 'users' and column_name = 'role'`;
    expect(col).toEqual({ d: null, nullable: 'NO' });
  });

  it('an insert without a role fails instead of making an admin', async () => {
    const id = randomUUID();
    await expect(
      sql`insert into auth.users (id, email, password_hash)
          values (${id}, ${`${tag}-x@example.invalid`}, 'x')`,
    ).rejects.toMatchObject({ code: NOT_NULL_VIOLATION });
    expect(await sql`select 1 from auth.users where id = ${id}`).toHaveLength(0);
  });

  it('withSpace runs for a login in its own space', async () => {
    expect(
      await m.withSpace({ spaceId: spaceOf[member]!, loginId: member }, async () =>
        m.currentViewerLevel(),
      ),
    ).toBe('team');
    expect(
      await m.withSpace({ spaceId: spaceOf[client]!, loginId: client }, async () =>
        m.currentViewerLevel(),
      ),
    ).toBe('client');
  });

  it('withSpace refuses a space that is not the login’s own', async () => {
    let ran = false;
    const run = async () => {
      ran = true;
    };
    // Another member's real space, and a client's space under a member login
    // (which would also have run the client's space at team).
    await expect(m.withSpace({ spaceId: spaceOf[other]!, loginId: member }, run)).rejects.toThrow(
      /not this login/,
    );
    await expect(m.withSpace({ spaceId: spaceOf[client]!, loginId: member }, run)).rejects.toThrow(
      /not this login/,
    );
    await expect(m.withSpace({ spaceId: randomUUID(), loginId: member }, run)).rejects.toThrow(
      /not this login/,
    );
    expect(ran).toBe(false);
  });

  it('withSpace refuses a disabled login, even in its own space', async () => {
    let ran = false;
    await sql`update auth.users set disabled_at = now() where id = ${other}`;
    try {
      await expect(
        m.withSpace({ spaceId: spaceOf[other]!, loginId: other }, async () => {
          ran = true;
        }),
      ).rejects.toThrow(/disabled/);
    } finally {
      await sql`update auth.users set disabled_at = null where id = ${other}`;
    }
    expect(ran).toBe(false);
    // Enabled again, the same pair runs.
    expect(await m.withSpace({ spaceId: spaceOf[other]!, loginId: other }, async () => 'ok')).toBe(
      'ok',
    );
  });

  it('a role never changes to or from client; admin and member still swap (I8)', async () => {
    const roleOf = async (id: string) =>
      (await sql<{ role: string }[]>`select role from auth.users where id = ${id}`)[0]?.role;
    for (const role of ['member', 'admin']) {
      await expect(
        sql`update auth.users set role = ${role} where id = ${client}`,
        role,
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
    await expect(
      sql`update auth.users set role = 'client' where id = ${member}`,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect(await roleOf(client)).toBe('client');
    expect(await roleOf(member)).toBe('member');
    // Not a role change: other columns of a client, and client to client.
    await sql`update auth.users set display_name = 'C', role = 'client' where id = ${client}`;
    // Staff roles change as before.
    await sql`update auth.users set role = 'admin' where id = ${other}`;
    await sql`update auth.users set role = 'member' where id = ${other}`;
    expect(await roleOf(other)).toBe('member');
  });
});
