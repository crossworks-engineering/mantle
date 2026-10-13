/**
 * Apps for members on a real, migrated Postgres (member logins Phase 4b;
 * workspaces W5b2): a member runs an app a workspace of theirs holds (its
 * grant) with a green PUBLISHED build, and writes its data only where that
 * grant has Write on. Never an app only Admin holds, a draft-only app, a red
 * build, another brain's app, or an app that only has a public link; the
 * levels mean nothing. The workspaces of the member: a workspace scope's own,
 * else the brain's Team (the rule is in the query, so the admin pool proves
 * it). The lookups work on the workspace role (no draft column is read); the home
 * app is honoured only while a member may run it; the access log names the
 * member login; an app's tool rules come from its holders (R2).
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
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `mapps-${randomUUID().slice(0, 8)}`;
  // Brains of this test's own. Not mantle_brain_id(): test files run in
  // parallel, and another file may create and delete the shared anchor.
  const anchor = randomUUID();
  const other = randomUUID();
  const member = randomUUID();
  const ws = {
    admin: randomUUID(),
    team: randomUUID(),
    field: randomUUID(),
    otherTeam: randomUUID(),
    own: randomUUID(),
  };
  const ids = {
    teamRw: randomUUID(),
    teamRo: randomUUID(),
    field: randomUUID(),
    admin: randomUUID(),
    draftOnly: randomUUID(),
    red: randomUUID(),
    linkOnly: randomUUID(),
    levelOnly: randomUUID(),
    otherBrain: randomUUID(),
    ownApp: randomUUID(),
    ownInfo: randomUUID(),
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

  /** Grant `node` to `wsId` (Write as given), the first grant as its home. */
  const grant = (node: string, wsId: string, write = false, home = false) =>
    m.withHeads([node], 'update', (tx) =>
      tx.execute(sqlTag`insert into item_grants (node_id, workspace_id, write, is_home)
        values (${node}, ${wsId}, ${write}, ${home})`),
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    // ONE key for every viewer DB test: roles are cluster-wide (28P01).
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ma = await import('./member-apps');
    log = await import('./app-access-log');
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
      insert into workspaces (id, owner_id, name, is_admin, bridge_key) values
        (${ws.admin}, ${anchor}, ${`${tag} Admin`}, true, 'admin'),
        (${ws.team}, ${anchor}, ${`${tag} Team`}, false, null),
        (${ws.field}, ${anchor}, ${`${tag} Field`}, false, null),
        (${ws.otherTeam}, ${other}, ${`${tag} Other team`}, false, null),
        (${ws.own}, ${anchor}, ${`${tag} Own`}, false, null)`);
    // The levels mean nothing now: every app carries 'team', none is read
    // by it.
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${ids.teamRw}, ${anchor}, 'app', ${`${tag} b team`}, 'apps', 'team'),
        (${ids.teamRo}, ${anchor}, 'app', ${`${tag} a team informational`}, 'apps', 'team'),
        (${ids.field}, ${anchor}, 'app', ${`${tag} field`}, 'apps', 'team'),
        (${ids.admin}, ${anchor}, 'app', ${`${tag} admin`}, 'apps', 'team'),
        (${ids.draftOnly}, ${anchor}, 'app', ${`${tag} draft only`}, 'apps', 'team'),
        (${ids.red}, ${anchor}, 'app', ${`${tag} red`}, 'apps', 'team'),
        (${ids.linkOnly}, ${anchor}, 'app', ${`${tag} link only`}, 'apps', 'public'),
        (${ids.levelOnly}, ${anchor}, 'app', ${`${tag} level only`}, 'apps', 'team'),
        (${ids.otherBrain}, ${other}, 'app', ${`${tag} other`}, 'apps', 'team'),
        (${ids.ownApp}, ${anchor}, 'app', ${`${tag} own`}, 'apps', 'team'),
        (${ids.ownInfo}, ${anchor}, 'app', ${`${tag} own informational`}, 'apps', 'team')`);
    const manifest = JSON.stringify({ toolSlugs: ['note_list'], description: 'Polls' });
    await m.systemDb.execute(sqlTag`
      insert into apps (node_id, manifest, published_build, draft_build, draft_source) values
        (${ids.teamRw}, ${manifest}::jsonb, ${green}::jsonb, ${green}::jsonb, '{"entry":"App.tsx","files":{}}'::jsonb),
        (${ids.teamRo}, '{}'::jsonb, ${green}::jsonb, null, null),
        (${ids.field}, '{}'::jsonb, ${green}::jsonb, null, null),
        (${ids.admin}, '{}'::jsonb, ${green}::jsonb, null, null),
        (${ids.draftOnly}, '{}'::jsonb, null, ${green}::jsonb, '{"entry":"App.tsx","files":{}}'::jsonb),
        (${ids.red}, '{}'::jsonb, ${red}::jsonb, null, null),
        (${ids.linkOnly}, '{}'::jsonb, ${green}::jsonb, null, null),
        (${ids.levelOnly}, '{}'::jsonb, ${green}::jsonb, null, null),
        (${ids.otherBrain}, '{}'::jsonb, ${green}::jsonb, null, null),
        (${ids.ownApp}, '{}'::jsonb, ${green}::jsonb, null, null),
        (${ids.ownInfo}, '{}'::jsonb, ${green}::jsonb, null, null)`);
    await m.systemDb.execute(
      sqlTag`update apps set data_read_only = true where node_id = ${ids.ownInfo}`,
    );
    for (const id of Object.values(ids)) {
      if (id === ids.otherBrain || id === ids.levelOnly) continue;
      if (id === ids.ownApp || id === ids.ownInfo) continue;
      await grant(id, ws.admin, false, true);
    }
    await grant(ids.teamRw, ws.team, true);
    await grant(ids.teamRo, ws.team, false);
    await grant(ids.field, ws.field, true);
    await grant(ids.draftOnly, ws.team, true);
    await grant(ids.red, ws.team, true);
    await grant(ids.otherBrain, ws.otherTeam, true, true);
    // Homed in Own, with no grant that has Write on: its Moderator edits it.
    await grant(ids.ownApp, ws.own, false, true);
    await grant(ids.ownInfo, ws.own, false, true);
    await m.systemDb.execute(sqlTag`
      insert into shares (owner_id, node_id, node_type, token)
      values (${anchor}, ${ids.linkOnly}, 'app', ${`${tag}-${randomUUID()}`})`);
  }, 60_000);

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`delete from shares where owner_id = ${anchor}`);
    await m.systemDb.execute(sqlTag`
      delete from item_grants where node_id in (select id from nodes where owner_id in (${anchor}, ${other}))`);
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id in (${anchor}, ${other})`);
    await m.systemDb.execute(
      sqlTag`delete from workspaces where owner_id in (${anchor}, ${other})`,
    );
    await m.systemDb.execute(
      sqlTag`delete from spaces where login_id in (${anchor}, ${other}, ${member})`,
    );
    await m.systemDb.execute(
      sqlTag`delete from auth.users where id in (${anchor}, ${other}, ${member})`,
    );
    await m.closeDb();
  }, 60_000);

  const inField = <T>(fn: () => Promise<T>) =>
    m.withScope({ kind: 'user', loginId: member, ws: [ws.field], modWs: [] }, fn);
  // The member in Team (a user, no Moderator): every member path holds the
  // login's scope. With none, nothing is reached (0286; it was the built-in
  // Team workspace until then).
  const inTeam = <T>(fn: () => Promise<T>) =>
    m.withScope({ kind: 'user', loginId: member, ws: [ws.team], modWs: [] }, fn);

  it('with no workspace scope a member path reaches nothing (0286: no Team fallback)', async () => {
    expect(await ma.listMemberApps(anchor)).toEqual([]);
    expect(await ma.getMemberRunnableApp(anchor, ids.teamRw)).toBeNull();
    expect([...(await ma.listTeamLevelAppIds(anchor))]).toEqual([]);
  });

  it('lists the apps Team holds with a green published build, by title', async () => {
    const apps = await inTeam(() => ma.listMemberApps(anchor));
    expect(apps.map((a) => a.id)).toEqual([ids.teamRo, ids.teamRw]);
    // No level on the card since W5c.
    expect(apps.find((a) => a.id === ids.teamRw)).not.toHaveProperty('audience');
    expect(apps.find((a) => a.id === ids.teamRw)).toMatchObject({
      description: 'Polls',
      // The R and R/W pill: the grant's Write switch.
      dataReadOnly: false,
      dataAccess: 'read_write',
    });
    expect(apps.find((a) => a.id === ids.teamRo)).toMatchObject({
      dataReadOnly: true,
      dataAccess: 'read',
    });
  });

  it('writes the data only where the grant has Write on', async () => {
    const rw = await inTeam(() => ma.getMemberRunnableApp(anchor, ids.teamRw));
    const ro = await inTeam(() => ma.getMemberRunnableApp(anchor, ids.teamRo));
    expect(rw).toMatchObject({ writable: true });
    expect(ro).toMatchObject({ writable: false });
    expect(ma.memberMayWriteAppData(rw!)).toBe(true);
    expect(ma.memberMayWriteAppData(ro!)).toBe(false);
  });

  it('a Moderator of the app’s home writes its data, unless it is Informational (audit 2026-10-12)', async () => {
    const asMod = <T>(fn: () => Promise<T>) =>
      m.withScope({ kind: 'user', loginId: member, ws: [ws.own], modWs: [ws.own] }, fn);
    const asUser = <T>(fn: () => Promise<T>) =>
      m.withScope({ kind: 'user', loginId: member, ws: [ws.own], modWs: [] }, fn);
    // The docs' rule: a user writes app data when they may edit the app (a
    // Moderator of its home, or a grant with Write on).
    expect(await asMod(() => ma.getMemberRunnableApp(anchor, ids.ownApp))).toMatchObject({
      writable: true,
    });
    const card = (await asMod(() => ma.listMemberApps(anchor))).find((a) => a.id === ids.ownApp);
    expect(card).toMatchObject({ dataReadOnly: false, dataAccess: 'read_write' });
    // Informational stays an AND: not even the home's Moderator writes.
    expect(await asMod(() => ma.getMemberRunnableApp(anchor, ids.ownInfo))).toMatchObject({
      writable: false,
    });
    // A user of the home who is not its Moderator, with no Write grant, reads.
    expect(await asUser(() => ma.getMemberRunnableApp(anchor, ids.ownApp))).toMatchObject({
      writable: false,
    });
  });

  it('never opens an Admin-only app, a draft-only app, a red build, another brain, a link or a level', async () => {
    for (const id of [
      ids.admin,
      ids.draftOnly,
      ids.red,
      ids.otherBrain,
      ids.linkOnly,
      ids.levelOnly,
      // Another workspace than Team: not the member's outside its scope.
      ids.field,
    ]) {
      expect(await inTeam(() => ma.getMemberRunnableApp(anchor, id)), id).toBeNull();
    }
    const listed = (await inTeam(() => ma.listMemberAppsPlaced(anchor))).places.map((p) => p.id);
    expect(listed).not.toContain(ids.linkOnly);
    expect(listed).not.toContain(ids.levelOnly);
  });

  it('opens a runnable app with its PUBLISHED build and manifest, never a draft', async () => {
    const app = await inTeam(() => ma.getMemberRunnableApp(anchor, ids.teamRw));
    expect(app).toMatchObject({ id: ids.teamRw, manifest: { toolSlugs: ['note_list'] } });
    expect(app?.publishedBuild.ok).toBe(true);
    expect(Object.keys(app ?? {})).not.toContain('draftBuild');
  });

  it('in a workspace scope: the apps the scope holds, on the workspace role (only granted columns)', async () => {
    const apps = await inField(() => ma.listMemberApps(anchor));
    expect(apps.map((a) => a.id)).toEqual([ids.field]);
    expect(apps[0]).toMatchObject({ dataAccess: 'read_write' });
    expect(await inField(() => ma.getMemberRunnableApp(anchor, ids.field))).toMatchObject({
      writable: true,
    });
    expect(await inField(() => ma.getMemberRunnableApp(anchor, ids.teamRw))).toBeNull();
    expect([...(await inField(() => ma.listTeamLevelAppIds(anchor)))]).toEqual([ids.field]);
  });

  it('gives team chat the data of the apps Team holds only (published or not)', async () => {
    const reach = await inTeam(() => ma.listTeamLevelAppIds(anchor));
    expect(reach.has(ids.teamRw)).toBe(true);
    expect(reach.has(ids.draftOnly)).toBe(true);
    expect(reach.has(ids.admin)).toBe(false);
    expect(reach.has(ids.field)).toBe(false);
    expect(reach.has(ids.levelOnly)).toBe(false);
    expect(reach.has(ids.otherBrain)).toBe(false);
  });

  it('an embed never opens an app: its grants do not follow one', async () => {
    const page = randomUUID();
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience)
      values (${page}, ${anchor}, 'page', ${`${tag} page`}, 'pages', 'team')`);
    try {
      await grant(page, ws.team, true, true);
      await m.systemDb.execute(sqlTag`
        insert into node_embeds (from_id, to_id) values (${page}, ${ids.admin})`);
      expect((await inTeam(() => ma.listTeamLevelAppIds(anchor))).has(ids.admin)).toBe(false);
    } finally {
      await m.systemDb.execute(sqlTag`delete from node_embeds where from_id = ${page}`);
      await m.systemDb.execute(sqlTag`delete from item_grants where node_id = ${page}`);
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${page}`);
    }
  });

  it('honours the pinned home app only while a member may run it', async () => {
    expect(await inTeam(() => ma.resolveMemberHomeApp(anchor, ids.teamRw))).toEqual({
      appId: ids.teamRw,
      title: `${tag} b team`,
      icon: null,
      color: null,
    });
    expect(await inTeam(() => ma.resolveMemberHomeApp(anchor, ids.admin))).toBeNull();
    expect(await inTeam(() => ma.resolveMemberHomeApp(anchor, ids.draftOnly))).toBeNull();
    expect(await inTeam(() => ma.resolveMemberHomeApp(anchor, undefined))).toBeNull();
  });

  // Plan R2: an app reads only what every holder reads.
  it("an app's tool rules come from its holders, never a level", async () => {
    const apps = await import('./apps');
    const rules = async (id: string) => (await apps.getAppRuntime(anchor, id))?.toolRules;
    expect(await rules(ids.admin)).toBe('admin');
    expect(await rules(ids.linkOnly)).toBe('admin');
    expect(await rules(ids.levelOnly)).toBe('admin');
    expect(await rules(ids.teamRw)).toBe('team');
    expect(await rules(ids.field)).toBe('team');
  });

  it('logs a member run by login and names the login to the admin', async () => {
    log.recordAppAccess({
      ownerId: anchor,
      appNodeId: ids.teamRw,
      actorId: member,
      kind: 'db',
      detail: { op: 'exec' },
    });
    let rows: Awaited<ReturnType<typeof log.listAppAccess>> = [];
    for (let i = 0; i < 250 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      rows = await log.listAppAccess(anchor, ids.teamRw);
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
      appNodeId: ids.teamRo,
      actorId: plain,
      kind: 'tool',
      detail: { via: 'member', slug: 'note_list' },
    });
    let rows: Awaited<ReturnType<typeof log.listAppAccess>> = [];
    for (let i = 0; i < 250 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      rows = await log.listAppAccess(anchor, ids.teamRo);
    }
    expect(rows[0]).toMatchObject({ actorId: plain, contactName: `${tag}-sam` });
    await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${plain}`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id = ${plain}`);
    const [after] = await log.listAppAccess(anchor, ids.teamRo);
    expect(after).toMatchObject({ actorId: null, contactId: null, contactName: 'Removed member' });
  });
});
