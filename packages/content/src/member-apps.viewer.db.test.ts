/**
 * Apps for members on a real, migrated Postgres (member logins Phase 4b, plan
 * v3.1 section 4a): a member may run an app at team level or lower with a
 * green PUBLISHED build, never an admin app, a draft-only app, a red build or
 * another brain's app (the rule is in the query, so the admin pool proves
 * it); the lookups work on the team role (no draft column is read); the home
 * app is honoured only while a member may run it; the access log names the
 * member login.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/member-apps.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('apps for members', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let ma: typeof import('./member-apps');
  let log: typeof import('./app-access-log');
  let lib: typeof import('./member-library');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `mapps-${randomUUID().slice(0, 8)}`;
  // Brains of this test's own. Not mantle_brain_id(): test files run in
  // parallel, and another file may create and delete the shared anchor.
  const anchor = randomUUID();
  const other = randomUUID();
  const member = randomUUID();
  const ids = {
    team: randomUUID(),
    pub: randomUUID(),
    admin: randomUUID(),
    draftOnly: randomUUID(),
    red: randomUUID(),
    otherBrain: randomUUID(),
  };
  const green = JSON.stringify({
    storageKey: 'apps/x.js',
    sha256: 'x',
    builtAt: '2026-09-27T00:00:00Z',
    esbuildVersion: '0',
    bytes: 1,
    ok: true,
  });
  const red = JSON.stringify({ ...JSON.parse(green), ok: false });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    // ONE key for every viewer DB test: roles are cluster-wide (28P01).
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ma = await import('./member-apps');
    log = await import('./app-access-log');
    lib = await import('./member-library');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);

    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${anchor}, ${`${tag}-admin@example.invalid`}, 'x', 'admin', null),
        (${other}, ${`${tag}-other@example.invalid`}, 'x', 'admin', null),
        (${member}, ${`${tag}-pat@example.invalid`}, 'x', 'member', 'Pat Member')`);
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values
        (${anchor}, 'brain', ${anchor}), (${other}, 'brain', ${other})`);
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${ids.team}, ${anchor}, 'app', ${`${tag} b team`}, 'apps', 'team'),
        (${ids.pub}, ${anchor}, 'app', ${`${tag} a public`}, 'apps', 'public'),
        (${ids.admin}, ${anchor}, 'app', ${`${tag} admin`}, 'apps', 'admin'),
        (${ids.draftOnly}, ${anchor}, 'app', ${`${tag} draft only`}, 'apps', 'team'),
        (${ids.red}, ${anchor}, 'app', ${`${tag} red`}, 'apps', 'team'),
        (${ids.otherBrain}, ${other}, 'app', ${`${tag} other`}, 'apps', 'team')`);
    const manifest = JSON.stringify({ toolSlugs: ['note_list'], description: 'Polls' });
    await m.systemDb.execute(sqlTag`
      insert into apps (node_id, manifest, published_build, draft_build, draft_source) values
        (${ids.team}, ${manifest}::jsonb, ${green}::jsonb, ${green}::jsonb, '{"entry":"App.tsx","files":{}}'::jsonb),
        (${ids.pub}, '{}'::jsonb, ${green}::jsonb, null, null),
        (${ids.admin}, '{}'::jsonb, ${green}::jsonb, null, null),
        (${ids.draftOnly}, '{}'::jsonb, null, ${green}::jsonb, '{"entry":"App.tsx","files":{}}'::jsonb),
        (${ids.red}, '{}'::jsonb, ${red}::jsonb, null, null),
        (${ids.otherBrain}, '{}'::jsonb, ${green}::jsonb, null, null)`);
  }, 60_000);

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id in (${anchor}, ${other})`);
    await m.systemDb.execute(
      sqlTag`delete from spaces where login_id in (${anchor}, ${other}, ${member})`,
    );
    await m.systemDb.execute(
      sqlTag`delete from auth.users where id in (${anchor}, ${other}, ${member})`,
    );
    await m.closeDb();
  }, 60_000);

  const team = <T>(fn: () => Promise<T>) => m.withViewer('team', fn);

  // The rule is written in the query, so the admin pool proves it. The team
  // role adds row security keyed on the box's one brain (mantle_brain_id()),
  // which this test's own brain is not: see the team-role case below.
  it('lists team-level and lower apps with a green published build, by title', async () => {
    const apps = await ma.listMemberApps(anchor);
    expect(apps.map((a) => a.id)).toEqual([ids.pub, ids.team]);
    expect(apps.find((a) => a.id === ids.team)).toMatchObject({
      description: 'Polls',
      audience: 'team',
    });
  });

  it('never opens an admin app, a draft-only app, a red build or another brain', async () => {
    for (const id of [ids.admin, ids.draftOnly, ids.red, ids.otherBrain]) {
      expect(await ma.getMemberRunnableApp(anchor, id), id).toBeNull();
    }
  });

  it('opens a runnable app with its PUBLISHED build and manifest, never a draft', async () => {
    const app = await ma.getMemberRunnableApp(anchor, ids.team);
    expect(app).toMatchObject({ id: ids.team, manifest: { toolSlugs: ['note_list'] } });
    expect(app?.publishedBuild.ok).toBe(true);
    expect(Object.keys(app ?? {})).not.toContain('draftBuild');
  });

  it('runs on the team role: only granted columns, and row security still applies', async () => {
    // A draft column (never granted) would be "permission denied" here. Row
    // security then hides a brain that is not this box's: nothing leaks.
    expect(await team(() => ma.listMemberApps(anchor))).toEqual([]);
    expect(await team(() => ma.getMemberRunnableApp(anchor, ids.team))).toBeNull();
    expect(await team(() => ma.resolveMemberHomeApp(anchor, ids.team))).toBeNull();
    expect(await team(() => lib.libraryCounts(anchor))).toEqual({
      page: 0,
      note: 0,
      draw: 0,
      table: 0,
      file: 0,
    });
    await expect(lib.libraryCounts(anchor)).rejects.toThrow(/withViewer/);
  });

  it('gives team chat the data of team-level apps only', async () => {
    const reach = await ma.listTeamLevelAppIds(anchor);
    expect(reach.has(ids.team)).toBe(true);
    expect(reach.has(ids.draftOnly)).toBe(true);
    expect(reach.has(ids.admin)).toBe(false);
    expect(reach.has(ids.otherBrain)).toBe(false);
  });

  it('honours the pinned home app only while a member may run it', async () => {
    expect(await ma.resolveMemberHomeApp(anchor, ids.team)).toEqual({
      appId: ids.team,
      title: `${tag} b team`,
      icon: null,
      color: null,
    });
    expect(await ma.resolveMemberHomeApp(anchor, ids.admin)).toBeNull();
    expect(await ma.resolveMemberHomeApp(anchor, ids.draftOnly)).toBeNull();
    expect(await ma.resolveMemberHomeApp(anchor, undefined)).toBeNull();
  });

  it('logs a member run by login and names the login to the admin', async () => {
    log.recordAppAccess({
      ownerId: anchor,
      appNodeId: ids.team,
      actorId: member,
      kind: 'db',
      detail: { op: 'exec' },
    });
    let rows: Awaited<ReturnType<typeof log.listAppAccess>> = [];
    for (let i = 0; i < 250 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      rows = await log.listAppAccess(anchor, ids.team);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: member,
      contactId: null,
      contactName: 'Pat Member',
      kind: 'db',
    });
  });

  it('names a login without a display name by its email, and a deleted one as removed', async () => {
    const plain = randomUUID();
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name)
      values (${plain}, ${`${tag}-sam@example.invalid`}, 'x', 'member', '  ')`);
    log.recordAppAccess({
      ownerId: anchor,
      appNodeId: ids.pub,
      actorId: plain,
      kind: 'tool',
      detail: { via: 'member', slug: 'note_list' },
    });
    let rows: Awaited<ReturnType<typeof log.listAppAccess>> = [];
    for (let i = 0; i < 250 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      rows = await log.listAppAccess(anchor, ids.pub);
    }
    expect(rows[0]).toMatchObject({ actorId: plain, contactName: `${tag}-sam` });
    await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${plain}`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id = ${plain}`);
    const [after] = await log.listAppAccess(anchor, ids.pub);
    expect(after).toMatchObject({ actorId: null, contactId: null, contactName: 'Removed member' });
  });
});
