/**
 * The roll of "Team is a normal workspace" (0286, owner answer Q1) on a
 * scratch brain the workspaces switch made live (lib/workspace-ticks.ts):
 *
 *  - ws:team-check counts, numbers only: the former Team (0286's row), its
 *    Moderators who are not Admin users, the same over every shared
 *    workspace, and member-built apps with no holder beyond Admin;
 *  - ws:clear-member-ticks: a dry run changes nothing; --apply clears the
 *    member ticks only, keeps the Admin users' ticks, never removes a row,
 *    writes one user.moderator event per change (no actor, `by`), and
 *    keeps a Moderator when no Admin user moderates the workspace;
 *  - it refuses the Admin workspace, an archived one and an unknown id;
 *  - "Admin user" is adminUserSql, mayPromote's rule: a disabled Admin
 *    login or one whose users area is off is no Admin user (fix round 2);
 *  - the counts after the clear are 0, and a second run clears nothing.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/workspace-ticks.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the 0286 roll: count, then clear the member ticks', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('./workspace-ticks');
  const owner = randomUUID();
  const adm2 = randomUUID();
  const mem = randomUUID();
  const mem2 = randomUUID();
  const mem3 = randomUUID();
  let team = '';
  let admin = '';
  const appNoHolder = randomUUID();
  const appHeld = randomUUID();
  const appAdminBuilt = randomUUID();

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const email = (id: string) => `ticks-${id.slice(0, 8)}@example.invalid`;
  const tick = async (ws: string, id: string) =>
    (
      await x<{ moderator: boolean }>(
        sql`select moderator from workspace_users where workspace_id = ${ws} and login_id = ${id}`,
      )
    )[0]?.moderator ?? null;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    t = await import('./workspace-ticks');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${owner}, ${email(owner)}, 'x', true, 'admin'),
      (${adm2}, ${email(adm2)}, 'x', false, 'admin'),
      (${mem}, ${email(mem)}, 'x', false, 'member'),
      (${mem2}, ${email(mem2)}, 'x', false, 'member'),
      (${mem3}, ${email(mem3)}, 'x', false, 'member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    // Two apps a member built and one an admin built, before the switch:
    // the switch homes them in Admin.
    for (const [id, level] of [
      [appNoHolder, 'team'],
      [appHeld, 'team'],
      [appAdminBuilt, 'admin'],
    ] as const) {
      await x(sql`insert into nodes (id, owner_id, type, title, path, audience)
        values (${id}, ${owner}, 'app', 'an app', 'apps', 'admin')`);
      await x(sql`insert into apps (node_id, source, author_level)
        values (${id}, '{}'::jsonb, ${level})`);
    }
    // The switch: every login a Team Moderator, then 0286's step makes
    // Team a normal workspace (it holds members, so it is kept).
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    const ws = await x<{ id: string; is_admin: boolean }>(sql`
      select id::text as id, is_admin from workspaces
       where owner_id = ${owner} and (is_admin or name = 'Team')`);
    admin = ws.find((w) => w.is_admin)!.id;
    team = ws.find((w) => !w.is_admin)!.id;
    // One member-built app is shared with Team again; the other is not.
    await m.withHeads([appHeld], 'update', (tx) =>
      tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
        values (${appHeld}, ${team}, false)`),
    );
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('the switch left Team normal, every login a Moderator', async () => {
    const [b] = await x<{ bridge_key: string | null }>(
      sql`select bridge_key from workspaces where id = ${team}`,
    );
    expect(b!.bridge_key).toBeNull();
    for (const id of [owner, adm2, mem, mem2, mem3]) expect(await tick(team, id), id).toBe(true);
  });

  it('ws:team-check: numbers only', async () => {
    const c = await t.teamCheckCounts();
    expect(c).toEqual({
      formerTeam: 1,
      formerTeamMemberModerators: 3,
      sharedMemberModerators: 3,
      memberAppsWithoutHolder: 1,
    });
    for (const v of Object.values(c)) expect(typeof v).toBe('number');
  });

  it('refuses the Admin workspace, an unknown or bad id, and an archived workspace', async () => {
    expect(await t.clearMemberTicks(admin, true)).toEqual({
      ok: false,
      reason: 'admin_workspace',
    });
    expect(await t.clearMemberTicks(randomUUID(), true)).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await t.clearMemberTicks('not-a-uuid', true)).toEqual({
      ok: false,
      reason: 'not_found',
    });
    const [gone] = await x<{ id: string }>(sql`insert into workspaces (owner_id, name, archived_at)
      values (${owner}, 'Old', now()) returning id::text as id`);
    expect(await t.clearMemberTicks(gone!.id, true)).toEqual({ ok: false, reason: 'archived' });
  });

  it('a dry run counts and changes nothing', async () => {
    const before = await x<{ n: number }>(sql`select count(*)::int as n from workspace_events`);
    const r = await t.clearMemberTicks('former-team', false);
    expect(r).toEqual({
      ok: true,
      applied: false,
      moderators: 5,
      adminModerators: 2,
      cleared: 3,
      keptForLastModerator: 0,
    });
    for (const id of [mem, mem2, mem3]) expect(await tick(team, id)).toBe(true);
    const after = await x<{ n: number }>(sql`select count(*)::int as n from workspace_events`);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('--apply clears the member ticks, keeps the Admin users and every row, logs each', async () => {
    const r = await t.clearMemberTicks(team, true);
    expect(r).toMatchObject({ ok: true, applied: true, cleared: 3, keptForLastModerator: 0 });
    for (const id of [mem, mem2, mem3]) expect(await tick(team, id), id).toBe(false);
    for (const id of [owner, adm2]) expect(await tick(team, id), id).toBe(true);
    const ev = await x<{ actor_id: string | null; subject: Record<string, unknown> }>(sql`
      select actor_id, subject from workspace_events
       where workspace_id = ${team} and action = 'user.moderator' order by subject->>'login'`);
    expect(ev).toHaveLength(3);
    for (const e of ev) {
      expect(e.actor_id).toBeNull();
      expect(e.subject).toMatchObject({ moderator: false, by: t.CLEAR_TICKS_BY });
    }
    expect(ev.map((e) => e.subject.login).sort()).toEqual([mem, mem2, mem3].sort());
    // Counted again: none left there; a second run clears nothing.
    expect((await t.teamCheckCounts()).formerTeamMemberModerators).toBe(0);
    expect(await t.clearMemberTicks(team, true)).toMatchObject({ ok: true, cleared: 0 });
  });

  it('with no Admin user among its Moderators, the member added first keeps the tick', async () => {
    const [ws] = await x<{ id: string }>(sql`insert into workspaces (owner_id, name)
      values (${owner}, 'Field') returning id::text as id`);
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator, added_at) values
      (${ws!.id}, ${mem2}, true, now() - interval '2 days'),
      (${ws!.id}, ${mem}, true, now() - interval '1 day'),
      (${ws!.id}, ${mem3}, false, now())`);
    const r = await t.clearMemberTicks(ws!.id, true);
    expect(r).toEqual({
      ok: true,
      applied: true,
      moderators: 2,
      adminModerators: 0,
      cleared: 1,
      keptForLastModerator: 1,
    });
    expect(await tick(ws!.id, mem2)).toBe(true);
    expect(await tick(ws!.id, mem)).toBe(false);
    expect(await tick(ws!.id, mem3)).toBe(false);
    const [n] = await x<{ n: number }>(
      sql`select count(*)::int as n from workspace_users where workspace_id = ${ws!.id}`,
    );
    expect(n!.n).toBe(3);
  });

  it('a disabled Admin login, or one with the users area off, is no Admin user here (fix round 2, L1)', async () => {
    const off = randomUUID();
    const noUsers = randomUUID();
    // Admin logins: the login bridge makes each a user of Admin.
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${off}, ${email(off)}, 'x', false, 'admin'),
      (${noUsers}, ${email(noUsers)}, 'x', false, 'admin')`);
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${admin}, ${off}, true), (${admin}, ${noUsers}, true)
      on conflict (workspace_id, login_id) do nothing`);
    expect(await tick(admin, off)).toBe(true);
    expect(await tick(admin, noUsers)).toBe(true);
    await x(sql`update auth.users set disabled_at = now() where id = ${off}`);
    await x(sql`update workspace_users set limits = '{"areas":{"users":false}}'::jsonb
      where workspace_id = ${admin} and login_id = ${noUsers}`);
    const [ws] = await x<{ id: string }>(sql`insert into workspaces (owner_id, name)
      values (${owner}, 'Crew') returning id::text as id`);
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator, added_at) values
      (${ws!.id}, ${mem3}, true, now() - interval '3 days'),
      (${ws!.id}, ${off}, true, now() - interval '2 days'),
      (${ws!.id}, ${noUsers}, true, now() - interval '1 day')`);
    // Neither counts as the Admin Moderator that would let the clear take
    // every member tick: the member added first keeps it.
    expect(await t.clearMemberTicks(ws!.id, false)).toEqual({
      ok: true,
      applied: false,
      moderators: 3,
      adminModerators: 0,
      cleared: 2,
      keptForLastModerator: 1,
    });
    await t.clearMemberTicks(ws!.id, true);
    expect(await tick(ws!.id, mem3)).toBe(true);
    expect(await tick(ws!.id, off)).toBe(false);
    expect(await tick(ws!.id, noUsers)).toBe(false);
  });
});
