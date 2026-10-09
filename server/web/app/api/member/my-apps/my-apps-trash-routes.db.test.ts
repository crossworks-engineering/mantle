/**
 * The member's own app trash and snapshot delete over REST (access matrix
 * N6, the routes the member Apps screen uses), end to end on a real
 * migrated Postgres through the real app (createApp):
 *
 *  - POST /api/member/my-apps/:id/delete moves the member's own app to
 *    their trash, GET /api/member/my-apps/deleted lists it, POST
 *    .../undelete brings it back private, and every change is audited;
 *  - GET .../history says which entries the member may delete, and DELETE
 *    .../history/:snapshotId deletes only their own manual snapshot;
 *  - another member, an admin and a client are refused.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/app/api/member/my-apps/my-apps-trash-routes.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Json = Record<string, unknown>;

describe.skipIf(!URL)('member app trash routes', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let tokens: typeof import('@/lib/auth/tokens');
  let content: typeof import('@mantle/content');
  let broker: typeof import('@mantle/content/app-broker');
  let snaps: typeof import('@mantle/content/app-snapshots');
  let dir = '';
  const tag = `mtr-${randomUUID().slice(0, 8)}`;
  const author = randomUUID();
  const mate = randomUUID();
  const adminLogin = randomUUID();
  const client = randomUUID();
  let authorSpace = '';
  let ip = 0;
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

  // A client's session lasts 30 days: a longer client cookie is refused.
  const cookieOf = (id: string) =>
    `mantle_session=${tokens.buildSessionCookie(id, id === client ? { ttlSeconds: 30 * 24 * 60 * 60 } : {}).value}`;
  const call = (pathname: string, who: string, method = 'GET') => {
    ip += 1;
    return app.request(pathname, {
      method,
      headers: {
        cookie: cookieOf(who),
        'content-type': 'application/json',
        'x-forwarded-for': `203.0.113.${ip % 250}`,
      },
    });
  };
  const json = async (res: Response) => (await res.json()) as Json;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'member-trash-routes-db-test-secret-32-chars-at-least';
    delete process.env.MANTLE_DETACHED_DEV;
    dir = await mkdtemp(path.join(tmpdir(), 'member-trash-routes-'));
    process.env.APP_DB_DIR = dir;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    await m.ensureViewerRoles(sql, process.env.MANTLE_MASTER_KEY);
    tokens = await import('@/lib/auth/tokens');
    content = await import('@mantle/content');
    broker = await import('@mantle/content/app-broker');
    snaps = await import('@mantle/content/app-snapshots');
    await ensureTestAnchor(sql);
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${author}, ${`${tag}-a@example.invalid`}, 'x', 'member'),
      (${mate}, ${`${tag}-b@example.invalid`}, 'x', 'member'),
      (${adminLogin}, ${`${tag}-o@example.invalid`}, 'x', 'admin')`;
    await sql`insert into auth.users (id, email, password_hash, role)
      values (${client}, ${`${tag}-c@example.invalid`}, 'x', 'client')`;
    const [space] = await sql<{ id: string }[]>`
      select id from spaces where kind = 'personal' and login_id = ${author}`;
    authorSpace = space!.id;
    const { createApp } = await import('@/server/app');
    app = await createApp();
  }, 120_000);

  afterAll(async () => {
    if (!sql) return;
    const all = [author, mate, adminLogin, client];
    await sql`delete from audit_log where actor_id in ${sql(all)}`;
    await sql`delete from nodes where owner_id = ${authorSpace}`;
    await sql`delete from spaces where login_id in ${sql(all)}`;
    await sql`delete from auth.users where id in ${sql(all)}`;
    await m.closeDb();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** A published app of the author's, with data. */
  async function publishedApp(title: string): Promise<string> {
    const made = await content.createSpaceApp(
      { loginId: author, spaceId: authorSpace },
      { title: `${tag} ${title}` },
    );
    await m.asSystem(async () => {
      await content.writeDraftFile(authorSpace, made.id, 'App.tsx', 'export default () => "x";');
      await content.setManifest(authorSpace, made.id, { sqlite: schema });
      await content.setDraftBuild(authorSpace, made.id, GREEN);
      await content.publishApp(authorSpace, made.id, {
        actor: 'member',
        actorLoginId: author,
      });
      await broker.appDbExec(
        authorSpace,
        made.id,
        "INSERT INTO items (name) VALUES ('a')",
        [],
        schema,
      );
    });
    return made.id;
  }

  const audited = async (action: string) => {
    for (let i = 0; i < 100; i += 1) {
      const rows = await sql<{ detail: Json }[]>`
        select detail from audit_log where action = ${action} and actor_id = ${author}`;
      if (rows.length) return rows;
      await new Promise((r) => setTimeout(r, 20));
    }
    return [];
  };

  it('deletes the own app to the trash, lists it, brings it back private, and audits each', async () => {
    const id = await publishedApp('trash');
    const base = `/api/member/my-apps/${id}`;
    // Another member, an admin and a client cannot delete it.
    expect((await call(`${base}/delete`, mate, 'POST')).status).toBe(404);
    expect((await call(`${base}/delete`, adminLogin, 'POST')).status).toBe(403);
    expect((await call(`${base}/delete`, client, 'POST')).status).toBe(403);

    const del = await call(`${base}/delete`, author, 'POST');
    expect(del.status).toBe(200);
    expect(await json(del)).toMatchObject({ ok: true, app: { id } });
    // In the trash: listed there, not in a teammate's, refused twice.
    const trash = await json(await call('/api/member/my-apps/deleted', author));
    expect((trash.apps as Array<{ id: string }>).map((a) => a.id)).toContain(id);
    const mateTrash = await json(await call('/api/member/my-apps/deleted', mate));
    expect((mateTrash.apps as Array<{ id: string }>).map((a) => a.id)).not.toContain(id);
    expect((await call('/api/member/my-apps/deleted', client)).status).toBe(403);
    const again = await call(`${base}/delete`, author, 'POST');
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ reason: 'deleted' });
    // Its data is kept.
    const file = await m.asSystem(() => broker.appDatabasePath(authorSpace, id));
    expect(file).toBeTruthy();
    expect((await audited('member_app.deleted'))[0]?.detail).toEqual({ appId: id });

    // Another member cannot bring it back; the author can, private.
    expect((await call(`${base}/undelete`, mate, 'POST')).status).toBe(404);
    const back = await call(`${base}/undelete`, author, 'POST');
    expect(back.status).toBe(200);
    expect(await json(back)).toMatchObject({ ok: true, app: { id, sharing: 'private' } });
    const twice = await call(`${base}/undelete`, author, 'POST');
    expect(twice.status).toBe(409);
    expect(await json(twice)).toMatchObject({ reason: 'not-deleted' });
    expect((await audited('member_app.undeleted'))[0]?.detail).toEqual({ appId: id });
  });

  it('marks and deletes only the own manual snapshot, and audits it', async () => {
    const id = await publishedApp('snapshots');
    const take = (loginId: string) =>
      m.asSystem(() =>
        snaps.createAppSnapshot(authorSpace, id, { actor: 'member', actorLoginId: loginId }),
      );
    const mine = (await take(author))!;
    const theirs = (await take(mate))!;
    const base = `/api/member/my-apps/${id}/history`;
    const history = await json(await call(base, author));
    const entries = history.entries as Array<{ id: string; kind: string; deletable: boolean }>;
    expect(entries.find((e) => e.id === mine.id)?.deletable).toBe(true);
    expect(entries.find((e) => e.id === theirs.id)?.deletable).toBe(false);
    expect(entries.filter((e) => e.kind === 'version').every((e) => !e.deletable)).toBe(true);

    // Not the author's: another login's snapshot, another member, a client.
    const notMine = await call(`${base}/${theirs.id}`, author, 'DELETE');
    expect(notMine.status).toBe(409);
    expect(await json(notMine)).toMatchObject({ reason: 'not-yours' });
    expect((await call(`${base}/${mine.id}`, mate, 'DELETE')).status).toBe(404);
    expect((await call(`${base}/${mine.id}`, client, 'DELETE')).status).toBe(403);

    const gone = await call(`${base}/${mine.id}`, author, 'DELETE');
    expect(gone.status).toBe(200);
    expect(await json(gone)).toMatchObject({ ok: true, deleted: mine.id });
    expect((await call(`${base}/${mine.id}`, author, 'DELETE')).status).toBe(404);
    expect((await audited('member_app.snapshot_deleted'))[0]?.detail).toEqual({
      appId: id,
      snapshotId: mine.id,
    });

    // A submitted app is frozen: its snapshots say not deletable, and stay.
    const kept = (await take(author))!;
    const submit = await call(`/api/member/my-apps/${id}/submit`, author, 'POST');
    expect(submit.status).toBe(200);
    const frozen = await json(await call(base, author));
    const keptRow = (frozen.entries as Array<{ id: string; deletable: boolean }>).find(
      (e) => e.id === kept.id,
    );
    expect(keptRow?.deletable).toBe(false);
    const refused = await call(`${base}/${kept.id}`, author, 'DELETE');
    expect(refused.status).toBe(409);
    expect(await json(refused)).toMatchObject({ reason: 'frozen' });
  });
});
