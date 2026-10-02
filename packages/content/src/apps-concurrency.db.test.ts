/**
 * The apps write paths on Postgres (apps audit 2026-10-02, Phase 0): two
 * writes in flight each keep their change (D5), a save on a draft that
 * changed since the editor read it is refused (U1), a schema version applies
 * once when two callers reach it together (D3), a lost database file is an
 * error (D1), and a delete removes the node before the file (D6). Seeds its
 * own owner and apps on random ids; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/apps-concurrency.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('apps write paths on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let apps: typeof import('./apps');
  let broker: typeof import('./app-broker');
  let dir = '';
  const owner = randomUUID();
  const tag = owner.slice(0, 8);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    dir = await mkdtemp(path.join(tmpdir(), 'apps-concurrency-db-'));
    process.env.APP_DB_DIR = dir;
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    apps = await import('./apps');
    broker = await import('./app-broker');
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`ac-${tag}@example.invalid`}, 'x', 'admin')`;
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

  const newApp = (title: string) => apps.createApp(owner, { title: `${tag} ${title}` });

  it('ten file writes in flight keep all ten files (D5)', async () => {
    const app = await newApp('files');
    const paths = Array.from({ length: 10 }, (_, i) => `part${i}.tsx`);
    await Promise.all(
      paths.map((p) => apps.writeDraftFile(owner, app.id, p, `export const x = '${p}';`)),
    );
    const detail = await apps.getApp(owner, app.id);
    for (const p of paths) expect(detail?.draft?.files[p], p).toContain(p);
  });

  it('a save on a draft that changed since it was read is refused (U1)', async () => {
    const app = await newApp('conflict');
    const source = { entry: 'App.tsx', files: { 'App.tsx': 'export default () => null;' } };
    // No draft yet: the editor read null.
    const first = await apps.saveDraftSource(owner, app.id, source, { baseDraftUpdatedAt: null });
    expect(first).toEqual({ draftUpdatedAt: expect.any(String) });
    if (!first) throw new Error('unreachable');
    // The assistant writes a file meanwhile.
    await apps.writeDraftFile(owner, app.id, 'More.tsx', 'export const y = 1;');
    await expect(
      apps.saveDraftSource(owner, app.id, source, { baseDraftUpdatedAt: first.draftUpdatedAt }),
    ).rejects.toBeInstanceOf(apps.AppDraftConflictError);
    // Nothing was written: the assistant's file is still there.
    const after = await apps.getApp(owner, app.id);
    expect(after?.draft?.files['More.tsx']).toBe('export const y = 1;');
    // With the stamp it reads now, the save goes through; without one, as before.
    expect(
      await apps.saveDraftSource(owner, app.id, source, {
        baseDraftUpdatedAt: after?.draftUpdatedAt ?? null,
      }),
    ).toBeTruthy();
    expect(await apps.saveDraftSource(owner, app.id, source)).toBeTruthy();
  });

  it('two callers reaching a new schema version together apply it once (D3)', async () => {
    const app = await newApp('schema');
    // A plain CREATE TABLE: run twice, it fails on "already exists".
    const schema = {
      schemaSql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);',
      schemaVersion: 1,
    };
    const regs = await Promise.all([
      broker.ensureAppDatabase(owner, app.id, schema),
      broker.ensureAppDatabase(owner, app.id, schema),
      broker.ensureAppDatabase(owner, app.id, schema),
    ]);
    expect(regs.map((r) => r.schemaVersion)).toEqual([1, 1, 1]);
    await broker.appDbExec(owner, app.id, 'INSERT INTO notes (body) VALUES (?)', ['hi'], schema);
    expect(await broker.appDbQuery(owner, app.id, 'SELECT body FROM notes', [], schema)).toEqual([
      { body: 'hi' },
    ]);
  });

  it('a lost file is an error, and a delete removes the node before the file (D1, D6)', async () => {
    const app = await newApp('lost');
    const schema = { schemaSql: 'CREATE TABLE IF NOT EXISTS t (x);', schemaVersion: 1 };
    await broker.appDbExec(owner, app.id, 'INSERT INTO t VALUES (1)', [], schema);
    const file = await broker.appDatabasePath(owner, app.id);
    expect(file && existsSync(file)).toBe(true);
    await broker.removeAppDatabaseFiles(file!);
    const quiet = console.error;
    console.error = () => {};
    try {
      await expect(
        broker.appDbQuery(owner, app.id, 'SELECT * FROM t', [], schema),
      ).rejects.toBeInstanceOf(broker.AppDbMissingError);
    } finally {
      console.error = quiet;
    }
    expect(existsSync(file!)).toBe(false);

    const other = await newApp('delete');
    await broker.appDbExec(owner, other.id, 'INSERT INTO t VALUES (1)', [], schema);
    const otherFile = (await broker.appDatabasePath(owner, other.id))!;
    expect(await apps.deleteApp(owner, other.id)).toBe(true);
    expect(await apps.getApp(owner, other.id)).toBeNull();
    expect(existsSync(otherFile)).toBe(false);
  });
});
