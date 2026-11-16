/**
 * What a picture of an app (app_render) reads, on Postgres and a real SQLite
 * file: appViewerPeek and appDbReadQuery with a person create nothing (no
 * registry row, no salt, no file), fill `:host_me_*` as the live app does
 * once it has a salt, and no SQL sent as a query changes a row. Seeds its own
 * owner, login and two apps on random ids; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/content/src/app-render-read.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('a picture of an app reads and makes nothing', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let broker: typeof import('./app-broker');
  let dir = '';
  const owner = randomUUID();
  const login = randomUUID();
  const fresh = randomUUID();
  const used = randomUUID();
  const tag = owner.slice(0, 8);
  const me = { kind: 'member' as const, loginId: login };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-render-test-key';
    dir = await mkdtemp(path.join(tmpdir(), 'app-render-read-'));
    process.env.APP_DB_DIR = dir;
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    broker = await import('./app-broker');
    await asSuperuser()`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`ar-${tag}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
    await asSuperuser()`insert into auth.users (id, email, password_hash, role, display_name) values
      (${login}, ${`ar-m-${tag}@example.invalid`}, 'x', 'member', ${`${tag} Pat`})`;
    await admin`insert into nodes (id, owner_id, type, title, path) values
      (${fresh}, ${owner}, 'app', 'never opened', 'apps'),
      (${used}, ${owner}, 'app', 'in use', 'apps')`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from nodes where owner_id = ${owner}`;
    await admin`delete from spaces where login_id = ${owner}`;
    await admin`delete from auth.users where id in (${owner}, ${login})`;
    await m.closeDb();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const registry = async (app: string) =>
    admin<
      { s: string | null }[]
    >`select viewer_salt as s from app_databases where app_node_id = ${app}`;

  it('an app never opened: no id, no rows, and no registry row or file made', async () => {
    expect(await broker.appViewerPeek(owner, fresh, me)).toEqual({
      id: null,
      name: `${tag} Pat`,
      kind: 'member',
    });
    expect(
      await broker.appDbReadQuery(owner, fresh, 'SELECT :host_me_id AS who', [], { viewer: me }),
    ).toEqual({ rows: [], empty: true });
    expect(await registry(fresh)).toEqual([]);
    expect(await readdir(dir, { recursive: true })).toEqual([]);
  });

  it('an app in use: the same id as the live app, rows as the person, and no write', async () => {
    const live = await broker.appViewerFor(owner, used, me);
    await broker.appDbExec(owner, used, 'CREATE TABLE t (who TEXT, what TEXT)');
    await broker.appDbExec(
      owner,
      used,
      'INSERT INTO t VALUES (:host_me_id, ?), (?, ?)',
      ['mine', 'u_other', 'theirs'],
      undefined,
      {
        viewer: me,
      },
    );
    const [before] = await registry(used);

    const peek = await broker.appViewerPeek(owner, used, me);
    expect(peek).toEqual(live);
    const mine = await broker.appDbReadQuery(
      owner,
      used,
      'SELECT what FROM t WHERE who = :host_me_id',
      [],
      { viewer: me, callerKey: `member:${login}` },
    );
    expect(mine).toEqual({ rows: [{ what: 'mine' }], empty: false });

    // A query never writes, whatever its SQL says.
    for (const sql of [
      'DELETE FROM t',
      "INSERT INTO t VALUES ('x', 'y')",
      "INSERT INTO t VALUES ('x', 'y') RETURNING *",
      "UPDATE t SET what = 'z' RETURNING what",
      'DROP TABLE t',
      'CREATE TABLE u (a)',
    ]) {
      await expect(
        broker.appDbReadQuery(owner, used, sql, [], { viewer: me }),
        sql,
      ).rejects.toThrow();
    }
    expect(
      (await broker.appDbReadQuery(owner, used, 'SELECT what FROM t ORDER BY what')).rows,
    ).toEqual([{ what: 'mine' }, { what: 'theirs' }]);
    // A value the app sends for a reserved name is refused.
    await expect(
      broker.appDbReadQuery(owner, used, 'SELECT ?', [{ host_me_id: 'u_forged' }], { viewer: me }),
    ).rejects.toThrow(/filled by the host/);
    expect(await registry(used)).toEqual([before]);
  });
});
