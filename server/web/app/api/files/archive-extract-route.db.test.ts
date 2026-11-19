/**
 * "Extract contents" of an archive (docs/files.md, "Archives") on a migrated
 * scratch database, through the real app (createApp) for the asks and the
 * job function itself (runArchiveExtract, as the extract queue's heavy lane
 * calls it) for the work. Every archive is generated in the test.
 *
 *  - The writer (a Moderator of the folder's home) asks: a new folder is
 *    made beside the archive, named after it, the stamp says `queued`, and
 *    one `archive_extract` notify goes out. Nothing is unpacked yet.
 *  - The job writes every file through the upload path: the archive's
 *    folders kept as far as the tree has room, a deeper one in the file's
 *    name, two names that clean to one (`A.txt`, `a.txt`) both kept
 *    (`a-2.txt`), the macOS folder files skipped and counted, a nested
 *    archive one more file. The writer reads what it made.
 *  - A climbing path, an absolute path and a symbolic link are refused and
 *    named in the stamp; the other entries are written.
 *  - A .tar.gz is extracted the same way.
 *  - A bomb (its files past 512 MB together) is refused whole: `failed`,
 *    and nothing is written.
 *  - A reader (Write off) is refused (403) and an outsider gets a 404; no
 *    notify goes out for either. A second ask while one is queued is a 409.
 *    A 7z and a .docx (a ZIP by its bytes, a document by its name) are
 *    400s. The job runs only for a queued stamp: a file never asked is not
 *    touched.
 *
 * No owner session is made: the logins are rows of the scratch database.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/app/api/files/archive-extract-route.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ArchiveExtractAnswer } from '@mantle/client-types';
import { asSuperuser, teamWorkspaceSql } from '@mantle/db/test-support';
import { testGzip, testTar, testZip } from '../../../../../packages/files/src/archive.test-helper';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('an archive is extracted only on an ask, into a folder beside it', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let f: typeof import('@mantle/files');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  let listener: ReturnType<Ts['superuserClient']> | undefined;
  const notifies: string[] = [];
  const owner = randomUUID();
  const writer = randomUUID();
  const reader = randomUUID();
  const outsider = randomUUID();
  const tag = `arx${randomUUID().slice(0, 6)}`;
  let folderPath = '';
  const ids: Record<string, string> = {};

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const ask = async (as: string, id: string, method: 'GET' | 'POST' = 'POST') => {
    const res = await app.request(`/api/files/files/${id}/extract`, {
      method,
      headers: {
        cookie: cookieOf(as),
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      text,
      body: res.ok ? (JSON.parse(text) as ArchiveExtractAnswer) : null,
    };
  };
  const run = (id: string) =>
    m.runAsSystem('test:archive-extract', () => f.runArchiveExtract(owner, id));
  /** The files and folders below a folder path, by their path inside it. */
  const below = async (root: string) => {
    const rows = await x<{
      type: string;
      path: string;
      slug: string;
      title: string;
      from: string | null;
    }>(sql`
      select type::text as type, path::text as path, slug, title,
             data->'from_archive'->>'path' as from
        from nodes where owner_id = ${owner} and path <@ ${root}::ltree
         and type in ('file', 'branch')
         and not (type = 'branch' and path::text = ${root})
       order by path::text, slug`);
    return rows;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'archive-extract-route-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'archive-extract-route-secret-at-least-32-characters!';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    await asSuperuser()(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${writer}, ${`${tag}-w@example.invalid`}, 'x', false, 'member', 'Writer'),
      (${reader}, ${`${tag}-r@example.invalid`}, 'x', false, 'member', 'Reader'),
      (${outsider}, ${`${tag}-x@example.invalid`}, 'x', false, 'member', 'Outsider')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
    await su(sql.raw(teamWorkspaceSql(owner)));
    const ws = await x<{ id: string; key: string | null }>(sql`
      select id::text as id, (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key
        from workspaces where owner_id = ${owner}`);
    const teamWs = ws.find((w) => w.key === 'team')!.id;
    // The writer moderates the folder's home; the reader's workspace holds
    // the folder with Write off; the outsider is in Team only.
    const deskWs = randomUUID();
    const readWs = randomUUID();
    await su(sql`insert into workspaces (id, owner_id, name) values
      (${deskWs}, ${owner}, ${`${tag} Desk`}), (${readWs}, ${owner}, ${`${tag} Readers`})`);
    await su(
      sql`delete from workspace_users where login_id in (${writer}, ${reader}, ${outsider})`,
    );
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${deskWs}, ${writer}, true), (${readWs}, ${reader}, false), (${teamWs}, ${outsider}, false)`);

    await x(sql`insert into nodes (owner_id, type, title, slug, path)
      values (${owner}, 'branch', 'files', 'files', 'files') on conflict do nothing`);
    const inner = testZip([{ name: 'inner.txt', data: 'inside the inner zip' }]);
    const archives: Record<string, Buffer> = {
      'normal.zip': testZip([
        { name: 'docs/' },
        { name: 'docs/readme.md', data: '# Read me' },
        { name: 'docs/deep/more.txt', data: 'more text' },
        { name: 'A.txt', data: 'upper' },
        { name: 'a.txt', data: 'lower' },
        { name: 'nested.zip', data: inner, store: true },
        { name: '__MACOSX/._readme.md', data: 'resource fork' },
      ]),
      'hostile.zip': testZip([
        { name: '../escape.txt', data: 'out' },
        { name: '/etc/passwd', data: 'root' },
        { name: 'link', data: '/etc/shadow', mode: 0o120777 },
        { name: 'ok.txt', data: 'fine' },
      ]),
      'site.tar.gz': testGzip(
        testTar([
          { name: 'site/', type: '5' },
          { name: 'site/index.html', data: '<h1>hi</h1>' },
          { name: 'site/../../up.txt', data: 'x' },
        ]),
      ),
      'bomb.zip': testZip([
        {
          name: 'zeros.bin',
          repeat: { chunk: Buffer.alloc(1024 * 1024), times: 1 },
          declaredSize: 120 * 1024 * 1024,
        },
        ...Array.from({ length: 4 }, (_, i) => ({
          name: `more-${i}.bin`,
          repeat: { chunk: Buffer.alloc(1024 * 1024), times: 1 },
          declaredSize: 120 * 1024 * 1024,
        })),
      ]),
      'busy.zip': testZip([{ name: 'b.txt', data: 'b' }]),
      'never.zip': testZip([{ name: 'n.txt', data: 'n' }]),
      'sealed.7z': Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4, 9, 9, 9]),
      'letter.docx': testZip([{ name: 'word/document.xml', data: '<w:document/>' }]),
    };
    const made = await m.runAsSystem('test:archive-extract-route', () =>
      m.withCreateHome({ createWs: deskWs, privateWs: null, quiet: true }, async () => {
        const folder = await f.createFolder({ ownerId: owner, parentPath: 'files', slug: tag });
        const files: Record<string, string> = {};
        for (const [name, bytes] of Object.entries(archives)) {
          const file = await f.upsertFile({
            ownerId: owner,
            parentPath: folder.path,
            filename: name,
            bytes,
          });
          files[name] = file.id;
        }
        return { folder, files };
      }),
    );
    folderPath = made.folder.path;
    Object.assign(ids, made.files);
    await m.withHeads([made.folder.id, ...Object.values(made.files)], 'update', async (tx) => {
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
        values (${made.folder.id}, ${readWs}, false)`);
    });

    listener = ts.superuserClient(scratch.url);
    await listener.listen(m.ARCHIVE_EXTRACT_CHANNEL, (payload) => notifies.push(payload));
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

  it('the GET says a ZIP can be extracted, and that nothing was asked', async () => {
    const got = await ask(writer, ids['normal.zip']!, 'GET');
    expect(got.status, got.text).toBe(200);
    expect(got.body).toMatchObject({ extractable: true, extract: null });
  });

  it('a file never asked is not touched by the job', async () => {
    expect(await run(ids['never.zip']!)).toBeNull();
    // Only the archives themselves are there: no folder was made.
    expect((await below(folderPath)).filter((r) => r.type === 'branch')).toEqual([]);
  });

  it('the writer asks: a folder beside it, queued, one notify, nothing unpacked yet', async () => {
    const got = await ask(writer, ids['normal.zip']!);
    expect(got.status, got.text).toBe(200);
    const view = got.body!.extract!;
    expect(view.state).toBe('queued');
    expect(view.folder?.path).toBe(`${folderPath}.normal`);
    // The notify is sent outside the request's transaction: wait for it.
    for (let i = 0; i < 50 && !notifies.includes(ids['normal.zip']!); i += 1) await sleep(50);
    expect(notifies).toContain(ids['normal.zip']);
    const rows = (await below(folderPath)).filter((r) => r.type === 'branch');
    expect(rows.map((r) => [r.type, r.path])).toEqual([['branch', `${folderPath}.normal`]]);
    expect(await below(`${folderPath}.normal`)).toEqual([]);
  });

  it('a second ask while one is queued is a 409', async () => {
    const first = await ask(writer, ids['busy.zip']!);
    expect(first.status, first.text).toBe(200);
    const again = await ask(writer, ids['busy.zip']!);
    expect(again.status, again.text).toBe(409);
  });

  it('the job writes every file: folders kept, a deep one in the name, clashes numbered', async () => {
    const stamp = await run(ids['normal.zip']!);
    expect(stamp).toMatchObject({
      state: 'done',
      files: 5,
      folders: 1,
      skipped: 1,
      flattened: 1,
      refused_count: 0,
    });
    const root = `${folderPath}.normal`;
    const rows = await below(root);
    expect(rows.map((r) => [r.type, r.path, r.slug, r.from])).toEqual([
      ['file', root, 'a-2.txt', 'a.txt'],
      ['file', root, 'a.txt', 'A.txt'],
      ['file', root, 'nested.zip', 'nested.zip'],
      ['file', `${root}.docs`, 'deep-more.txt', 'docs/deep/more.txt'],
      ['branch', `${root}.docs`, 'docs', null],
      ['file', `${root}.docs`, 'readme.md', 'docs/readme.md'],
    ]);
    // Each file's bytes are the entry's.
    const readme = await f.readFileById({
      ownerId: owner,
      fileId: (
        await x<{ id: string }>(sql`select id::text as id from nodes
        where owner_id = ${owner} and type = 'file' and path = ${`${root}.docs`}::ltree and slug = 'readme.md'`)
      )[0]!.id,
    });
    expect(readme?.bytes.toString()).toBe('# Read me');
    // The GET says done, and the writer reads what it made.
    const got = await ask(writer, ids['normal.zip']!, 'GET');
    expect(got.body!.extract).toMatchObject({ state: 'done', files: 5, folders: 1, flattened: 1 });
    const nested = (
      await x<{ id: string }>(sql`select id::text as id from nodes
      where owner_id = ${owner} and type = 'file' and path = ${root}::ltree and slug = 'nested.zip'`)
    )[0]!.id;
    const read = await app.request(`/api/files/files/${nested}`, {
      headers: { cookie: cookieOf(writer) },
    });
    expect(read.status).toBe(200);
    // The nested archive is an archive with its own option, never unpacked.
    const inner = await ask(writer, nested, 'GET');
    expect(inner.body).toMatchObject({ extractable: true, extract: null });
  });

  it('a climbing path, an absolute path and a link are refused and named', async () => {
    expect((await ask(writer, ids['hostile.zip']!)).status).toBe(200);
    const stamp = await run(ids['hostile.zip']!);
    expect(stamp).toMatchObject({ state: 'done', files: 1, refused_count: 3 });
    expect(stamp!.refused).toEqual([
      { name: '../escape.txt', reason: 'traversal' },
      { name: '/etc/passwd', reason: 'absolute' },
      { name: 'link', reason: 'link' },
    ]);
    const rows = await below(`${folderPath}.hostile`);
    expect(rows.map((r) => r.slug)).toEqual(['ok.txt']);
    // Nothing of the refused entries was written anywhere.
    const strays = await x<{ slug: string }>(sql`select slug from nodes
      where owner_id = ${owner} and type = 'file' and slug in ('escape.txt', 'passwd', 'link')`);
    expect(strays).toEqual([]);
  });

  it('a .tar.gz is extracted the same way', async () => {
    expect((await ask(writer, ids['site.tar.gz']!)).status).toBe(200);
    const stamp = await run(ids['site.tar.gz']!);
    expect(stamp).toMatchObject({ state: 'done', files: 1, folders: 1, refused_count: 1 });
    // The stored name is `site-tar.gz` (one dot a name), so the folder is
    // `site-tar`: read it from the stamp.
    expect(stamp!.folder_path).toBe(`${folderPath}.site_tar`);
    const rows = await below(stamp!.folder_path!);
    // By path, then slug: the folder's own row and its file share a path.
    expect(rows.map((r) => [r.type, r.slug])).toEqual([
      ['file', 'index.html'],
      ['branch', 'site'],
    ]);
  });

  it('a bomb past the total is refused whole: failed, nothing written', async () => {
    expect((await ask(writer, ids['bomb.zip']!)).status).toBe(200);
    const stamp = await run(ids['bomb.zip']!);
    expect(stamp).toMatchObject({ state: 'failed', files: 0 });
    expect(stamp!.error).toMatch(/more than 512 MB/);
    expect(await below(`${folderPath}.bomb`)).toEqual([]);
  });

  it('a reader is refused and an outsider finds nothing; no notify for either', async () => {
    const before = notifies.length;
    const asReader = await ask(reader, ids['never.zip']!);
    expect(asReader.status, asReader.text).toBe(403);
    const asOutsider = await ask(outsider, ids['never.zip']!);
    expect(asOutsider.status, asOutsider.text).toBe(404);
    await sleep(200);
    expect(notifies.length).toBe(before);
    // Nothing was made or stamped.
    const [row] = await x<{ stamp: unknown }>(sql`select data->'archive_extract' as stamp
      from nodes where id = ${ids['never.zip']}`);
    expect(row!.stamp).toBeNull();
  });

  it('a 7z and a document that is a ZIP inside are not extracted', async () => {
    const sealed = await ask(writer, ids['sealed.7z']!);
    expect(sealed.status, sealed.text).toBe(400);
    expect(sealed.text).toMatch(/cannot extract 7z/);
    const docx = await ask(writer, ids['letter.docx']!);
    expect(docx.status, docx.text).toBe(400);
    const got = await ask(writer, ids['letter.docx']!, 'GET');
    expect(got.body).toMatchObject({ extractable: false });
  });
});
