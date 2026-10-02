/**
 * App identity on Postgres (migration 0217): the per-app viewer salt is
 * created once and kept in app_databases.viewer_salt, so a person's id is
 * stable in one app across restarts and different in another app; names come
 * from the login row and the contact node, never an email; and a write
 * through the broker records the server-filled values. Seeds its own owner,
 * login, contact and two apps on random ids; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/app-viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('app identity on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let broker: typeof import('./app-broker');
  let viewer: typeof import('./app-viewer');
  let dir = '';
  const owner = randomUUID();
  const login = randomUUID();
  const contact = randomUUID();
  const appA = randomUUID();
  const appB = randomUUID();
  const tag = owner.slice(0, 8);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    dir = await mkdtemp(path.join(tmpdir(), 'app-viewer-db-'));
    process.env.APP_DB_DIR = dir;
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    broker = await import('./app-broker');
    viewer = await import('./app-viewer');
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`av-${tag}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
    await admin`insert into auth.users (id, email, password_hash, role, display_name) values
      (${login}, ${`av-m-${tag}@example.invalid`}, 'x', 'member', ${`${tag} Pat`})`;
    await admin`insert into nodes (id, owner_id, type, title, path) values
      (${appA}, ${owner}, 'app', 'review log', 'apps'),
      (${appB}, ${owner}, 'app', 'other app', 'apps'),
      (${contact}, ${owner}, 'contact', ${`${tag} Ann`}, 'contacts')`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from nodes where owner_id = ${owner}`;
    await admin`delete from spaces where login_id = ${owner}`;
    await admin`delete from auth.users where id in (${owner}, ${login})`;
    await m.closeDb();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const salt = async (app: string) =>
    (
      await admin<{ s: string | null }[]>`
        select viewer_salt as s from app_databases where app_node_id = ${app}`
    )[0]?.s ?? null;

  it('creates one salt per app, keeps it, and names the login without its email', async () => {
    const first = await broker.appViewerFor(owner, appA, { kind: 'member', loginId: login });
    expect(first).toEqual({ id: expect.stringMatching(/^u_/), name: `${tag} Pat`, kind: 'member' });
    expect(JSON.stringify(first)).not.toContain('example.invalid');
    const stored = await salt(appA);
    expect(stored).toBeTruthy();
    expect(first.id).toBe(viewer.appViewerPseudonym(stored!, `login:${login}`));

    // A restart (no cache) reads the same salt: the id does not move.
    viewer.__resetAppViewerSaltCache();
    expect((await broker.appViewerFor(owner, appA, { kind: 'admin', loginId: login })).id).toBe(
      first.id,
    );
    expect(await salt(appA)).toBe(stored);

    // Another app: another salt, another id for the same person.
    const other = await broker.appViewerFor(owner, appB, { kind: 'member', loginId: login });
    expect(other.id).not.toBe(first.id);
    expect(await salt(appB)).not.toBe(stored);
  });

  it('names a contact from the contact node', async () => {
    expect(await broker.appViewerFor(owner, appA, { kind: 'contact', contactId: contact })).toEqual(
      {
        id: viewer.appViewerPseudonym((await salt(appA))!, `contact:${contact}`),
        name: `${tag} Ann`,
        kind: 'contact',
      },
    );
  });

  it('a broker write records the server-filled values', async () => {
    await broker.appDbExec(
      owner,
      appA,
      'CREATE TABLE IF NOT EXISTS log (by_id TEXT, by_name TEXT, by_kind TEXT, what TEXT)',
    );
    await broker.appDbExec(
      owner,
      appA,
      'INSERT INTO log VALUES (:host_me_id, :host_me_name, :host_me_kind, ?)',
      ['approved'],
      undefined,
      { viewer: { kind: 'member', loginId: login, name: `${tag} Pat` } },
    );
    const rows = await broker.appDbQuery(owner, appA, 'SELECT * FROM log');
    expect(rows).toEqual([
      {
        by_id: viewer.appViewerPseudonym((await salt(appA))!, `login:${login}`),
        by_name: `${tag} Pat`,
        by_kind: 'member',
        what: 'approved',
      },
    ]);
  });
});
