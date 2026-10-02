/**
 * App history on Postgres (apps snapshots, Phase 2; migration 0219): publish
 * appends a version; a snapshot keeps the code and a copy of the database;
 * restore puts back the code (draft), the data, or both (live), always after
 * an undo snapshot; a version holds no data and cannot be deleted; the
 * automatic snapshots are pruned, the owner's are not; a restore marker
 * stops the app's SQL while the file is swapped. Seeds its own owner and
 * apps on random ids; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/app-snapshots.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('app history on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let apps: typeof import('./apps');
  let broker: typeof import('./app-broker');
  let snaps: typeof import('./app-snapshots');
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
    dir = await mkdtemp(path.join(tmpdir(), 'app-snapshots-db-'));
    process.env.APP_DB_DIR = dir;
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    apps = await import('./apps');
    broker = await import('./app-broker');
    snaps = await import('./app-snapshots');
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`as-${tag}@example.invalid`}, 'x', 'admin')`;
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

  /** An app with v1 published ("one") and one row in its database. */
  async function publishedApp(title: string) {
    const app = await apps.createApp(owner, { title: `${tag} ${title}` });
    await apps.writeDraftFile(owner, app.id, 'App.tsx', 'export default () => "one";');
    await apps.setManifest(owner, app.id, { sqlite: schema });
    await apps.setDraftBuild(owner, app.id, GREEN);
    await apps.publishApp(owner, app.id, { note: 'first', actor: 'owner' });
    await broker.appDbExec(owner, app.id, "INSERT INTO items (name) VALUES ('a')", [], schema);
    return app.id;
  }
  const names = async (id: string) =>
    (await broker.appDbQuery(owner, id, 'SELECT name FROM items ORDER BY id', [], schema)).map(
      (r) => r.name,
    );

  it('publish appends a version; a snapshot keeps the code and the data', async () => {
    const id = await publishedApp('timeline');
    const snap = await snaps.createAppSnapshot(owner, id, { note: 'safe point' });
    expect(snap).toMatchObject({ seq: 2, kind: 'snapshot', hasData: true, note: 'safe point' });
    const list = await snaps.listAppSnapshots(owner, id);
    expect(list.map((e) => [e.seq, e.kind, e.trigger])).toEqual([
      [2, 'snapshot', 'manual'],
      [1, 'version', 'publish'],
    ]);
    expect(list[1]).toMatchObject({ note: 'first', hasData: false, fileCount: 1 });
    const file = await snaps.appSnapshotFile(owner, id, snap!.id);
    expect(file && existsSync(file.path)).toBe(true);
  });

  it('restores the data, after an undo snapshot that can restore it back', async () => {
    const id = await publishedApp('data');
    const before = await snaps.createAppSnapshot(owner, id);
    await broker.appDbExec(owner, id, "INSERT INTO items (name) VALUES ('b')", [], schema);
    expect(await names(id)).toEqual(['a', 'b']);

    const res = await snaps.restoreAppSnapshot(owner, id, before!.id, { mode: 'data', drainMs: 0 });
    expect(res).toMatchObject({ mode: 'data', code: null });
    expect(await names(id)).toEqual(['a']);

    // The undo snapshot holds the 'b' row: restoring it brings it back.
    await snaps.restoreAppSnapshot(owner, id, res!.undo!.id, { mode: 'data', drainMs: 0 });
    expect(await names(id)).toEqual(['a', 'b']);
  });

  it('a code restore goes to the draft, and the next publish says where it came from', async () => {
    const id = await publishedApp('code');
    await apps.writeDraftFile(owner, id, 'App.tsx', 'export default () => "two";');
    await apps.setDraftBuild(owner, id, GREEN);
    await apps.publishApp(owner, id);
    const v1 = (await snaps.listAppSnapshots(owner, id)).find((e) => e.seq === 1)!;

    await apps.writeDraftFile(owner, id, 'App.tsx', 'export default () => "wip";');
    await expect(
      snaps.restoreAppSnapshot(owner, id, v1.id, { mode: 'code', drainMs: 0 }),
    ).rejects.toBeInstanceOf(apps.AppRestoreDraftError);

    const res = await snaps.restoreAppSnapshot(owner, id, v1.id, {
      mode: 'code',
      discardDraft: true,
      drainMs: 0,
    });
    expect(res?.code).toBe('draft');
    const detail = await apps.getApp(owner, id);
    expect(detail?.draft?.files['App.tsx']).toContain('"one"');
    expect(detail?.source.files['App.tsx']).toContain('"two"');

    await apps.setDraftBuild(owner, id, GREEN);
    await apps.publishApp(owner, id);
    const top = (await snaps.listAppSnapshots(owner, id))[0]!;
    expect(top).toMatchObject({ kind: 'version', restoredFrom: 1 });
  });

  it('a full restore puts the code live with the data, as a new version', async () => {
    const id = await publishedApp('full');
    const snap = await snaps.createAppSnapshot(owner, id);
    await apps.writeDraftFile(owner, id, 'App.tsx', 'export default () => "two";');
    await apps.setDraftBuild(owner, id, GREEN);
    await apps.publishApp(owner, id);
    await broker.appDbExec(owner, id, "INSERT INTO items (name) VALUES ('c')", [], schema);

    const res = await snaps.restoreAppSnapshot(owner, id, snap!.id, { mode: 'full', drainMs: 0 });
    expect(res?.code).toBe('live');
    expect((await apps.getApp(owner, id))?.source.files['App.tsx']).toContain('"one"');
    expect(await names(id)).toEqual(['a']);
    const top = (await snaps.listAppSnapshots(owner, id))[0]!;
    expect(top).toMatchObject({
      kind: 'version',
      restoredFrom: snap!.seq,
      note: `restored v${snap!.seq}`,
    });
  });

  it('refuses a data restore from a version, and deleting a version', async () => {
    const id = await publishedApp('refusals');
    const v1 = (await snaps.listAppSnapshots(owner, id))[0]!;
    await expect(
      snaps.restoreAppSnapshot(owner, id, v1.id, { mode: 'data', drainMs: 0 }),
    ).rejects.toThrow(/holds no data/);
    await expect(snaps.deleteAppSnapshot(owner, id, v1.id)).rejects.toThrow(/stays/);
    const snap = await snaps.createAppSnapshot(owner, id);
    const file = (await snaps.appSnapshotFile(owner, id, snap!.id))!.path;
    expect(await snaps.deleteAppSnapshot(owner, id, snap!.id)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('keeps the newest automatic snapshots only; the owner’s stay', async () => {
    const id = await publishedApp('prune');
    const mine = await snaps.createAppSnapshot(owner, id, { note: 'mine' });
    for (let i = 0; i < snaps.APP_SNAPSHOT_AUTO_KEEP + 2; i++) {
      await snaps.createAppSnapshot(owner, id, { trigger: 'pre_schema', actor: 'agent' });
    }
    const list = await snaps.listAppSnapshots(owner, id, { limit: 500 });
    expect(list.filter((e) => e.trigger === 'pre_schema')).toHaveLength(
      snaps.APP_SNAPSHOT_AUTO_KEEP,
    );
    expect(list.some((e) => e.id === mine!.id)).toBe(true);
    // requireData: an app with no database file yet takes no automatic one.
    const empty = await apps.createApp(owner, { title: `${tag} empty` });
    expect(
      await snaps.createAppSnapshot(owner, empty.id, { trigger: 'pre_schema', requireData: true }),
    ).toBeNull();
  });

  it('a fresh restore marker stops the app’s SQL; a stale one is ignored', async () => {
    const id = await publishedApp('marker');
    const live = (await broker.appDatabasePath(owner, id))!;
    await writeFile(`${live}.restoring`, 'x');
    await expect(broker.appDbQuery(owner, id, 'SELECT 1', [], schema)).rejects.toBeInstanceOf(
      broker.AppDbRestoringError,
    );
    const { utimes } = await import('node:fs/promises');
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(`${live}.restoring`, old, old);
    expect(await names(id)).toEqual(['a']);
    expect(existsSync(`${live}.restoring`)).toBe(false);
  });

  it('deleting the app removes its snapshot files', async () => {
    const id = await publishedApp('gone');
    const snap = await snaps.createAppSnapshot(owner, id);
    const file = (await snaps.appSnapshotFile(owner, id, snap!.id))!.path;
    await apps.deleteApp(owner, id);
    expect(existsSync(file)).toBe(false);
    expect(await snaps.listAppSnapshots(owner, id)).toEqual([]);
  });
});
