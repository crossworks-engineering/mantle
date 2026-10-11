/**
 * Member-built apps on Postgres (team apps Phase 3, migration 0235): a
 * member's app lives in their personal space at the team author ceiling;
 * a draft is private (a teammate neither lists nor runs it); sharing with
 * the team lets teammates run the published version; submit freezes it;
 * the author restores from its history. An admin's review (accept, send
 * back, test runs, the review lists) was removed in workspaces W5c.
 * Seeds its own brain and logins on random ids; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/member-space-apps.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('member-built apps on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let apps: typeof import('./apps');
  let broker: typeof import('./app-broker');
  let snaps: typeof import('./app-snapshots');
  let sa: typeof import('./member-space-apps');
  let ma: typeof import('./member-apps');
  let dir = '';
  const brain = randomUUID();
  const author = randomUUID();
  const mate = randomUUID();
  const tag = brain.slice(0, 8);
  let authorSpace = '';
  let mateSpace = '';
  const GREEN = {
    storageKey: 'attachments/aa/bb/test',
    sha256: 'test',
    builtAt: '2026-10-08T00:00:00.000Z',
    esbuildVersion: 'test',
    bytes: 1,
    ok: true,
  };
  const schema = {
    schemaSql: 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT);',
    schemaVersion: 1,
  };
  const me = () => ({ loginId: author, spaceId: authorSpace });
  /** A member-era app in the brain, as an Accept before W5c left it: the
   *  node, its database and its history re-owned to the brain. */
  const intoBrain = async (id: string) => {
    await m.asSystem(() => apps.ensureAppsRoot(brain));
    await admin`update nodes set owner_id = ${brain}, path = 'apps' where id = ${id}`;
    await admin`update app_databases set owner_id = ${brain} where app_node_id = ${id}`;
    await admin`update node_snapshots set owner_id = ${brain} where node_id = ${id}`;
    await admin`update space_items set review_state = 'accepted' where node_id = ${id}`;
  };
  const them = () => ({ loginId: mate, spaceId: mateSpace });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    dir = await mkdtemp(path.join(tmpdir(), 'member-space-apps-db-'));
    process.env.APP_DB_DIR = dir;
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    apps = await import('./apps');
    broker = await import('./app-broker');
    snaps = await import('./app-snapshots');
    sa = await import('./member-space-apps');
    ma = await import('./member-apps');
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${brain}, ${`msa-${tag}-o@example.invalid`}, 'x', 'admin'),
      (${author}, ${`msa-${tag}-a@example.invalid`}, 'x', 'member'),
      (${mate}, ${`msa-${tag}-b@example.invalid`}, 'x', 'member')`;
    await admin`insert into spaces (id, kind, login_id) values (${brain}, 'brain', ${brain})`;
    const rows = await admin<{ id: string; login_id: string }[]>`
      select id, login_id from spaces where kind = 'personal' and login_id in (${author}, ${mate})`;
    authorSpace = rows.find((r) => r.login_id === author)!.id;
    mateSpace = rows.find((r) => r.login_id === mate)!.id;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from nodes where owner_id in (${brain}, ${authorSpace}, ${mateSpace})`;
    await admin`delete from spaces where login_id in (${brain}, ${author}, ${mate})`;
    await admin`delete from auth.users where id in (${brain}, ${author}, ${mate})`;
    await m.closeDb();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** A member app with a green published build and one row of data. */
  async function publishedSpaceApp(title: string) {
    const app = await sa.createSpaceApp(me(), { title: `${tag} ${title}` });
    await m.asSystem(async () => {
      await apps.writeDraftFile(authorSpace, app.id, 'App.tsx', 'export default () => "one";');
      await apps.setManifest(authorSpace, app.id, { sqlite: schema });
      await apps.setDraftBuild(authorSpace, app.id, GREEN);
      await apps.publishApp(authorSpace, app.id, {
        note: 'first',
        actor: 'member',
        actorLoginId: author,
      });
      await broker.appDbExec(
        authorSpace,
        app.id,
        "INSERT INTO items (name) VALUES ('a')",
        [],
        schema,
      );
    });
    return app.id;
  }

  it('a new app is private, in the author space, at the team author ceiling', async () => {
    const app = await sa.createSpaceApp(me(), { title: `${tag} fresh` });
    const [row] = await admin<
      { owner_id: string; author_level: string; author_login_id: string; sharing: string }[]
    >`select n.owner_id, a.author_level, a.author_login_id, si.sharing
      from nodes n join apps a on a.node_id = n.id join space_items si on si.node_id = n.id
      where n.id = ${app.id}`;
    expect(row).toEqual({
      owner_id: authorSpace,
      author_level: 'team',
      author_login_id: author,
      sharing: 'private',
    });
    // Not runnable yet (no published build), and never by a teammate.
    expect(await sa.getRunnableSpaceApp(author, app.id)).toBeNull();
    expect((await sa.listSpaceApps(them())).map((a) => a.id)).not.toContain(app.id);
  });

  it('a private app runs for its author only; shared, teammates run it too', async () => {
    const id = await publishedSpaceApp('shared');
    expect(await sa.getRunnableSpaceApp(author, id)).toMatchObject({
      id,
      ownerId: authorSpace,
      mine: true,
      dataReadOnly: false,
    });
    expect(await sa.getRunnableSpaceApp(mate, id)).toBeNull();
    // The brain's own lookup never reaches a space app, private or shared
    // (its rule, written in the query; on the admin pool so row security
    // is not what hides it).
    expect(await m.asSystem(() => ma.getMemberRunnableApp(brain, id))).toBeNull();

    await sa.setSpaceAppSharing(me(), id, 'team');
    expect(await sa.getRunnableSpaceApp(mate, id)).toMatchObject({ id, mine: false });
    const card = (await sa.listSpaceApps(them())).find((a) => a.id === id);
    expect(card).toMatchObject({ mine: false, sharing: 'team', dataAccess: 'read_write' });
    // A teammate never changes it.
    await expect(sa.setSpaceAppSharing(them(), id, 'private')).rejects.toThrow(/No such app/);
    await expect(sa.submitSpaceApp(them(), id)).rejects.toThrow(/No such app/);
  });

  it('submit freezes it and reads its data only; recall thaws it', async () => {
    const id = await publishedSpaceApp('frozen');
    // Unpublished changes refuse: the admin reviews what runs.
    await m.asSystem(() =>
      apps.writeDraftFile(authorSpace, id, 'App.tsx', 'export default () => 2;'),
    );
    await expect(sa.submitSpaceApp(me(), id)).rejects.toMatchObject({ code: 'unpublished' });
    await m.asSystem(() => apps.discardDraft(authorSpace, id));

    await sa.submitSpaceApp(me(), id);
    await expect(sa.authorSpaceApp(me(), id, { write: true })).rejects.toMatchObject({
      code: 'frozen',
    });
    expect(await sa.getRunnableSpaceApp(author, id)).toMatchObject({ dataReadOnly: true });
    expect((await sa.listSpaceApps(me())).find((a) => a.id === id)?.dataAccess).toBe('read');

    await sa.recallSpaceApp(me(), id);
    expect(await sa.authorSpaceApp(me(), id, { write: true })).toMatchObject({
      reviewState: 'draft',
    });
  });

  // M3 audit, high 1: only the version the admin read can enter the brain.
  // M3 audit, medium 3: a change holds the state row; none starts after Submit.
  it('a change never runs on a submitted app', async () => {
    const id = await publishedSpaceApp('locked');
    await sa.submitSpaceApp(me(), id);
    let ran = false;
    await expect(
      sa.withAuthorWrite(me(), id, async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ code: 'frozen' });
    expect(ran).toBe(false);
    await sa.recallSpaceApp(me(), id);
    // The change runs on the lock's own connection (M3 re-audit, medium 1):
    // a NOWAIT lock of the same row succeeds there, where any other
    // connection would fail at once.
    const { sql: sqlTag } = await import('drizzle-orm');
    const same = await sa.withAuthorWrite(me(), id, async () =>
      m.db.execute(
        sqlTag`select 1 as one from space_items where node_id = ${id} for update nowait`,
      ),
    );
    expect((same as unknown as { one: number }[])[0]?.one).toBe(1);
    // Nor on a teammate's app.
    await expect(sa.withAuthorWrite(them(), id, async () => undefined)).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  // M3 audit, high 2: a copy, a member-era restore and an undelete keep the
  // ceiling; only the admin's own trust lifts it.
  it('the ceiling survives a copy, a restore of member code and an undelete', async () => {
    const pkg = await import('./app-package');
    const trash = await import('./app-trash');
    const id = await publishedSpaceApp('ceiling');
    await intoBrain(id);
    const level = async (appId: string) =>
      (await m.asSystem(() => apps.getAppRuntime(brain, appId)))?.authorLevel;

    const copy = await m.asSystem(() => pkg.duplicateApp(brain, id, { withData: false }));
    expect(await level(copy!.id)).toBe('team');

    // The admin trusts it, then restores the member's own code: back to team.
    expect(await m.asSystem(() => apps.setAppAuthorLevel(brain, id, 'admin'))).toBe(true);
    expect(await level(id)).toBe('admin');
    // Trusted, it still shows the switch (0236): the admin can undo it.
    expect((await m.asSystem(() => apps.getApp(brain, id)))?.authorCeilingSeen).toBe(true);
    const memberVersion = (await m.asSystem(() => snaps.listAppSnapshots(brain, id))).find(
      (e) => e.trigger === 'publish',
    );
    await m.asSystem(() =>
      snaps.restoreAppSnapshot(brain, id, memberVersion!.id, { mode: 'code', discardDraft: true }),
    );
    expect(await level(id)).toBe('team');

    // A trusted copy of a trusted app stays trusted; an admin's own app too.
    const own = await m.asSystem(() => apps.createApp(brain, { title: `${tag} own` }));
    expect(own.authorLevel).toBe('admin');
    expect((await m.asSystem(() => apps.getApp(brain, own.id)))?.authorCeilingSeen).toBe(false);
    const ownCopy = await m.asSystem(() => pkg.duplicateApp(brain, own.id, { withData: false }));
    expect(await level(ownCopy!.id)).toBe('admin');

    // Deleted and brought back: a member-era app comes back at team rules.
    await m.asSystem(() => apps.setAppAuthorLevel(brain, id, 'admin'));
    await m.asSystem(() => apps.deleteApp(brain, id, { actor: 'owner' }));
    await m.asSystem(() => trash.restoreDeletedApp(brain, id));
    expect(await level(id)).toBe('team');
  });

  // Team apps follow-up: a restore never lands on an app that moved (an
  // Accept moves it under the same history lock); its undo row still stays.
  it('a restore refuses an app that moved to another owner meanwhile', async () => {
    const id = await publishedSpaceApp('moved');
    const snap = await m.asSystem(() =>
      snaps.createAppSnapshot(authorSpace, id, { actor: 'member', actorLoginId: author }),
    );
    // The node moves; its history rows have not yet (the window an Accept
    // closes with the lock).
    await admin`update nodes set owner_id = ${brain} where id = ${id}`;
    try {
      await expect(
        m.asSystem(() =>
          snaps.restoreAppSnapshot(authorSpace, id, snap!.id, { mode: 'data', drainMs: 0 }),
        ),
      ).rejects.toThrow(/moved/);
    } finally {
      await admin`update nodes set owner_id = ${authorSpace} where id = ${id}`;
    }
    // Nothing was restored: the row the author wrote is still the only one.
    const rows = await m.asSystem(() =>
      broker.appDbQuery(authorSpace, id, 'SELECT name FROM items', [], schema),
    );
    expect(rows.map((r) => r.name)).toEqual(['a']);
  });

  // Access matrix N2: the author's state.
  it('a shared app stops when its author is disabled or demoted', async () => {
    const id = await publishedSpaceApp('kill');
    await sa.setSpaceAppSharing(me(), id, 'team');
    expect(await sa.getRunnableSpaceApp(mate, id)).toMatchObject({ id });

    await admin`update auth.users set disabled_at = now() where id = ${author}`;
    try {
      expect(await sa.getRunnableSpaceApp(mate, id)).toBeNull();
      expect((await sa.listSpaceApps(them())).map((a) => a.id)).not.toContain(id);
    } finally {
      await admin`update auth.users set disabled_at = null where id = ${author}`;
    }
    // No longer a member (a login never turns client; an admin role is not a
    // member's either): the app stops.
    await admin`update auth.users set role = 'admin' where id = ${author}`;
    try {
      expect(await sa.getRunnableSpaceApp(mate, id)).toBeNull();
    } finally {
      await admin`update auth.users set role = 'member' where id = ${author}`;
    }
  });

  // Access matrix N6 (option A): a member deletes their own app to a trash
  // in their space. Nothing moves and nothing is removed.
  it('a member deletes their own app to their trash: it stops for everyone, its data stays, it comes back private', async () => {
    const id = await publishedSpaceApp('trash');
    await sa.setSpaceAppSharing(me(), id, 'team');
    expect(await sa.getRunnableSpaceApp(mate, id)).toMatchObject({ id, mine: false });
    const dbFile = (await m.asSystem(() => broker.appDatabasePath(authorSpace, id)))!;
    expect(existsSync(dbFile)).toBe(true);

    // A teammate can neither delete it nor bring it back.
    await expect(sa.deleteSpaceApp(them(), id)).rejects.toMatchObject({ code: 'not-found' });

    const done = await sa.deleteSpaceApp(me(), id);
    expect(done).toMatchObject({ id, sharing: 'private', wasShared: true, wasSubmitted: false });
    // It runs for no one: not the teammate, not the author.
    expect(await sa.getRunnableSpaceApp(mate, id)).toBeNull();
    expect(await sa.getRunnableSpaceApp(author, id)).toBeNull();
    expect((await sa.listSpaceApps(them())).map((a) => a.id)).not.toContain(id);
    expect((await sa.listSpaceApps(me())).map((a) => a.id)).not.toContain(id);
    // Every change refuses; a second delete says it is already there.
    await expect(sa.authorSpaceApp(me(), id)).rejects.toMatchObject({ code: 'deleted' });
    await expect(sa.withAuthorWrite(me(), id, async () => undefined)).rejects.toMatchObject({
      code: 'deleted',
    });
    await expect(sa.setSpaceAppSharing(me(), id, 'team')).rejects.toMatchObject({
      code: 'deleted',
    });
    await expect(sa.submitSpaceApp(me(), id)).rejects.toMatchObject({ code: 'deleted' });
    await expect(sa.deleteSpaceApp(me(), id)).rejects.toMatchObject({ code: 'deleted' });

    // Nothing was removed: the node, the app row, its database file and its
    // history all stay where they were.
    const [kept] = await admin<{ owner_id: string; app: number; db: number; history: number }[]>`
      select n.owner_id,
             (select count(*)::int from apps where node_id = ${id}) as app,
             (select count(*)::int from app_databases where app_node_id = ${id}) as db,
             (select count(*)::int from node_snapshots where node_id = ${id}) as history
        from nodes n where n.id = ${id}`;
    expect(kept).toMatchObject({ owner_id: authorSpace, app: 1, db: 1 });
    expect(kept!.history).toBeGreaterThan(0);
    expect(existsSync(dbFile)).toBe(true);
    const trash = await sa.listDeletedSpaceApps(me());
    expect(trash.find((d) => d.id === id)).toMatchObject({
      title: `${tag} trash`,
      published: true,
      hasData: true,
    });
    expect((await sa.listDeletedSpaceApps(them())).map((d) => d.id)).not.toContain(id);
    await expect(sa.undeleteSpaceApp(them(), id)).rejects.toMatchObject({ code: 'not-found' });

    // Back, private and a draft, with its data; the teammate still cannot run it.
    expect(await sa.undeleteSpaceApp(me(), id)).toMatchObject({
      id,
      sharing: 'private',
      reviewState: 'draft',
    });
    expect(await sa.getRunnableSpaceApp(author, id)).toMatchObject({ id, mine: true });
    expect(await sa.getRunnableSpaceApp(mate, id)).toBeNull();
    const rows = await m.asSystem(() =>
      broker.appDbQuery(authorSpace, id, 'SELECT name FROM items', [], schema),
    );
    expect(rows.map((r) => r.name)).toEqual(['a']);
    expect((await sa.listDeletedSpaceApps(me())).map((d) => d.id)).not.toContain(id);
    await expect(sa.undeleteSpaceApp(me(), id)).rejects.toMatchObject({ code: 'not-deleted' });
  });

  it('a submitted app the member deletes stays in their space and comes back a draft', async () => {
    const id = await publishedSpaceApp('trash submitted');
    await sa.submitSpaceApp(me(), id);

    expect(await sa.deleteSpaceApp(me(), id)).toMatchObject({ wasSubmitted: true });
    const [node] = await admin<{ owner_id: string }[]>`select owner_id from nodes where id = ${id}`;
    expect(node?.owner_id).toBe(authorSpace);

    // It comes back a private draft, never submitted again.
    expect(await sa.undeleteSpaceApp(me(), id)).toMatchObject({ reviewState: 'draft' });
  });

  it("a member deletes only their own manual snapshots, and that frees their budget; the app's data stays", async () => {
    const id = await publishedSpaceApp('snapshot delete');
    // A copy of this database is over 1 MB: one copy fills a 1 MB budget.
    await m.asSystem(() =>
      broker.appDbExec(
        authorSpace,
        id,
        'INSERT INTO items (name) VALUES (?)',
        ['x'.repeat(1_200_000)],
        schema,
      ),
    );
    const dbFile = (await m.asSystem(() => broker.appDatabasePath(authorSpace, id)))!;
    process.env.APP_SNAPSHOT_MAX_MB = '1';
    try {
      const take = (loginId: string) =>
        m.asSystem(() =>
          snaps.createAppSnapshot(authorSpace, id, { actor: 'member', actorLoginId: loginId }),
        );
      const mine = (await take(author))!;
      await expect(take(author)).rejects.toThrow(/my_app_snapshot_delete/);
      // Another login's snapshot (its own budget), an automatic one, and a
      // version: none of them is the author's to delete.
      const theirs = (await take(mate))!;
      const auto = (await m.asSystem(() =>
        snaps.createAppSnapshot(authorSpace, id, {
          trigger: 'pre_schema',
          actor: 'member',
          actorLoginId: author,
        }),
      ))!;
      const version = (await m.asSystem(() => snaps.listAppSnapshots(authorSpace, id))).find(
        (e) => e.kind === 'version',
      )!;
      const del = (snapshotId: string) =>
        sa.withAuthorWrite(me(), id, () =>
          snaps.deleteMemberAppSnapshot(authorSpace, id, snapshotId, author),
        );
      await expect(del(theirs.id)).rejects.toThrow(/not a snapshot you took/);
      await expect(del(auto.id)).rejects.toThrow(/automatic snapshot/);
      await expect(del(version.id)).rejects.toThrow(/is a version/);
      // A teammate cannot reach the app at all.
      await expect(
        sa.withAuthorWrite(them(), id, () =>
          snaps.deleteMemberAppSnapshot(authorSpace, id, mine.id, mate),
        ),
      ).rejects.toMatchObject({ code: 'not-found' });

      const copy = (await m.asSystem(() => snaps.appSnapshotFile(authorSpace, id, mine.id)))!.path;
      expect(existsSync(copy)).toBe(true);
      const gone = await del(mine.id);
      expect(gone).toMatchObject({ id: mine.id });
      expect(gone!.freedBytes).toBeGreaterThan(1_000_000);
      // The row and its copy only: the app's own database file stays, and so
      // do the other entries.
      expect(existsSync(copy)).toBe(false);
      expect(existsSync(dbFile)).toBe(true);
      const left = (await m.asSystem(() => snaps.listAppSnapshots(authorSpace, id))).map(
        (e) => e.id,
      );
      expect(left).not.toContain(mine.id);
      expect(left).toEqual(expect.arrayContaining([theirs.id, auto.id, version.id]));
      expect(await del(mine.id)).toBeNull();
      // The budget is free again.
      expect(await take(author)).toMatchObject({ trigger: 'manual' });
    } finally {
      delete process.env.APP_SNAPSHOT_MAX_MB;
    }
  });

  it('the author restores their own app from its history', async () => {
    const id = await publishedSpaceApp('restore');
    const snap = await m.asSystem(() =>
      snaps.createAppSnapshot(authorSpace, id, {
        note: 'safe point',
        actor: 'member',
        actorLoginId: author,
      }),
    );
    await m.asSystem(() =>
      broker.appDbExec(authorSpace, id, "INSERT INTO items (name) VALUES ('b')", [], schema),
    );
    await m.asSystem(() =>
      snaps.restoreAppSnapshot(authorSpace, id, snap!.id, {
        mode: 'data',
        drainMs: 0,
        actor: 'member',
        actorLoginId: author,
      }),
    );
    const rows = await m.asSystem(() =>
      broker.appDbQuery(authorSpace, id, 'SELECT name FROM items ORDER BY id', [], schema),
    );
    expect(rows.map((r) => r.name)).toEqual(['a']);
    const [who] = await admin<{ actor: string; actor_login_id: string }[]>`
      select actor, actor_login_id from node_snapshots where id = ${snap!.id}`;
    expect(who).toEqual({ actor: 'member', actor_login_id: author });
  });
});
