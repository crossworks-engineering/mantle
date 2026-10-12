/**
 * The client level after the audit fixes (migration 0189), on a real,
 * migrated Postgres:
 *  - A27: mantle_brain_id() runs for the viewer roles and the space role,
 *    and no longer for any other role (EXECUTE revoked from PUBLIC); the
 *    client role reads no embedding config and no profile name, only the
 *    preferences.
 * The client LEVEL stays (the viewer role mantle_view_client); there is no
 * client login role since 0272, so nothing here makes a client login.
 * Seeds its own login and item and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/client-level-fixes.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the client level after the audit fixes', () => {
  type Db = typeof import('./index');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let admin: Admin;
  let sqlTag: typeof import('drizzle-orm').sql;
  let anchor = '';
  const tag = `clfix${randomUUID().slice(0, 8)}`;
  const probeRole = `mantle_probe_${tag}`;
  const member = randomUUID();
  const item = { member: randomUUID() };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('./test-support');
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    anchor = await ensureTestAnchor(admin);
    await admin.unsafe(`create role "${probeRole}" nologin`);
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member')`;
    const space = async (login: string) =>
      (
        await admin<{ id: string }[]>`
          select id from spaces where kind = 'personal' and login_id = ${login}`
      )[0]!.id;
    await admin`insert into nodes (id, owner_id, type, title, path) values
      (${item.member}, ${await space(member)}, 'page', ${`${tag} member draft`}, 'pages')`;
    await admin`insert into space_items (node_id, author_login_id) values
      (${item.member}, ${member})`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from nodes where id = ${item.member}`;
    await admin`delete from spaces where login_id = ${member}`;
    await admin`delete from auth.users where id = ${member}`;
    await admin.unsafe(`drop role if exists "${probeRole}"`);
    await m?.closeDb();
  });

  it('mantle_brain_id(): EXECUTE for the viewer and space roles only (A27)', async () => {
    const can = async (role: string) =>
      (
        await admin<{ ok: boolean }[]>`
          select has_function_privilege(${role}, 'public.mantle_brain_id()', 'EXECUTE') as ok`
      )[0]!.ok;
    for (const role of [
      'mantle_view_team',
      'mantle_view_client',
      'mantle_view_public',
      'mantle_view_space',
    ]) {
      expect(await can(role), role).toBe(true);
    }
    expect(await can(probeRole), 'a role with no grant').toBe(false);
    // And it still resolves for the client role.
    const [brain] = (await m.runInLevelRoleForTest('client', () =>
      m.db.execute(sqlTag`select mantle_brain_id() as id`),
    )) as unknown as { id: string }[];
    expect(brain!.id).toBe(anchor);
  });

  it('the client role reads no embedding config and only the preferences of a profile (A27)', async () => {
    await expect(
      m.runInLevelRoleForTest('client', () =>
        m.db.execute(sqlTag`select 1 from embedding_config limit 1`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      m.runInLevelRoleForTest('client', () =>
        m.db.execute(sqlTag`select display_name from profiles limit 1`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      m.runInLevelRoleForTest('client', () =>
        m.db.execute(sqlTag`select preferences from profiles where user_id = ${anchor}`),
      ),
    ).resolves.toBeDefined();
    // The team role is unchanged.
    await expect(
      m.runInLevelRoleForTest('team', async () => [
        await m.db.execute(sqlTag`select display_name from profiles limit 1`),
        await m.db.execute(sqlTag`select 1 from embedding_config limit 1`),
      ]),
    ).resolves.toBeDefined();
  });
});
