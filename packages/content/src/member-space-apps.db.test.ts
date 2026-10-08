/**
 * Member-built apps on Postgres (team apps Phase 3, migration 0235): a
 * member's app lives in their personal space at the team author ceiling;
 * a draft is private (a teammate neither lists nor runs it); sharing with
 * the team lets teammates run the published version; submit freezes it;
 * accept moves it into the brain with its id, its database and its history;
 * return gives it back with a note; the author restores from its history.
 * Seeds its own brain and logins on random ids; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/member-space-apps.db.test.ts
 */
import { randomUUID } from 'node:crypto';
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
    expect((await sa.listSpaceAppSubmissions()).map((s) => s.id)).toContain(id);
    const review = await sa.getSpaceAppSubmission(id);
    expect(review?.files['App.tsx']).toBe('export default () => "one";');

    await sa.recallSpaceApp(me(), id);
    expect(await sa.authorSpaceApp(me(), id, { write: true })).toMatchObject({
      reviewState: 'draft',
    });
    expect(await sa.getSpaceAppSubmission(id)).toBeNull();
  });

  it('accept moves it into the brain: same id, its data and history, the ceiling kept', async () => {
    const id = await publishedSpaceApp('accepted');
    await sa.submitSpaceApp(me(), id);
    const res = await sa.acceptSpaceApp(
      brain,
      id,
      { loginId: brain },
      { level: 'team', trustTools: false },
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

  it('accept with the tools reviewed lifts the ceiling; return gives it back with a note', async () => {
    const trusted = await publishedSpaceApp('trusted');
    await sa.submitSpaceApp(me(), trusted);
    expect(
      await sa.acceptSpaceApp(
        brain,
        trusted,
        { loginId: brain },
        { level: 'admin', trustTools: true },
      ),
    ).toMatchObject({ level: 'admin', authorLevel: 'admin' });

    const back = await publishedSpaceApp('returned');
    await sa.submitSpaceApp(me(), back);
    await sa.returnSpaceApp(back, { loginId: brain }, 'add a title');
    expect(await sa.authorSpaceApp(me(), back, { write: true })).toMatchObject({
      reviewState: 'returned',
      returnedNote: 'add a title',
    });
    await expect(sa.returnSpaceApp(back, { loginId: brain }, 'again')).rejects.toMatchObject({
      code: 'not-submitted',
    });
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
