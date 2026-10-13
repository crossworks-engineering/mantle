/**
 * Migration 0286 (owner decision 2026-10-13): Team is a normal workspace.
 * On a scratch brain switched to workspaces BEFORE 0286 (Team built in,
 * every login a Moderator there), then migrated:
 *
 *  - Team keeps its name, items, homes, grants, users and every Moderator
 *    tick; it loses bridge_key and admin_moderated, takes the icon its old
 *    kind drew (one picked before stays), and one workspace_events row says
 *    so. A second run changes nothing;
 *  - mantle_ws_kind has no 'team' kind;
 *  - the login bridge gives Admin only: a new member joins nothing, an
 *    admin joins Admin as a Moderator, and a role change never touches
 *    Team's rows;
 *  - "Team" is no reserved name any more; "Admin" still is.
 * And a new brain switched after 0286 has no Team at all.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/team-normal-0286.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase, createScratchDatabaseBefore } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('migration 0286: Team is a normal workspace', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: ReturnType<typeof postgres>;
  const owner = randomUUID();
  const member = randomUUID();
  const page = randomUUID();
  let team = '';
  let admin = '';
  type Snap = {
    users: readonly unknown[];
    grants: readonly unknown[];
    row: Record<string, unknown>;
  };
  let before: Snap;

  const snap = async (): Promise<Snap> => ({
    users: await sql`select login_id::text as login, moderator from workspace_users
                      where workspace_id = ${team} order by login_id`,
    grants: await sql`select node_id::text as node, write, is_home, excluded from item_grants
                       where workspace_id = ${team} order by node_id`,
    row: (
      await sql`select name, description, archived_at, landing_app_id, color,
                       bridge_key, admin_moderated, icon
                  from workspaces where id = ${team}`
    )[0]!,
  });

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, '0286_workspaces_team_normal');
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, 'o@example.invalid', 'x', 'admin', true),
      (${member}, 'm@example.invalid', 'x', 'member', false)`;
    await sql`insert into nodes (id, owner_id, type, title, path, audience)
      values (${page}, ${owner}, 'page', 'shared page', 'pages', 'team')`;
    await sql`select * from mantle_ws_migrate()`;
    const ws = await sql<{ id: string; key: string | null }[]>`
      select id::text as id, bridge_key as key from workspaces where owner_id = ${owner}`;
    admin = ws.find((w) => w.key === 'admin')!.id;
    team = ws.find((w) => w.key === 'team')!.id;
    before = await snap();
    await scratch.migrateRest();
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('before 0286 the switch made Team built in, every login its Moderator', () => {
    expect(before.row).toMatchObject({ name: 'Team', bridge_key: 'team', admin_moderated: true });
    expect(before.users).toEqual(
      [
        { login: owner, moderator: true },
        { login: member, moderator: true },
      ].sort((a, b) => a.login.localeCompare(b.login)),
    );
    expect(before.grants).toContainEqual({
      node: page,
      write: false,
      is_home: false,
      excluded: false,
    });
  });

  it('keeps Team as it was, ticks included, and only drops its built-in mark', async () => {
    const after = await snap();
    expect(after.users).toEqual(before.users);
    expect(after.grants).toEqual(before.grants);
    expect(after.row).toEqual({
      ...before.row,
      bridge_key: null,
      admin_moderated: false,
      icon: 'lucide:users',
    });
    const ev = await sql<{ actor: string | null; subject: unknown }[]>`
      select actor_id::text as actor, subject from workspace_events
       where workspace_id = ${team} and action = 'workspace.update'`;
    expect(ev).toEqual([
      { actor: null, subject: { builtIn: false, by: 'migration 0286', icon: 'lucide:users' } },
    ]);
    expect((await sql`select mantle_brain_team_ws() as t`)[0]!.t).toBeNull();
  });

  it('a second run changes nothing', async () => {
    const again = await sql`select * from mantle_ws_team_normal(false)`;
    expect(again).toEqual([]);
    const n = await sql<{ n: number }[]>`select count(*)::int as n from workspace_events
      where workspace_id = ${team} and action = 'workspace.update'`;
    expect(n[0]!.n).toBe(1);
  });

  it('mantle_ws_kind: Team is other, Admin admin', async () => {
    const [k] = await sql<{ team: string; admin: string }[]>`
      select mantle_ws_kind(${team}::uuid) as team, mantle_ws_kind(${admin}::uuid) as admin`;
    expect(k).toEqual({ team: 'other', admin: 'admin' });
  });

  it('the login bridge gives Admin only, and never touches Team', async () => {
    const z = randomUUID();
    await sql`insert into auth.users (id, email, password_hash, role)
      values (${z}, 'z@example.invalid', 'x', 'member')`;
    const rows = async () =>
      (
        await sql<{ ws: string; moderator: boolean }[]>`
          select workspace_id::text as ws, moderator from workspace_users
           where login_id = ${z} order by moderator desc, workspace_id`
      ).map((r) => `${r.ws === admin ? 'A' : r.ws === team ? 'T' : '?'}:${r.moderator}`);
    await sql`select mantle_bridge_login(${z})`;
    expect(await rows()).toEqual([]);
    // An Admin user put them in Team, not as a Moderator.
    await sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${team}, ${z}, false)`;
    await sql`update auth.users set role = 'admin' where id = ${z}`;
    await sql`select mantle_bridge_login(${z})`;
    expect(await rows()).toEqual(['A:true', 'T:false']);
    await sql`update auth.users set role = 'member' where id = ${z}`;
    await sql`select mantle_bridge_login(${z})`;
    expect(await rows()).toEqual(['T:false']);
    // The member's Team tick from the switch stays as it was.
    await sql`select mantle_bridge_login(${member})`;
    const [m] = await sql<{ moderator: boolean }[]>`select moderator from workspace_users
      where workspace_id = ${team} and login_id = ${member}`;
    expect(m!.moderator).toBe(true);
  });

  it('"Team" is a name like any other; "Admin" stays reserved', async () => {
    await sql`insert into workspaces (owner_id, name) values (${owner}, 'team')`;
    await expect(
      sql`insert into workspaces (owner_id, name) values (${owner}, ' ADMIN ')`,
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe.skipIf(!URL)('a new brain after 0286 has no Team', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let sql: ReturnType<typeof postgres>;
  const owner = randomUUID();

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner)
      values (${owner}, 'o@example.invalid', 'x', 'admin', true)`;
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('the switch makes Admin only, and says it left Team out', async () => {
    const out = await sql<{ section: string; subject: string; metric: string }[]>`
      select section, subject, metric from mantle_ws_migrate()`;
    expect(out).toContainEqual({
      section: 'team',
      subject: 'Team workspace',
      metric: 'not kept (held nothing)',
    });
    const ws = await sql`select name, is_admin, bridge_key from workspaces`;
    expect(ws).toEqual([{ name: 'Admin', is_admin: true, bridge_key: 'admin' }]);
    // The owner is Admin's Moderator; no event points at a workspace gone.
    expect(await sql`select moderator from workspace_users where login_id = ${owner}`).toEqual([
      { moderator: true },
    ]);
    expect(
      (
        await sql<{ n: number }[]>`select count(*)::int as n from workspace_events
        where workspace_id is null`
      )[0]!.n,
    ).toBe(0);
    // A second switch finds the brain migrated and does nothing.
    expect(await sql`select section, metric from mantle_ws_migrate()`).toEqual([
      { section: 'skip', metric: 'already migrated' },
    ]);
  });
});
