/**
 * The durable "dirty" stamp of app table exports on Postgres (apps
 * first-class plan D8; migrations 0221, 0223): the first write of a burst
 * stamps the app's exports and every write its time, a sync that reads the
 * rows clears the mark, a write during a sync keeps it, and the catch-up syncs what a lost timer left
 * dirty and nothing that is fresh. Seeds its own owner and app on random ids;
 * removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/app-table-exports-dirty.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('app table export dirty stamp on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let apps: typeof import('./apps');
  let broker: typeof import('./app-broker');
  let exportsMod: typeof import('./app-table-exports');
  let dir = '';
  const owner = randomUUID();
  const tag = owner.slice(0, 8);
  const schema = {
    schemaSql: 'CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT);',
    schemaVersion: 1,
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    dir = await mkdtemp(path.join(tmpdir(), 'app-export-dirty-db-'));
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    apps = await import('./apps');
    broker = await import('./app-broker');
    exportsMod = await import('./app-table-exports');
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`ed-${tag}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from nodes where owner_id = ${owner}`;
    await admin`delete from spaces where login_id = ${owner}`;
    await admin`delete from auth.users where id = ${owner}`;
    await m.closeDb();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function appWithExport(title: string) {
    const app = await apps.createApp(owner, { title: `${tag} ${title}` });
    await apps.setManifest(owner, app.id, { sqlite: schema });
    await broker.appDbExec(owner, app.id, "INSERT INTO notes (body) VALUES ('a')", [], schema);
    const made = await exportsMod.createAppTableExport(owner, app.id, 'notes');
    return { appId: app.id, linkId: made.export.id };
  }
  /** The stamp as epoch ms, or null (the raw client answers text). */
  const dirtyOf = async (linkId: string) => {
    const v = (await admin`select dirty_since from app_table_exports where id = ${linkId}`)[0]
      ?.dirty_since as string | Date | null | undefined;
    return v ? new Date(v).getTime() : null;
  };
  const settle = () => new Promise((r) => setTimeout(r, 200));

  it('the first write of a burst stamps the exports; a sync clears the stamp', async () => {
    const { appId, linkId } = await appWithExport('stamp');
    expect(await dirtyOf(linkId)).toBeNull();
    exportsMod.scheduleAppTableExportSync(owner, appId);
    await settle();
    const first = await dirtyOf(linkId);
    expect(first).toEqual(expect.any(Number));
    // A second write in the same burst keeps the first stamp.
    exportsMod.scheduleAppTableExportSync(owner, appId);
    await settle();
    expect(await dirtyOf(linkId)).toBe(first);

    await broker.appDbExec(owner, appId, "INSERT INTO notes (body) VALUES ('b')", [], schema);
    expect(await exportsMod.syncAppTableExports(owner, appId)).toMatchObject({ synced: 1 });
    expect(await dirtyOf(linkId)).toBeNull();
  });

  it('a write stamped after the sync read the rows stays dirty', async () => {
    const { appId, linkId } = await appWithExport('during');
    await admin`update app_table_exports set dirty_since = now() + interval '1 hour', last_write_at = now() + interval '1 hour' where id = ${linkId}`;
    await exportsMod.syncAppTableExports(owner, appId);
    expect(await dirtyOf(linkId)).toEqual(expect.any(Number));
  });

  it('a write during a sync keeps the burst dirty, though the burst began before it (audit item 7)', async () => {
    const { appId, linkId } = await appWithExport('hole');
    // The burst began an hour ago (the first write's stamp) ...
    await admin`update app_table_exports set dirty_since = now() - interval '1 hour' where id = ${linkId}`;
    // ... and a write lands while the sync runs: after its read.
    await admin`update app_table_exports set last_write_at = now() + interval '1 hour' where id = ${linkId}`;
    await exportsMod.syncAppTableExports(owner, appId);
    expect(await dirtyOf(linkId)).toEqual(expect.any(Number));
    // Every write stamps last_write_at, not only a burst's first.
    exportsMod.scheduleAppTableExportSync(owner, appId);
    exportsMod.scheduleAppTableExportSync(owner, appId);
    await settle();
    const [row] = await admin`select last_write_at from app_table_exports where id = ${linkId}`;
    expect(new Date(row!.last_write_at as string).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('the catch-up syncs what a lost timer left dirty, and leaves a fresh stamp alone', async () => {
    const lost = await appWithExport('lost');
    const fresh = await appWithExport('fresh');
    await broker.appDbExec(owner, lost.appId, "INSERT INTO notes (body) VALUES ('c')", [], schema);
    await admin`update app_table_exports set dirty_since = now() - interval '1 hour' where id = ${lost.linkId}`;
    await admin`update app_table_exports set dirty_since = now() where id = ${fresh.linkId}`;

    const dry = await exportsMod.syncDirtyAppTableExports({ dryRun: true });
    expect(dry.apps).toBeGreaterThanOrEqual(1);
    expect(await dirtyOf(lost.linkId)).toEqual(expect.any(Number));

    const r = await exportsMod.syncDirtyAppTableExports();
    expect(r.synced).toBeGreaterThanOrEqual(1);
    expect(await dirtyOf(lost.linkId)).toBeNull();
    expect(await dirtyOf(fresh.linkId)).toEqual(expect.any(Number));
    const [row] =
      await admin`select last_synced_at, last_error from app_table_exports where id = ${lost.linkId}`;
    expect(row!.last_error).toBeNull();
  });
});
