/**
 * POST /api/files/files/:id/run and POST /api/files/folders/:id/run on a
 * migrated scratch database, through the real app (createApp): the gate's
 * edit of the file or the folder is the one rights check.
 *
 *  - A user of Admin gets the dry run of a file and of a folder in the
 *    Admin workspace: the choices, and nothing queued.
 *  - A member who is not in the Admin workspace is refused by the gate,
 *    for the file and the folder, and no notify goes out: the handler is
 *    not reached.
 *  - A body field the route does not take is a 400; `apply` with no
 *    `pipeline` is a 400 with the sentence of runPipelines.
 *
 * Every `pipeline_run` notify of the test is caught on a LISTEN. No owner
 * session is made: the logins are rows of the scratch database.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/app/api/files/pipeline-run-route.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PipelineRunAnswer } from '@mantle/client-types';
import { asSuperuser, teamWorkspaceSql } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the run routes: the edit of the file or folder is the check', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  let listener: ReturnType<Ts['superuserClient']> | undefined;
  const notifies: string[] = [];
  const owner = randomUUID();
  const admin = randomUUID();
  const member = randomUUID();
  const tag = `pl2m5${randomUUID().slice(0, 6)}`;
  let fileId = '';
  let folderId = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const post = (as: string, url: string, body: unknown = {}) =>
    app.request(url, {
      method: 'POST',
      headers: { cookie: cookieOf(as), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'pipeline-run-route-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'pipeline-run-route-secret-at-least-32-characters!';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    await asSuperuser()(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${admin}, ${`${tag}-a@example.invalid`}, 'x', false, 'admin', 'Admin user'),
      (${member}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
    await su(sql.raw(teamWorkspaceSql(owner)));
    const ws = await x<{ id: string; key: string | null }>(sql`
      select id::text as id, (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key
        from workspaces where owner_id = ${owner}`);
    const teamWs = ws.find((w) => w.key === 'team')!.id;
    const adminWs = ws.find((w) => w.key === 'admin')!.id;
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${adminWs}, ${admin}, false) on conflict do nothing`);
    await su(
      sql`delete from workspace_users where workspace_id = ${adminWs} and login_id = ${member}`,
    );
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${teamWs}, ${member}, false) on conflict do nothing`);

    // A folder and a made-up CSV in the Admin workspace.
    const f = await import('@mantle/files');
    const made = await m.runAsSystem('test:pipeline-run-route', () =>
      m.withCreateHome({ createWs: adminWs, privateWs: null }, async () => {
        const folder = await f.createFolder({ ownerId: owner, parentPath: 'files', slug: 'runs' });
        const file = await f.upsertFile({
          ownerId: owner,
          parentPath: folder.path,
          filename: 'made-up.csv',
          bytes: Buffer.from('Tag,Size\nP-101,2\n'),
        });
        return { folder, file };
      }),
    );
    fileId = made.file.id;
    folderId = made.folder.id;

    listener = ts.superuserClient(scratch.url);
    await listener.listen(m.PIPELINE_RUN_CHANNEL, (payload) => notifies.push(payload));
    const tokens = await import('@/lib/auth/tokens');
    cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
    const { createApp } = await import('@/server/app');
    app = await createApp();
  }, 240_000);

  afterAll(async () => {
    await listener?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('a user of Admin gets the dry run of the file and of the folder; nothing is queued', async () => {
    for (const url of [`/api/files/files/${fileId}/run`, `/api/files/folders/${folderId}/run`]) {
      const res = await post(admin, url);
      const text = await res.text();
      expect(res.status, text).toBe(200);
      const answer = JSON.parse(text) as PipelineRunAnswer;
      expect(answer).toMatchObject({ apply: false, busy: false, queued: 0, next: null });
      expect(answer.choices).toEqual([
        { pipeline: 'sheet', name: expect.any(String), files: 1, refused: null },
      ]);
      console.log(`[pipeline-run-route] POST ${url.replace(/[0-9a-f-]{36}/, ':id')}: ${text}`);
    }
    expect(notifies).toEqual([]);
  });

  it('a refused body is a 400, and apply with no pipeline says what to do', async () => {
    const bad = await post(admin, `/api/files/files/${fileId}/run`, { force: true });
    expect(bad.status).toBe(400);
    const noPipeline = await post(admin, `/api/files/files/${fileId}/run`, { apply: true });
    expect(noPipeline.status).toBe(400);
    expect(((await noPipeline.json()) as { error: string }).error).toContain(
      'apply needs a pipeline',
    );
    expect(notifies).toEqual([]);
  });

  it('a member with no edit of the file or the folder is refused by the gate', async () => {
    for (const url of [`/api/files/files/${fileId}/run`, `/api/files/folders/${folderId}/run`]) {
      const res = await post(member, url, { pipeline: 'sheet', apply: true });
      expect([403, 404], await res.clone().text()).toContain(res.status);
    }
    expect(notifies).toEqual([]);
  });

  it('the run queues one notify for each file', async () => {
    const res = await post(admin, `/api/files/folders/${folderId}/run`, {
      pipeline: 'sheet',
      apply: true,
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ apply: true, queued: 1 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(notifies).toEqual([`sheet:${fileId}`]);
  });
});
