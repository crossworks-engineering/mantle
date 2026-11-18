/**
 * A file's status and processing (docs/files.md, "8c. Status and
 * processing") on a migrated scratch database, through the real app
 * (createApp):
 *
 *  - GET /api/files/files/:id/processing answers a reader of the file (a
 *    user of Admin, and a member whose workspace holds the file with Write
 *    off), and a 404 to a member who does not read it, as the file's own
 *    GET does. The items made from the file are those the caller reads.
 *  - The compact `status` is on the file's row in the folder list, on its
 *    own GET and on its tree item, with its queue job (one read of the
 *    queue) and the state of its database.
 *  - A read failure is `failed` with the reason; a scan read in part is
 *    `partial` with its pages.
 *
 * No owner session is made: the logins are rows of the scratch database.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/app/api/files/file-processing-route.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileProcessing, FileStatus, TreeFolderPage } from '@mantle/client-types';
import { asSuperuser, teamWorkspaceSql } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('file status and processing: the file read gate is the one check', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  const owner = randomUUID();
  const admin = randomUUID();
  const member = randomUUID();
  const reader = randomUUID();
  const tag = `p4st${randomUUID().slice(0, 6)}`;
  let fileId = '';
  let folderId = '';
  let folderPath = '';
  let derivedId = '';
  /** A job row could be put in the queue (a minimal pgboss.job here). */
  let queued = false;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const get = (as: string, url: string) => app.request(url, { headers: { cookie: cookieOf(as) } });
  const processing = async (as: string, id = fileId) => {
    const res = await get(as, `/api/files/files/${id}/processing`);
    const text = await res.text();
    return { status: res.status, text, body: res.ok ? (JSON.parse(text) as FileProcessing) : null };
  };
  const setData = (patch: Record<string, unknown>, drop: string[] = []) =>
    m.withHeads([fileId], 'update', async (tx) => {
      await tx.execute(sql`update nodes
        set data = (data - ${`{${drop.join(',')}}`}::text[]) || ${JSON.stringify(patch)}::jsonb
        where id = ${fileId}`);
    });

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'file-processing-route-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'file-processing-route-secret-at-least-32-characters!';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    await asSuperuser()(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${admin}, ${`${tag}-a@example.invalid`}, 'x', false, 'admin', 'Admin user'),
      (${member}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member'),
      (${reader}, ${`${tag}-r@example.invalid`}, 'x', false, 'member', 'Reader')`);
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
      sql`delete from workspace_users where workspace_id = ${adminWs} and login_id in (${member}, ${reader})`,
    );
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${teamWs}, ${member}, false) on conflict do nothing`);

    // A folder and a made-up CSV in the Admin workspace, and a Table made
    // from the CSV (its sourceFileId), also in Admin.
    await x(sql`insert into nodes (owner_id, type, title, slug, path)
      values (${owner}, 'branch', 'files', 'files', 'files') on conflict do nothing`);
    const f = await import('@mantle/files');
    const content = await import('@mantle/content');
    const made = await m.runAsSystem('test:file-processing-route', () =>
      m.withCreateHome({ createWs: adminWs, privateWs: null, quiet: true }, async () => {
        const folder = await f.createFolder({
          ownerId: owner,
          parentPath: 'files',
          slug: 'status',
        });
        const file = await f.upsertFile({
          ownerId: owner,
          parentPath: folder.path,
          filename: 'made-up.csv',
          bytes: Buffer.from('Tag,Size\nP-101,2\n'),
        });
        const table = await content.createTable(owner, {
          title: `${tag} derived`,
          sourceFileId: file.id,
          data: { columns: [], rows: [] },
        });
        return { folder, file, table };
      }),
    );
    fileId = made.file.id;
    folderId = made.folder.id;
    folderPath = made.folder.path;
    derivedId = made.table.id;
    // A workspace holds the folder with Write off (the reader); the file
    // takes the folder's rows. The Table stays in Admin only.
    const readersWs = randomUUID();
    await su(
      sql`insert into workspaces (id, owner_id, name) values (${readersWs}, ${owner}, ${`${tag} Readers`})`,
    );
    await su(sql`delete from workspace_users where login_id = ${reader}`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${readersWs}, ${reader}, false)`);
    await m.withHeads([folderId, fileId], 'update', async (tx) => {
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
        values (${folderId}, ${readersWs}, false)`);
    });

    // One extract job waiting for the file. A scratch database has no
    // pg-boss tables: a minimal job table stands in. A box's real one is
    // left alone (its partitions take no row of an unknown queue).
    const [reg] = await su<{ ok: boolean }>(
      sql`select to_regclass('pgboss.job') is not null as ok`,
    );
    if (!reg?.ok) {
      await su(sql`create schema if not exists pgboss`);
      await su(sql`create table pgboss.job (name text not null, state text not null, data jsonb)`);
      await su(sql`insert into pgboss.job (name, state, data) values
        ('mantle.extract', 'created', ${JSON.stringify({ nodeId: fileId })}::jsonb),
        ('mantle.extract', 'completed', ${JSON.stringify({ nodeId: derivedId })}::jsonb)`);
      queued = true;
    }

    const tokens = await import('@/lib/auth/tokens');
    cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
    const { createApp } = await import('@/server/app');
    app = await createApp();
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const waiting = (): FileStatus => ({
    ingest: 'waiting',
    ...(queued ? { job: 'queued' as const } : {}),
    db: 'not-built',
  });

  it('a user of Admin gets the processing answer, with the items made from the file', async () => {
    const got = await processing(admin);
    expect(got.status, got.text).toBe(200);
    expect(got.body).toMatchObject({
      file: { id: fileId, filename: 'made-up.csv', extension: 'csv', parentPath: folderPath },
      status: waiting(),
      extraction: { state: 'pending' },
      readAt: null,
      pages: null,
      textChars: 0,
      summarized: false,
      embedded: false,
      chunks: 0,
      facts: 0,
      mentions: 0,
      database: { state: 'not-built', bytes: null, readBy: null },
      job: queued ? 'queued' : null,
      stale: null,
      error: null,
      images: null,
      derived: {
        items: [
          { id: derivedId, kind: 'table', title: `${tag} derived`, path: expect.any(String) },
        ],
        truncated: false,
      },
    });
    expect(got.body!.database).not.toHaveProperty('tables');
  });

  it('a member whose workspace reads the file gets it, and only the items it reads', async () => {
    const got = await processing(reader);
    expect(got.status, got.text).toBe(200);
    expect(got.body!.file.id).toBe(fileId);
    expect(got.body!.derived).toEqual({ items: [], truncated: false });
  });

  it('a member who does not read the file gets the 404 of the file route', async () => {
    const got = await processing(member);
    expect(got.status).toBe(404);
    const own = await get(member, `/api/files/files/${fileId}`);
    expect(own.status).toBe(404);
    expect((await processing(admin, randomUUID())).status).toBe(404);
    expect((await get(admin, `/api/files/files/not-a-uuid/processing`)).status).toBe(404);
  });

  it('the row of the folder list, the file GET and the tree item carry the status', async () => {
    const list = await get(admin, `/api/files/files?parent=${encodeURIComponent(folderPath)}`);
    expect(list.status).toBe(200);
    const rows = ((await list.json()) as { files: Array<{ id: string; status?: FileStatus }> })
      .files;
    expect(rows.find((r) => r.id === fileId)?.status).toEqual(waiting());

    const one = await get(admin, `/api/files/files/${fileId}`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as { file: { status?: FileStatus } }).file.status).toEqual(
      waiting(),
    );

    const tree = await get(admin, `/api/tree/files?folder=${folderId}`);
    expect(tree.status).toBe(200);
    const page = (await tree.json()) as TreeFolderPage;
    expect(page.items.find((i) => i.id === fileId)?.status).toEqual(waiting());
  });

  it('a read failure is failed with its reason; a scan read in part is partial', async () => {
    await setData({ extract_skipped: { reason: 'document_unreadable' } });
    const failed = await processing(admin);
    expect(failed.status, failed.text).toBe(200);
    expect(failed.body!.status.ingest).toBe('failed');
    expect(failed.body!.error).toEqual({
      reason: 'document_unreadable',
      hint: expect.any(String),
    });

    await setData(
      {
        extract_completed_at: '2026-11-18T00:00:00.000Z',
        ocr: { pages_read: 20, pages_total: 80 },
        images: { kept: 3, found: 5 },
      },
      ['extract_skipped'],
    );
    const partial = await processing(admin);
    expect(partial.status, partial.text).toBe(200);
    expect(partial.body).toMatchObject({
      status: { ingest: 'partial' },
      extraction: { state: 'partial', pages: { read: 20, total: 80 } },
      readAt: '2026-11-18T00:00:00.000Z',
      pages: 80,
      error: null,
      images: { kept: 3, found: 5 },
    });
  });
});
