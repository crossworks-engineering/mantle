/**
 * Member-built apps on Postgres (team apps Phase 3, migration 0235): a
 * member's app lives in their personal space at the team author ceiling;
 * a draft is private (a teammate neither lists nor runs it); sharing with
 * the team lets teammates run the published version; submit freezes it;
 * accept moves it into the brain with its id, its database and its history;
 * send back gives it back, with no note; the author restores from its history.
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
  /** What the admin was shown: the version and the review hash. */
  const shown = async (id: string) => {
    const r = await sa.getMemberAppForReview(id);
    if (!r?.reviewHash) throw new Error('not waiting for review');
    return { version: r.version, reviewHash: r.reviewHash };
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
    expect((await sa.listMemberAppsForReview()).waiting.map((s) => s.id)).toContain(id);
    const review = await sa.getMemberAppForReview(id);
    expect(review?.files['App.tsx']).toBe('export default () => "one";');

    await sa.recallSpaceApp(me(), id);
    expect(await sa.authorSpaceApp(me(), id, { write: true })).toMatchObject({
      reviewState: 'draft',
    });
    expect(await sa.getMemberAppForReview(id)).toBeNull();
  });

  it('accept moves it into the brain: same id, its data and history, the ceiling kept', async () => {
    const id = await publishedSpaceApp('accepted');
    await sa.submitSpaceApp(me(), id);
    const res = await sa.acceptSpaceApp(
      brain,
      id,
      { loginId: brain },
      { level: 'team', trustTools: false, ...(await shown(id)) },
    );
    expect(res).toEqual({ id, level: 'team', authorLevel: 'team' });
    const [row] = await admin<{ owner_id: string; audience: string; author_level: string }[]>`
      select n.owner_id, n.audience, a.author_level from nodes n join apps a on a.node_id = n.id
      where n.id = ${id}`;
    expect(row).toEqual({ owner_id: brain, audience: 'team', author_level: 'team' });
    // Its database followed: the row the author wrote reads under the brain.
    const rows = await m.asSystem(() =>
      broker.appDbQuery(brain, id, 'SELECT name FROM items', [], schema),
    );
    expect(rows.map((r) => r.name)).toEqual(['a']);
    // Its history followed too.
    const history = await m.asSystem(() => snaps.listAppSnapshots(brain, id));
    expect(history.map((e) => e.trigger)).toContain('publish');
    // It is the brain's now: members run it by its level, not as a space app.
    expect(await sa.getRunnableSpaceApp(author, id)).toBeNull();
    expect(await m.asSystem(() => ma.getMemberRunnableApp(brain, id))).toMatchObject({
      id,
    });
    const runtime = await m.asSystem(() => apps.getAppRuntime(brain, id));
    expect(runtime?.authorLevel).toBe('team');
    await expect(sa.authorSpaceApp(me(), id)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('accept with the tools reviewed lifts the ceiling; send back gives it back, no note', async () => {
    const trusted = await publishedSpaceApp('trusted');
    await sa.submitSpaceApp(me(), trusted);
    expect(
      await sa.acceptSpaceApp(
        brain,
        trusted,
        { loginId: brain },
        { level: 'admin', trustTools: true, ...(await shown(trusted)) },
      ),
    ).toMatchObject({ level: 'admin', authorLevel: 'admin' });

    const back = await publishedSpaceApp('returned');
    await sa.submitSpaceApp(me(), back);
    await sa.sendBackSpaceApp(back, { loginId: brain });
    expect(await sa.authorSpaceApp(me(), back, { write: true })).toMatchObject({
      reviewState: 'returned',
    });
    // Review flows carry no messages: the old column is never written.
    const [noted] = await admin<{ returned_note: string | null }[]>`
      select returned_note from space_items where node_id = ${back}`;
    expect(noted?.returned_note).toBeNull();
    await expect(sa.sendBackSpaceApp(back, { loginId: brain })).rejects.toMatchObject({
      code: 'not-submitted',
    });
    // Returned is editable and submits again.
    await sa.submitSpaceApp(me(), back);
    expect((await sa.listMemberAppsForReview()).waiting.map((w) => w.id)).toContain(back);
  });

  // M3 audit, high 1: only the version the admin read can enter the brain.
  it('accept refuses a version the admin was not shown', async () => {
    const id = await publishedSpaceApp('swapped');
    await sa.submitSpaceApp(me(), id);
    const old = await shown(id);
    // The member recalls, changes the code and the tools, publishes, resubmits.
    await sa.recallSpaceApp(me(), id);
    await sa.withAuthorWrite(me(), id, async () => {
      await apps.writeDraftFile(authorSpace, id, 'App.tsx', 'export default () => "two";');
      await apps.setManifest(authorSpace, id, { toolSlugs: ['email_send'] });
      await apps.setDraftBuild(authorSpace, id, { ...GREEN, sha256: 'two' });
      await apps.publishApp(authorSpace, id, { actor: 'member', actorLoginId: author });
    });
    await sa.submitSpaceApp(me(), id);
    await expect(
      sa.acceptSpaceApp(
        brain,
        id,
        { loginId: brain },
        { level: 'admin', trustTools: true, ...old },
      ),
    ).rejects.toMatchObject({ code: 'changed' });
    // A forged hash with the right version is refused too.
    const now = await shown(id);
    await expect(
      sa.acceptSpaceApp(
        brain,
        id,
        { loginId: brain },
        { level: 'team', trustTools: false, version: now.version, reviewHash: '0'.repeat(64) },
      ),
    ).rejects.toMatchObject({ code: 'changed' });
    // What it was shown now goes through, and the review shows the new tools.
    expect((await sa.getMemberAppForReview(id))?.declaredTools).toEqual(['email_send']);
    expect(
      await sa.acceptSpaceApp(
        brain,
        id,
        { loginId: brain },
        { level: 'team', trustTools: false, ...now },
      ),
    ).toMatchObject({ authorLevel: 'team' });
  });

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
    await sa.submitSpaceApp(me(), id);
    await sa.acceptSpaceApp(
      brain,
      id,
      { loginId: brain },
      {
        level: 'team',
        trustTools: false,
        ...(await shown(id)),
      },
    );
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

  // Access matrix N2: the admin's kill switch, and the author's state.
  it('a shared app stops when its author is disabled or demoted; an admin lists and unshares it', async () => {
    const id = await publishedSpaceApp('kill');
    await sa.setSpaceAppSharing(me(), id, 'team');
    expect(await sa.getRunnableSpaceApp(mate, id)).toMatchObject({ id });
    // A private draft never shows to an admin; a shared one does.
    const listed = (await sa.listMemberAppsForReview()).shared.find((a) => a.id === id);
    expect(listed).toMatchObject({ author: { loginId: author, active: true } });

    await admin`update auth.users set disabled_at = now() where id = ${author}`;
    try {
      expect(await sa.getRunnableSpaceApp(mate, id)).toBeNull();
      expect((await sa.listSpaceApps(them())).map((a) => a.id)).not.toContain(id);
      expect(
        (await sa.listMemberAppsForReview()).shared.find((a) => a.id === id)?.author.active,
      ).toBe(false);
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

    expect(await sa.adminUnshareSpaceApp(id)).toBe(true);
    expect(await sa.getRunnableSpaceApp(mate, id)).toBeNull();
    expect(await sa.adminSpaceApp(id)).toBeNull();
    expect(await sa.adminUnshareSpaceApp(id)).toBe(false);
  });

  // M4 audit, medium 2: an admin's delete can be undone from the brain's
  // normal trash, with the app's data, history and activity.
  it("an admin's delete of a member app lands in the brain's trash and comes back", async () => {
    const trash = await import('./app-trash');
    const id = await publishedSpaceApp('admin-delete');
    await sa.setSpaceAppSharing(me(), id, 'team');
    await admin`insert into app_access_log (owner_id, app_node_id, kind, detail)
      values (${authorSpace}, ${id}, 'tool', ${JSON.stringify({ via: 'member', slug: 'x' })}::jsonb)`;

    expect(await sa.adminDeleteSpaceApp(brain, id)).toBe(true);
    expect(await sa.adminSpaceApp(id)).toBeNull();
    expect(await sa.getRunnableSpaceApp(mate, id)).toBeNull();
    const inTrash = (await m.asSystem(() => trash.listDeletedApps(brain))).find((d) => d.id === id);
    expect(inTrash).toMatchObject({ id, hasData: true });
    // Nothing of it stays under the member's space.
    const [left] = await admin<{ snaps: number; log: number; items: number }[]>`
      select (select count(*)::int from node_snapshots where node_id = ${id} and owner_id = ${authorSpace}) as snaps,
             (select count(*)::int from app_access_log where app_node_id = ${id} and owner_id = ${authorSpace}) as log,
             (select count(*)::int from space_items where node_id = ${id}) as items`;
    expect(left).toEqual({ snaps: 0, log: 0, items: 0 });

    // An admin restores it: the brain's, admin only, at team rules, with its data.
    await m.asSystem(() => trash.restoreDeletedApp(brain, id));
    const [node] = await admin<{ owner_id: string; audience: string }[]>`
      select owner_id, audience from nodes where id = ${id}`;
    expect(node).toEqual({ owner_id: brain, audience: 'admin' });
    expect((await m.asSystem(() => apps.getAppRuntime(brain, id)))?.authorLevel).toBe('team');
    const rows = await m.asSystem(() =>
      broker.appDbQuery(brain, id, 'SELECT name FROM items', [], schema),
    );
    expect(rows.map((r) => r.name)).toEqual(['a']);
    // It is the brain's now, no longer a member app an admin acts on here.
    expect(await sa.adminDeleteSpaceApp(brain, id)).toBe(false);
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
    expect(await sa.adminSpaceApp(id)).toBeNull();
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

  it('a submitted app the member deletes leaves the review queue, and an admin cannot reach it', async () => {
    const id = await publishedSpaceApp('trash submitted');
    await sa.submitSpaceApp(me(), id);
    const pinned = await shown(id);
    expect((await sa.listMemberAppsForReview()).waiting.map((s) => s.id)).toContain(id);

    expect(await sa.deleteSpaceApp(me(), id)).toMatchObject({ wasSubmitted: true });
    expect((await sa.listMemberAppsForReview()).waiting.map((s) => s.id)).not.toContain(id);
    expect(await sa.getMemberAppForReview(id)).toBeNull();
    await expect(
      sa.acceptSpaceApp(
        brain,
        id,
        { loginId: brain },
        { level: 'team', trustTools: false, ...pinned },
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
    await expect(sa.sendBackSpaceApp(id, { loginId: brain })).rejects.toMatchObject({
      code: 'not-submitted',
    });
    expect(await sa.adminDeleteSpaceApp(brain, id)).toBe(false);
    const [node] = await admin<{ owner_id: string }[]>`select owner_id from nodes where id = ${id}`;
    expect(node?.owner_id).toBe(authorSpace);

    // It comes back a private draft: never straight back to the queue.
    expect(await sa.undeleteSpaceApp(me(), id)).toMatchObject({ reviewState: 'draft' });
    expect((await sa.listMemberAppsForReview()).waiting.map((s) => s.id)).not.toContain(id);
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

  // Access matrix N3: what a member's app did shows on the brain app after
  // Accept.
  it("Accept moves the app's activity rows to the brain", async () => {
    const id = await publishedSpaceApp('activity');
    await admin`insert into app_access_log (owner_id, app_node_id, kind, detail)
      values (${authorSpace}, ${id}, 'tool', ${JSON.stringify({ via: 'member', slug: 'x' })}::jsonb)`;
    await sa.submitSpaceApp(me(), id);
    await sa.acceptSpaceApp(
      brain,
      id,
      { loginId: brain },
      {
        level: 'team',
        trustTools: false,
        ...(await shown(id)),
      },
    );
    const [row] = await admin<{ owner_id: string }[]>`
      select owner_id from app_access_log where app_node_id = ${id}`;
    expect(row?.owner_id).toBe(brain);
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

  // Workspace review pattern (2026-10-09): members' apps in the admin's Apps
  // screen, two lists, the normal app screen, a test run on a copy.
  it('the review lists show submitted and shared apps, never a private draft', async () => {
    const hidden = await publishedSpaceApp('private draft');
    const shared = await publishedSpaceApp('team shared');
    await sa.setSpaceAppSharing(me(), shared, 'team');
    const waiting = await publishedSpaceApp('waiting');
    await sa.setSpaceAppSharing(me(), waiting, 'team');
    await sa.submitSpaceApp(me(), waiting);

    const lists = await sa.listMemberAppsForReview();
    const all = [...lists.waiting, ...lists.shared].map((a) => a.id);
    expect(all).not.toContain(hidden);
    expect(lists.shared.find((a) => a.id === shared)).toMatchObject({
      author: { loginId: author, active: true },
      runnable: true,
    });
    // Submitted and shared: once, under Waiting, at the version sent.
    expect(lists.shared.map((a) => a.id)).not.toContain(waiting);
    expect(lists.waiting.find((a) => a.id === waiting)).toMatchObject({
      version: (await shown(waiting)).version,
    });

    expect(await sa.getMemberAppForReview(hidden)).toBeNull();
    // The admin reads the PUBLISHED source, never the author's draft.
    await m.asSystem(() =>
      apps.writeDraftFile(authorSpace, shared, 'App.tsx', 'export default () => "secret";'),
    );
    const detail = await sa.getMemberAppForReview(shared);
    expect(detail?.files['App.tsx']).toBe('export default () => "one";');
    expect(detail?.reviewHash).toBeNull();
    // A waiting app carries what an Approve sends back.
    expect((await sa.getMemberAppForReview(waiting))?.reviewHash).toBe(
      (await shown(waiting)).reviewHash,
    );
  });

  it('a test run works on a throwaway copy; the real data never changes', async () => {
    const t = await import('./app-review-test');
    const id = await publishedSpaceApp('tested');
    await sa.setSpaceAppSharing(me(), id, 'team');
    const app = (await sa.getMemberAppForReview(id))!;
    const tester = { loginId: brain };
    // No test started: nothing runs.
    await expect(t.reviewTestSql(tester, app, 'query', 'SELECT 1', [])).rejects.toBeInstanceOf(
      t.ReviewTestGoneError,
    );
    await t.startReviewTest(tester, app);
    await t.reviewTestSql(tester, app, 'exec', "INSERT INTO items (name) VALUES ('test')", []);
    const onCopy = (await t.reviewTestSql(
      tester,
      app,
      'query',
      'SELECT name FROM items ORDER BY id',
      [],
    )) as { name: string }[];
    expect(onCopy.map((r) => r.name)).toEqual(['a', 'test']);
    // The member's own file is as it was.
    const real = await m.asSystem(() =>
      broker.appDbQuery(authorSpace, id, 'SELECT name FROM items ORDER BY id', [], schema),
    );
    expect(real.map((r) => r.name)).toEqual(['a']);
    // Team rules: rows only, never the schema.
    await expect(
      t.reviewTestSql(tester, app, 'exec', 'CREATE TABLE extra (x INTEGER)', []),
    ).rejects.toThrow();
    // host.me() is the admin, filled by the server.
    const me1 = (await t.reviewTestSql(tester, app, 'query', 'SELECT :host_me_kind AS k', [])) as {
      k: string;
    }[];
    expect(me1[0]?.k).toBe('admin');
    // Ending it removes the copy; a restart starts from the real data again.
    await t.endReviewTest(brain, id);
    await expect(t.reviewTestSql(tester, app, 'query', 'SELECT 1', [])).rejects.toBeInstanceOf(
      t.ReviewTestGoneError,
    );
    await t.startReviewTest(tester, app);
    const fresh = (await t.reviewTestSql(tester, app, 'query', 'SELECT name FROM items', [])) as {
      name: string;
    }[];
    expect(fresh.map((r) => r.name)).toEqual(['a']);
    // An idle copy goes by itself.
    expect(await t.sweepReviewTests(Date.now() + t.REVIEW_TEST_IDLE_MS + 60_000)).toBeGreaterThan(
      0,
    );
    await expect(t.reviewTestSql(tester, app, 'query', 'SELECT 1', [])).rejects.toBeInstanceOf(
      t.ReviewTestGoneError,
    );
  });

  it('a test run of an app with no data provisions nothing on the real app', async () => {
    const t = await import('./app-review-test');
    const created = await sa.createSpaceApp(me(), { title: `${tag} empty` });
    await m.asSystem(async () => {
      await apps.writeDraftFile(authorSpace, created.id, 'App.tsx', 'export default () => 1;');
      await apps.setManifest(authorSpace, created.id, { sqlite: schema });
      await apps.setDraftBuild(authorSpace, created.id, GREEN);
      await apps.publishApp(authorSpace, created.id, {
        note: 'first',
        actor: 'member',
        actorLoginId: author,
      });
    });
    await sa.setSpaceAppSharing(me(), created.id, 'team');
    const app = (await sa.getMemberAppForReview(created.id))!;
    const tester = { loginId: brain };
    await t.startReviewTest(tester, app);
    await t.reviewTestSql(tester, app, 'exec', "INSERT INTO items (name) VALUES ('x')", []);
    await t.reviewTestSql(tester, app, 'query', 'SELECT :host_me_id AS id', []);
    const [reg] = await admin<{ n: number }[]>`
      select count(*)::int as n from app_databases where app_node_id = ${created.id}`;
    expect(reg?.n).toBe(0);
    await t.endReviewTest(brain, created.id);
  });

  it('a test run of an informational app reads only', async () => {
    const t = await import('./app-review-test');
    const id = await publishedSpaceApp('informational');
    await sa.setSpaceAppSharing(me(), id, 'team');
    await admin`update apps set data_read_only = true where node_id = ${id}`;
    const app = (await sa.getMemberAppForReview(id))!;
    const tester = { loginId: brain };
    await t.startReviewTest(tester, app);
    await expect(
      t.reviewTestSql(tester, app, 'exec', "INSERT INTO items (name) VALUES ('x')", []),
    ).rejects.toBeInstanceOf(t.ReviewTestReadOnlyError);
    await t.endReviewTest(brain, id);
  });
});
