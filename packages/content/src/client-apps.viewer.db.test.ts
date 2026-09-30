/**
 * Apps for clients on a real, migrated Postgres (client logins C6,
 * docs/client-logins.md section 10). The fixture is FOUR published apps
 * identical but for the level (client, team, admin, public), so only the
 * level rule tells them apart: a client runs the client one and none of the
 * others. Also: never a draft-only app, a red build or another brain's app;
 * the lookups work on the client role (no draft column is read) and row
 * security holds there as a second lock; the informational flag reaches the
 * client card, the member card and the owner's DTOs, and only the owner's
 * update writes it; the access log names a client login.
 *
 * Brain items belong to the shared test anchor (mantle_brain_id()): the
 * client-role reads go through row security, which knows only that brain.
 * Removes its rows after (the anchor stays).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/client-apps.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('apps for clients', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let ca: typeof import('./client-apps');
  let ma: typeof import('./member-apps');
  let ap: typeof import('./apps');
  let log: typeof import('./app-access-log');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `capps-${randomUUID().slice(0, 8)}`;
  let brain = '';
  const other = randomUUID();
  const clientLogin = randomUUID();
  const ids = {
    client: randomUUID(),
    team: randomUUID(),
    admin: randomUUID(),
    pub: randomUUID(),
    info: randomUUID(),
    draftOnly: randomUUID(),
    red: randomUUID(),
    otherBrain: randomUUID(),
  };
  const ours = new Set<string>(Object.values(ids));
  const green = JSON.stringify({
    storageKey: 'apps/x.js',
    sha256: 'x',
    builtAt: '2026-09-30T00:00:00Z',
    esbuildVersion: '0',
    bytes: 1,
    ok: true,
  });
  const red = JSON.stringify({ ...JSON.parse(green), ok: false });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ca = await import('./client-apps');
    ma = await import('./member-apps');
    ap = await import('./apps');
    log = await import('./app-access-log');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    brain = await ensureTestAnchor(admin);

    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${other}, ${`${tag}-other@example.invalid`}, 'x', 'admin', null),
        (${clientLogin}, ${`${tag}-casey@example.invalid`}, 'x', 'client', 'Casey Client')`);
    await m.systemDb.execute(
      sqlTag`insert into spaces (id, kind, login_id) values (${other}, 'brain', ${other})`,
    );
    // Same title and data for the four level twins: only the level differs.
    const title = `${tag} orders`;
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience, data) values
        (${ids.client}, ${brain}, 'app', ${title}, 'apps', 'client', '{"icon":"📦"}'::jsonb),
        (${ids.team}, ${brain}, 'app', ${title}, 'apps', 'team', '{"icon":"📦"}'::jsonb),
        (${ids.admin}, ${brain}, 'app', ${title}, 'apps', 'admin', '{"icon":"📦"}'::jsonb),
        (${ids.pub}, ${brain}, 'app', ${title}, 'apps', 'public', '{"icon":"📦"}'::jsonb),
        (${ids.info}, ${brain}, 'app', ${`${tag} prices`}, 'apps', 'client', '{}'::jsonb),
        (${ids.draftOnly}, ${brain}, 'app', ${`${tag} draft`}, 'apps', 'client', '{}'::jsonb),
        (${ids.red}, ${brain}, 'app', ${`${tag} red`}, 'apps', 'client', '{}'::jsonb),
        (${ids.otherBrain}, ${other}, 'app', ${title}, 'apps', 'client', '{}'::jsonb)`);
    const manifest = JSON.stringify({ toolSlugs: ['client_shared_list'], description: 'Orders' });
    const src = '{"entry":"App.tsx","files":{}}';
    await m.systemDb.execute(sqlTag`
      insert into apps (node_id, manifest, published_build, draft_build, draft_source, data_read_only) values
        (${ids.client}, ${manifest}::jsonb, ${green}::jsonb, ${green}::jsonb, ${src}::jsonb, false),
        (${ids.team}, ${manifest}::jsonb, ${green}::jsonb, ${green}::jsonb, ${src}::jsonb, false),
        (${ids.admin}, ${manifest}::jsonb, ${green}::jsonb, ${green}::jsonb, ${src}::jsonb, false),
        (${ids.pub}, ${manifest}::jsonb, ${green}::jsonb, ${green}::jsonb, ${src}::jsonb, false),
        (${ids.info}, '{}'::jsonb, ${green}::jsonb, null, null, true),
        (${ids.draftOnly}, '{}'::jsonb, null, ${green}::jsonb, ${src}::jsonb, false),
        (${ids.red}, '{}'::jsonb, ${red}::jsonb, null, null, false),
        (${ids.otherBrain}, ${manifest}::jsonb, ${green}::jsonb, null, null, false)`);
  }, 60_000);

  afterAll(async () => {
    await m.systemDb.execute(
      sqlTag`delete from nodes where owner_id = ${brain} and title like ${`${tag} %`}`,
    );
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${other}`);
    await m.systemDb.execute(sqlTag`delete from spaces where login_id in (${other}, ${clientLogin})`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id in (${other}, ${clientLogin})`);
    await m.closeDb();
  }, 60_000);

  const asClient = <T>(fn: () => Promise<T>) => m.withViewer('client', fn);
  const mine = <T extends { id: string }>(rows: T[]) => rows.filter((r) => ours.has(r.id));

  it('lists the client-level apps with a green published build, and no level twin', async () => {
    for (const run of [<T>(fn: () => Promise<T>) => fn(), asClient]) {
      const apps = mine(await run(() => ca.listClientApps(brain)));
      expect(apps.map((a) => a.id).sort()).toEqual([ids.client, ids.info].sort());
      expect(apps.find((a) => a.id === ids.client)).toEqual({
        id: ids.client,
        title: `${tag} orders`,
        icon: '📦',
        color: null,
        description: 'Orders',
        updatedAt: expect.any(String),
        dataReadOnly: false,
      });
      expect(apps.find((a) => a.id === ids.info)?.dataReadOnly).toBe(true);
    }
  });

  it('opens the client app, never its team, admin or public twin', async () => {
    for (const run of [<T>(fn: () => Promise<T>) => fn(), asClient]) {
      const app = await run(() => ca.getClientRunnableApp(brain, ids.client));
      expect(app).toMatchObject({ id: ids.client, manifest: { toolSlugs: ['client_shared_list'] } });
      expect(app?.publishedBuild.ok).toBe(true);
      expect(Object.keys(app ?? {})).not.toContain('draftBuild');
      for (const id of [ids.team, ids.admin, ids.pub]) {
        expect(await run(() => ca.getClientRunnableApp(brain, id)), id).toBeNull();
      }
    }
  });

  it('never opens a draft-only app, a red build or another brain', async () => {
    for (const id of [ids.draftOnly, ids.red, ids.otherBrain]) {
      expect(await ca.getClientRunnableApp(brain, id), id).toBeNull();
      expect(await asClient(() => ca.getClientRunnableApp(brain, id)), id).toBeNull();
    }
  });

  it('row security on the client role is a second lock: another brain reads nothing', async () => {
    // The query keeps to this brain; on the client role row security also
    // hides a brain that is not the box's one brain.
    expect(await asClient(() => ca.getClientRunnableApp(other, ids.otherBrain))).toBeNull();
    expect(await asClient(() => ca.listClientApps(other))).toEqual([]);
    expect((await ca.listClientApps(other)).map((a) => a.id)).toEqual([ids.otherBrain]);
  });

  it('reports the informational flag to members: read only on a public or informational app', async () => {
    const cards = mine(await ma.listMemberApps(brain));
    const flag = Object.fromEntries(cards.map((c) => [c.id, c.dataReadOnly]));
    expect(flag).toEqual({
      [ids.client]: false,
      [ids.team]: false,
      [ids.pub]: true,
      [ids.info]: true,
    });
    const info = await ma.getMemberRunnableApp(brain, ids.info);
    expect(info?.dataReadOnly).toBe(true);
    expect(ma.memberMayWriteAppData(info!)).toBe(false);
    for (const id of [ids.client, ids.team]) {
      expect(ma.memberMayWriteAppData((await ma.getMemberRunnableApp(brain, id))!), id).toBe(true);
    }
    expect(ma.memberMayWriteAppData((await ma.getMemberRunnableApp(brain, ids.pub))!)).toBe(false);
  });

  it("the owner's update sets the flag, and the owner's DTOs show it", async () => {
    expect((await ap.getApp(brain, ids.client))?.dataReadOnly).toBe(false);
    const updated = await ap.updateAppMeta(brain, ids.client, { dataReadOnly: true });
    try {
      expect(updated?.dataReadOnly).toBe(true);
      const row = (await ap.listApps(brain, { query: tag })).find((a) => a.id === ids.client);
      expect(row?.dataReadOnly).toBe(true);
      expect((await ca.getClientRunnableApp(brain, ids.client))?.dataReadOnly).toBe(true);
      // A metadata update that does not name the flag leaves it.
      expect((await ap.updateAppMeta(brain, ids.client, { icon: '🧾' }))?.dataReadOnly).toBe(
        true,
      );
    } finally {
      await ap.updateAppMeta(brain, ids.client, { dataReadOnly: false, icon: '📦' });
    }
    expect((await ap.getApp(brain, ids.client))?.dataReadOnly).toBe(false);
  });

  it('logs a client run by login and names the client', async () => {
    log.recordAppAccess({
      ownerId: brain,
      appNodeId: ids.client,
      actorId: clientLogin,
      kind: 'db',
      detail: { via: 'client', op: 'exec' },
    });
    let rows: Awaited<ReturnType<typeof log.listAppAccess>> = [];
    for (let i = 0; i < 250 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      rows = await log.listAppAccess(brain, ids.client);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: clientLogin,
      contactName: 'Casey Client',
      kind: 'db',
      detail: { via: 'client', op: 'exec' },
    });
  });
});
