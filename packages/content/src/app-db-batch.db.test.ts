/**
 * host.db.batch through the store broker on Postgres: the registry row, the
 * checked statement, the viewer fill, the text checks, a restore, and the size.
 * The transaction on its own is app-sql-batch.test.ts.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/app-db-batch.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { APP_BUILD_RULES } from '@mantle/db';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const viewerLookups = vi.hoisted(() => ({ n: 0 }));
vi.mock('./app-viewer', async (importOriginal) => {
  const real = await importOriginal<typeof import('./app-viewer')>();
  return {
    ...real,
    resolveAppViewer: async (...args: Parameters<typeof real.resolveAppViewer>) => {
      viewerLookups.n += 1;
      return real.resolveAppViewer(...args);
    },
  };
});

// What the next database transaction does, for a restore's flip: `db` is a
// proxy with no property to spy on.
type Transaction = (fn: never) => Promise<unknown>;
const flipHook = vi.hoisted(() => ({
  how: null as null | ((real: (fn: never) => Promise<unknown>, fn: never) => Promise<unknown>),
}));
vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  return {
    ...real,
    db: new Proxy(real.db, {
      get(target, key) {
        const how = flipHook.how;
        if (key !== 'transaction' || !how) return Reflect.get(target, key);
        flipHook.how = null;
        const transaction = target.transaction.bind(target) as unknown as Transaction;
        return (fn: never) => how(transaction, fn);
      },
    }),
  };
});

describe.skipIf(!URL)('host.db.batch through the broker', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let apps: typeof import('./apps');
  let broker: typeof import('./app-broker');
  let writer: typeof import('./app-db-write');
  let runner: typeof import('./app-sql-runner');
  let snaps: typeof import('./app-snapshots');
  let dir = '';
  const owner = randomUUID();
  const tag = owner.slice(0, 8);
  const schema = {
    schemaSql:
      'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, by_id TEXT, by_name TEXT);',
    schemaVersion: 1,
  };
  const GREEN = {
    storageKey: 'attachments/aa/bb/test',
    sha256: 'test',
    builtAt: '2026-11-06T00:00:00.000Z',
    esbuildVersion: 'test',
    bytes: 1,
    ok: true,
    rules: APP_BUILD_RULES,
  };
  const st = (sql: string, ...params: unknown[]) => ({ sql, params });
  const member = { kind: 'member' as const, loginId: randomUUID(), name: 'Pat' };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    dir = await mkdtemp(path.join(tmpdir(), 'app-db-batch-'));
    process.env.APP_DB_DIR = dir;
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    apps = await import('./apps');
    broker = await import('./app-broker');
    writer = await import('./app-db-write');
    runner = await import('./app-sql-runner');
    snaps = await import('./app-snapshots');
    await asSuperuser()`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`adb-${tag}@example.invalid`}, 'x', 'admin')`;
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

  const newApp = async (title: string) => {
    const app = await apps.createApp(owner, { title: `${tag} ${title}` });
    await apps.writeDraftFile(owner, app.id, 'App.tsx', 'export default () => "one";');
    await apps.setManifest(owner, app.id, { sqlite: schema });
    await apps.setDraftBuild(owner, app.id, GREEN);
    await apps.publishApp(owner, app.id, { note: 'first', actor: 'owner' });
    return app.id;
  };
  const names = async (id: string) =>
    (await broker.appDbQuery(owner, id, 'SELECT name FROM items ORDER BY id', [], schema)).map(
      (r) => r.name,
    );
  const registry = async (id: string) =>
    (
      await admin<{ write_seq: string; size_bytes: string; storage_path: string }[]>`
        select write_seq, size_bytes, storage_path from app_databases where app_node_id = ${id}`
    )[0]!;

  it('runs all of it, bumps the revision once and keeps the size true', async () => {
    const id = await newApp('whole');
    await broker.appDbQuery(owner, id, 'SELECT 1', [], schema);
    const before = Number((await registry(id)).write_seq);
    const res = await broker.appDbBatch(
      owner,
      id,
      {
        statements: [
          st('INSERT INTO items (name) VALUES (?)', 'a'),
          st("INSERT INTO items (name) VALUES ('b')"),
        ],
      },
      schema,
    );
    expect(res).toEqual({ changes: [1, 1] });
    expect(await names(id)).toEqual(['a', 'b']);
    const reg = await registry(id);
    expect(Number(reg.size_bytes)).toBeGreaterThan(0);
    expect(Number(reg.write_seq)).toBe(before + 1);
  });

  it('a failed statement leaves nothing, and the revision only one higher', async () => {
    const id = await newApp('fail');
    await broker.appDbExec(owner, id, "INSERT INTO items (name) VALUES ('kept')", [], schema);
    const before = Number((await registry(id)).write_seq);
    await expect(
      broker.appDbBatch(
        owner,
        id,
        {
          statements: [
            st("INSERT INTO items (name) VALUES ('x')"),
            st('INSERT INTO nope VALUES (1)'),
          ],
        },
        schema,
      ),
    ).rejects.toThrow(/^statement 2 of 2: no such table: nope$/);
    expect(await names(id)).toEqual(['kept']);
    expect(Number((await registry(id)).write_seq)).toBe(before + 1);
  });

  it('a guard with no row leaves nothing', async () => {
    const id = await newApp('guard');
    await expect(
      broker.appDbBatch(
        owner,
        id,
        {
          statements: [st("INSERT INTO items (name) VALUES ('x')")],
          guard: st('SELECT 1 FROM items WHERE name = ?', 'absent'),
        },
        schema,
      ),
    ).rejects.toBeInstanceOf(broker.AppDbGuardError);
    expect(await names(id)).toEqual([]);
  });

  describe('text', () => {
    it.each([
      ['a second statement', "INSERT INTO items (name) VALUES ('x'); DELETE FROM items"],
      [
        'a tail behind an apostrophe in a comment',
        "INSERT INTO items (name) VALUES ('x') -- it's\n; DELETE FROM items",
      ],
      [
        'a tail behind a block comment',
        "INSERT INTO items (name) VALUES ('x') /* it's */ ; DELETE FROM items",
      ],
    ])('%s is refused for Admin too, and nothing stays', async (_name, sql) => {
      const id = await newApp(`tail ${_name}`);
      await expect(
        broker.appDbBatch(
          owner,
          id,
          { statements: [st("INSERT INTO items (name) VALUES ('a')"), st(sql)] },
          schema,
        ),
      ).rejects.toThrow(/^statement 2 of 2: one statement per entry/);
      expect(await names(id)).toEqual([]);
    });

    it('a semicolon in a string, a closing semicolon and a closing comment pass', async () => {
      const id = await newApp('no tail');
      await broker.appDbBatch(
        owner,
        id,
        {
          statements: [
            st("INSERT INTO items (name) VALUES ('a;b');"),
            st("INSERT INTO items (name) VALUES ('c') ; -- done\n"),
            st("INSERT INTO items (name) VALUES ('d') /* it's done */ ;;"),
          ],
        },
        schema,
      );
      expect(await names(id)).toEqual(['a;b', 'c', 'd']);
    });

    it.each([
      'ATTACH DATABASE ? AS x',
      'DETACH DATABASE x',
      'VACUUM',
      'PRAGMA journal_mode = DELETE',
    ])('%s stops at the text check, with its place', async (sql) => {
      const id = await newApp(`safe ${sql}`);
      await expect(
        broker.appDbBatch(owner, id, { statements: [st('SELECT 1'), st(sql)] }, schema),
      ).rejects.toThrow(/^statement 2 of 2: statement not allowed/);
    });

    it.each(['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT s', 'PRAGMA table_info(items)'])(
      '%s stops at the engine for Admin too, and nothing stays',
      async (sql) => {
        const id = await newApp(`tx ${sql}`);
        await expect(
          broker.appDbBatch(
            owner,
            id,
            { statements: [st("INSERT INTO items (name) VALUES ('a')"), st(sql)] },
            schema,
          ),
        ).rejects.toThrow(/^statement 2 of 2: not authorized/);
        expect(await names(id)).toEqual([]);
      },
    );

    it('a guard is held to the same text checks', async () => {
      const id = await newApp('guard text');
      await expect(
        broker.appDbBatch(
          owner,
          id,
          { statements: [st('SELECT 1')], guard: st('SELECT 1; DELETE FROM items') },
          schema,
        ),
      ).rejects.toThrow(/^guard: one statement per entry/);
      await expect(
        broker.appDbBatch(
          owner,
          id,
          { statements: [st('SELECT 1')], guard: st('PRAGMA user_version') },
          schema,
        ),
      ).rejects.toThrow(/^guard: statement not allowed/);
    });
  });

  describe(':host_me_*', () => {
    it('fills every statement and the guard, from one lookup of the viewer', async () => {
      const id = await newApp('me');
      const caller = { viewer: member };
      viewerLookups.n = 0;
      await broker.appDbBatch(
        owner,
        id,
        {
          statements: [
            st(
              'INSERT INTO items (name, by_id, by_name) VALUES (?, :host_me_id, :host_me_name)',
              'a',
            ),
            st(
              'INSERT INTO items (name, by_id, by_name) VALUES (?, :host_me_id, :host_me_name)',
              'b',
            ),
          ],
          guard: st('SELECT :host_me_id IS NOT NULL'),
        },
        schema,
        caller,
      );
      expect(viewerLookups.n).toBe(1);
      const rows = await broker.appDbQuery(
        owner,
        id,
        'SELECT by_id, by_name FROM items',
        [],
        schema,
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]!.by_name).toBe('Pat');
      expect(String(rows[0]!.by_id)).toMatch(/^u_/);
      expect(rows[1]!.by_id).toBe(rows[0]!.by_id);
    });

    it('a value the browser sends is refused, with its place, and nothing stays', async () => {
      const id = await newApp('me refused');
      await expect(
        broker.appDbBatch(
          owner,
          id,
          {
            statements: [
              st("INSERT INTO items (name) VALUES ('a')"),
              st('INSERT INTO items (by_id) VALUES (:host_me_id)', { ':host_me_id': 'forged' }),
            ],
          },
          schema,
          { viewer: member },
        ),
      ).rejects.toThrow(/^statement 2 of 2: parameters starting with host_me_/);
      expect(await names(id)).toEqual([]);
    });

    it('with no viewer, a reserved name is refused', async () => {
      const id = await newApp('me none');
      await expect(
        broker.appDbBatch(
          owner,
          id,
          { statements: [st('SELECT 1')], guard: st('SELECT :host_me_id') },
          schema,
        ),
      ).rejects.toThrow(/^guard: :host_me_\* parameters are filled only/);
    });
  });

  describe('a restore', () => {
    const live = async (id: string) => (await broker.appDatabasePath(owner, id))!;
    const seeded = async (name: string) => {
      const id = await newApp(name);
      await broker.appDbExec(owner, id, "INSERT INTO items (name) VALUES ('before')", [], schema);
      return id;
    };

    it('a batch during one answers busy, and nothing lands', async () => {
      const id = await seeded('restoring');
      const snap = (await snaps.createAppSnapshot(owner, id))!;
      const file = (await snaps.appSnapshotFile(owner, id, snap.id))!.path;
      const restoring = broker.restoreAppDatabaseFile(owner, id, file, schema.schemaVersion, {
        drainMs: 400,
      });
      await new Promise((r) => setTimeout(r, 100));
      await expect(
        broker.appDbBatch(
          owner,
          id,
          { statements: [st("INSERT INTO items (name) VALUES ('x')")] },
          schema,
        ),
      ).rejects.toBeInstanceOf(broker.AppSqlBusyError);
      await restoring;
      expect(await names(id)).toEqual(['before']);
    });

    it('after a flip a write that read the old row answers busy and leaves the old file alone: batch and exec', async () => {
      const id = await seeded('flip');
      const oldFile = await live(id);
      const snap = (await snaps.createAppSnapshot(owner, id))!;
      const file = (await snaps.appSnapshotFile(owner, id, snap.id))!.path;
      await broker.restoreAppDatabaseFile(owner, id, file, schema.schemaVersion, { drainMs: 0 });
      const newFile = await live(id);
      expect(newFile).not.toBe(oldFile);
      expect(existsSync(`${oldFile}.restoring`)).toBe(true);
      await expect(
        runner.runAppDataBatch(oldFile, [st("INSERT INTO items (name) VALUES ('stale')")]),
      ).rejects.toBeInstanceOf(runner.AppDbRestoringError);
      await expect(
        runner.runAppSql(oldFile, {
          sql: "INSERT INTO items (name) VALUES ('stale')",
          mode: 'run',
          readOnly: false,
        }),
      ).rejects.toBeInstanceOf(runner.AppDbRestoringError);
      // The new file takes writes: its path has no marker.
      await broker.appDbBatch(
        owner,
        id,
        { statements: [st("INSERT INTO items (name) VALUES ('after')")] },
        schema,
      );
      expect(await names(id)).toEqual(['before', 'after']);
    });

    it('a flip an outer transaction rolls back takes its marker away too', async () => {
      const id = await seeded('flip rolled back');
      const oldFile = await live(id);
      const snap = (await snaps.createAppSnapshot(owner, id))!;
      const file = (await snaps.appSnapshotFile(owner, id, snap.id))!.path;
      await expect(
        m.withSystemTx(async () => {
          await broker.restoreAppDatabaseFile(owner, id, file, schema.schemaVersion, {
            drainMs: 0,
          });
          throw new Error('a later step failed');
        }),
      ).rejects.toThrow('a later step failed');
      // The row still names the old file, and that file runs again.
      expect(await live(id)).toBe(oldFile);
      expect(existsSync(`${oldFile}.restoring`)).toBe(false);
      expect(await names(id)).toEqual(['before']);
    });

    // What the flip's transaction can do, on a real restore.
    const flipWith = async (id: string, how: NonNullable<typeof flipHook.how>) => {
      const snap = (await snaps.createAppSnapshot(owner, id))!;
      const file = (await snaps.appSnapshotFile(owner, id, snap.id))!.path;
      flipHook.how = how;
      try {
        await expect(
          broker.restoreAppDatabaseFile(owner, id, file, schema.schemaVersion, { drainMs: 0 }),
        ).rejects.toThrow();
      } finally {
        flipHook.how = null;
      }
    };

    it('a flip whose commit landed and whose reply was lost keeps its marker on the old file', async () => {
      const id = await seeded('flip landed');
      const oldFile = await live(id);
      await flipWith(id, async (real, fn) => {
        await real(fn);
        throw new Error('the connection dropped after the commit');
      });
      expect(await live(id)).not.toBe(oldFile);
      expect(existsSync(`${oldFile}.restoring`)).toBe(true);
      await expect(
        runner.runAppDataBatch(oldFile, [st("INSERT INTO items (name) VALUES ('stale')")]),
      ).rejects.toBeInstanceOf(runner.AppDbRestoringError);
    });

    it('a flip that never started takes its marker away', async () => {
      const id = await seeded('flip never');
      const oldFile = await live(id);
      await flipWith(id, async () => {
        throw new Error('no connection');
      });
      expect(await live(id)).toBe(oldFile);
      expect(existsSync(`${oldFile}.restoring`)).toBe(false);
    });

    it('a flip the database refused takes its marker away', async () => {
      const id = await seeded('flip refused');
      const oldFile = await live(id);
      await flipWith(id, (real, fn) =>
        real((async (tx: object) => {
          const refusing = new Proxy(tx, {
            get: (t, k) =>
              k === 'update'
                ? () => {
                    throw new Error('refused');
                  }
                : Reflect.get(t, k),
          });
          await (fn as (x: unknown) => Promise<unknown>)(refusing);
        }) as never),
      );
      expect(await live(id)).toBe(oldFile);
      expect(existsSync(`${oldFile}.restoring`)).toBe(false);
      await broker.appDbBatch(
        owner,
        id,
        { statements: [st("INSERT INTO items (name) VALUES ('after')")] },
        schema,
      );
      expect(await names(id)).toEqual(['before', 'after']);
    });

    it('a stage that fails before the flip takes its marker away, and the app runs on', async () => {
      const id = await seeded('flip fails');
      const oldFile = await live(id);
      await expect(
        broker.restoreAppDatabaseFile(
          owner,
          id,
          path.join(dir, 'no-such-snapshot'),
          schema.schemaVersion,
          {
            drainMs: 0,
          },
        ),
      ).rejects.toThrow();
      expect(existsSync(`${oldFile}.restoring`)).toBe(false);
      await broker.appDbBatch(
        owner,
        id,
        { statements: [st("INSERT INTO items (name) VALUES ('after')")] },
        schema,
      );
      expect(await names(id)).toEqual(['before', 'after']);
    });
  });

  describe('the write path', () => {
    const exportsMod = () => import('./app-table-exports');
    const dirty = async (id: string, table: string) =>
      (
        await admin<{ dirty_since: Date | null; last_write_at: Date | null }[]>`
          select dirty_since, last_write_at from app_table_exports
           where app_node_id = ${id} and sqlite_table = ${table}`
      )[0];

    const clientWrittenAt = async (id: string) =>
      (
        await admin<{ at: Date | null }[]>`
          select client_written_at as at from app_databases where app_node_id = ${id}`
      )[0]?.at;

    it('a first write from outside marks the app, with no registry row before it', async () => {
      const id = await newApp('outside first');
      expect(await registry(id)).toBeUndefined();
      await writer.appDbBatchWrite(
        owner,
        id,
        { statements: [st("INSERT INTO items (name) VALUES ('a')")] },
        schema,
        {},
        { outside: true },
      );
      expect(await clientWrittenAt(id)).not.toBeNull();
      expect(await names(id)).toEqual(['a']);
    });

    it('marks the write from outside first, even when the batch fails', async () => {
      const id = await newApp('outside');
      await expect(
        writer.appDbBatchWrite(
          owner,
          id,
          { statements: [st('INSERT INTO nope VALUES (1)')] },
          schema,
          {},
          { outside: true },
        ),
      ).rejects.toThrow(/statement 1 of 1/);
      expect(await clientWrittenAt(id)).not.toBeNull();
    });

    it('stamps its exports dirty on a write, and not on a guard refusal', async () => {
      const id = await newApp('sync');
      await broker.appDbExec(owner, id, "INSERT INTO items (name) VALUES ('seed')", [], schema);
      await (await exportsMod()).createAppTableExport(owner, id, 'items');
      await admin`update app_table_exports set dirty_since = null, last_write_at = null
                   where app_node_id = ${id}`;
      await expect(
        writer.appDbBatchWrite(
          owner,
          id,
          { statements: [st('SELECT 1')], guard: st('SELECT 0') },
          schema,
        ),
      ).rejects.toBeInstanceOf(broker.AppDbGuardError);
      await new Promise((r) => setTimeout(r, 200));
      expect((await dirty(id, 'items'))?.dirty_since).toBeNull();

      await writer.appDbBatchWrite(
        owner,
        id,
        { statements: [st("INSERT INTO items (name) VALUES ('a')")] },
        schema,
      );
      await vi.waitFor(async () => expect((await dirty(id, 'items'))?.dirty_since).not.toBeNull(), {
        timeout: 5_000,
        interval: 50,
      });
    });

    it('stamps its exports dirty on a failed call too: it cannot always tell that nothing landed', async () => {
      const id = await newApp('sync on fail');
      await broker.appDbExec(owner, id, "INSERT INTO items (name) VALUES ('seed')", [], schema);
      await (await exportsMod()).createAppTableExport(owner, id, 'items');
      await admin`update app_table_exports set dirty_since = null, last_write_at = null
                   where app_node_id = ${id}`;
      await expect(
        writer.appDbBatchWrite(
          owner,
          id,
          { statements: [st('INSERT INTO nope VALUES (1)')] },
          schema,
        ),
      ).rejects.toThrow(/statement 1 of 1/);
      await vi.waitFor(async () => expect((await dirty(id, 'items'))?.dirty_since).not.toBeNull(), {
        timeout: 5_000,
        interval: 50,
      });
    });
  });
});
