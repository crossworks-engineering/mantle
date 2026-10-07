/**
 * App packages and copies on Postgres (apps first-class plan, Phase 3): a
 * `.mantleapp` export holds the code and a copy of the data, and installs as
 * a new app with both; a package without data, or one asked for without it,
 * brings an empty database; a damaged database or a package that is not one
 * is refused before anything is made; a duplicate keeps the builds (live at
 * once), the draft and the data, and none of the original's history.
 * Seeds its own owner and apps on random ids; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/app-package.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('app packages and copies on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let apps: typeof import('./apps');
  let broker: typeof import('./app-broker');
  let snaps: typeof import('./app-snapshots');
  let pack: typeof import('./app-package');
  let dir = '';
  const owner = randomUUID();
  const tag = owner.slice(0, 8);
  const GREEN = {
    storageKey: 'attachments/aa/bb/test',
    sha256: 'test',
    builtAt: '2026-10-02T00:00:00.000Z',
    esbuildVersion: 'test',
    bytes: 1,
    ok: true,
  };
  const schema = {
    schemaSql: 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT);',
    schemaVersion: 1,
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    dir = await mkdtemp(path.join(tmpdir(), 'app-package-db-'));
    process.env.APP_DB_DIR = dir;
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    apps = await import('./apps');
    broker = await import('./app-broker');
    snaps = await import('./app-snapshots');
    pack = await import('./app-package');
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`ap-${tag}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from node_snapshots where owner_id = ${owner}`;
    await admin`delete from nodes where owner_id = ${owner}`;
    await admin`delete from spaces where login_id = ${owner}`;
    await admin`delete from auth.users where id = ${owner}`;
    await m.closeDb();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** A published app ("one") with a draft ("wip") and two rows of data. */
  async function richApp(title: string) {
    const app = await apps.createApp(owner, {
      title: `${tag} ${title}`,
      icon: '📦',
      tags: ['stock'],
      description: 'counts things',
    });
    await apps.writeDraftFile(owner, app.id, 'App.tsx', 'export default () => "one";');
    await apps.setManifest(owner, app.id, { sqlite: schema, toolSlugs: ['no_such_tool'] });
    await apps.setDraftBuild(owner, app.id, GREEN);
    await apps.publishApp(owner, app.id, { note: 'first', actor: 'owner' });
    await apps.writeDraftFile(owner, app.id, 'App.tsx', 'export default () => "wip";');
    for (const n of ['a', 'b']) {
      await broker.appDbExec(owner, app.id, 'INSERT INTO items (name) VALUES (?)', [n], schema);
    }
    return app.id;
  }
  const names = async (id: string) =>
    (await broker.appDbQuery(owner, id, 'SELECT name FROM items ORDER BY id', [], schema)).map(
      (r) => r.name,
    );
  async function exported(id: string, withData = true) {
    const file = path.join(dir, `${randomUUID()}.mantleapp`);
    const res = await pack.writeAppPackage(owner, id, file, { withData });
    return { res, bytes: await readFile(file) };
  }
  const countApps = async () =>
    Number(
      (
        await admin`select count(*)::int as n from nodes where owner_id = ${owner} and type = 'app'`
      )[0]!.n,
    );

  it('exports the code and the data, and installs both as a new app', async () => {
    const id = await richApp('export');
    const { res, bytes } = await exported(id);
    expect(res).toMatchObject({ hasData: true });
    expect(res!.bytes).toBe(bytes.length);

    const opened = await pack.openAppPackage(bytes);
    expect(opened.pkg).toMatchObject({
      format: 'mantleapp',
      app: { title: `${tag} export`, icon: '📦', tags: ['stock'], description: 'counts things' },
      code: { published: true },
      manifest: { sqlite: schema, toolSlugs: ['no_such_tool'] },
      data: { schemaVersion: 1 },
    });
    expect(opened.pkg.code.source.files['App.tsx']).toContain('one');
    expect(opened.pkg.code.draft?.files['App.tsx']).toContain('wip');
    // The database is stored, not deflated on the main thread (audit, low).
    expect(res!.bytes).toBeGreaterThan(opened.pkg.data!.bytes);

    const data = await opened.extractData();
    expect(data).not.toBeNull();
    const app = await pack.installAppPackage(owner, opened.pkg, {
      title: `${tag} imported`,
      toolSlugs: [],
      data,
    });
    await rm(data!.path, { force: true });
    expect(app.id).not.toBe(id);
    expect(await names(app.id)).toEqual(['a', 'b']);
    const got = await apps.getApp(owner, app.id);
    expect(got).toMatchObject({
      title: `${tag} imported`,
      icon: '📦',
      manifest: { sqlite: schema, toolSlugs: [], description: 'counts things' },
      // The caller builds and publishes; install leaves the code unbuilt.
      publishedBuild: null,
      draft: null,
    });
    expect(got!.source.files['App.tsx']).toContain('one');
    // The new app has its own history, empty.
    expect(await snaps.listAppSnapshots(owner, app.id)).toEqual([]);
  });

  it('without data: the export holds none, and an import of a full one can leave it out', async () => {
    const id = await richApp('nodata');
    const lean = await exported(id, false);
    expect(lean.res).toMatchObject({ hasData: false });
    const opened = await pack.openAppPackage(lean.bytes);
    expect(opened.pkg.data).toBeNull();
    expect(await opened.extractData()).toBeNull();
    const zip = await JSZip.loadAsync(lean.bytes);
    expect(Object.keys(zip.files)).toEqual(['mantleapp.json']);

    const app = await pack.installAppPackage(owner, opened.pkg, { toolSlugs: [], data: null });
    // The declared schema runs on the first open: an empty table.
    expect(await names(app.id)).toEqual([]);
  });

  it('refuses a damaged database, and a file that is not a package, before making anything', async () => {
    const id = await richApp('damaged');
    const { bytes } = await exported(id);
    const zip = await JSZip.loadAsync(bytes);
    zip.file('data.sqlite', Buffer.from('SQLite format 3\0 but not really a database at all'));
    const bad = await zip.generateAsync({ type: 'nodebuffer' });
    const before = await countApps();

    const opened = await pack.openAppPackage(bad);
    await expect(opened.extractData()).rejects.toBeInstanceOf(pack.AppPackageError);
    await expect(pack.openAppPackage(Buffer.from('not a zip'))).rejects.toThrow(/not a .mantleapp/);
    const other = new JSZip();
    other.file('mantleapp.json', JSON.stringify({ format: 'mantleapp', version: 99 }));
    await expect(
      pack.openAppPackage(await other.generateAsync({ type: 'nodebuffer' })),
    ).rejects.toThrow(/format version 99/);
    const noEntry = new JSZip();
    noEntry.file(
      'mantleapp.json',
      JSON.stringify({
        ...JSON.parse(await zip.file('mantleapp.json')!.async('string')),
        code: { source: { entry: 'Main.tsx', files: { 'App.tsx': 'x' } } },
      }),
    );
    await expect(
      pack.openAppPackage(await noEntry.generateAsync({ type: 'nodebuffer' })),
    ).rejects.toThrow(/entry 'Main.tsx'/);
    // A zip with too many entries is refused before it is parsed (audit, low).
    const crowded = new JSZip();
    for (let i = 0; i < 40; i++) crowded.file(`x${i}.txt`, 'x');
    await expect(
      pack.openAppPackage(await crowded.generateAsync({ type: 'nodebuffer' })),
    ).rejects.toThrow(/40 entries/);
    expect(await countApps()).toBe(before);
    // No work files are left behind.
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(path.join(dir, '_tmp'))).filter((f) => f.endsWith('.sqlite'))).toEqual(
      [],
    );
  });

  it('duplicates an app with its builds, draft and data, and none of its history', async () => {
    const id = await richApp('original');
    const copy = await pack.duplicateApp(owner, id);
    expect(copy).toMatchObject({ title: `${tag} original (copy)`, hasData: true });
    const got = await apps.getApp(owner, copy!.id);
    expect(got).toMatchObject({
      icon: '📦',
      tags: ['stock'],
      publishedBuild: GREEN,
      manifest: { sqlite: schema, toolSlugs: ['no_such_tool'], description: 'counts things' },
    });
    expect(got!.source.files['App.tsx']).toContain('one');
    expect(got!.draft?.files['App.tsx']).toContain('wip');
    expect(await names(copy!.id)).toEqual(['a', 'b']);
    const history = await snaps.listAppSnapshots(owner, copy!.id);
    expect(history.map((e) => [e.seq, e.trigger, e.note])).toEqual([
      [1, 'publish', `copied from ${tag} original`],
    ]);

    // The two databases are apart: a write to the copy stays in the copy.
    await broker.appDbExec(owner, copy!.id, "INSERT INTO items (name) VALUES ('c')", [], schema);
    expect(await names(id)).toEqual(['a', 'b']);

    const lean = await pack.duplicateApp(owner, id, { title: `${tag} lean`, withData: false });
    expect(lean).toMatchObject({ title: `${tag} lean`, hasData: false });
    expect(await names(lean!.id)).toEqual([]);
    expect(await pack.duplicateApp(owner, randomUUID())).toBeNull();
  });
});
