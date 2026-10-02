import { describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  AppDbMissingError,
  appDbExec,
  appDbQuery,
  appDbReadQuery,
  checkAppSchemaScript,
  ensureAppDatabase,
  assertSafe,
  assertSafeScript,
  appDbFiles,
  planSeedStatements,
  snapshotDestPath,
} from './app-broker';
import { APP_SCHEMA_TIMEOUT_MS, runAppSql } from './app-sql-runner';

const h = vi.hoisted(() => ({
  storagePath: '',
  timeoutMs: undefined as number | undefined,
  registryRow: null as null | {
    id: string;
    storagePath: string;
    schemaVersion: number;
    sizeBytes: number;
  },
}));

/** The real runner, watched: the schema tests check the DDL goes through it
 *  (not a main-thread exec), and shorten its time limit for the endless case. */
vi.mock('./app-sql-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./app-sql-runner')>();
  return {
    ...actual,
    runAppSql: vi.fn((file: string, opts: Parameters<typeof actual.runAppSql>[1]) =>
      actual.runAppSql(file, { ...opts, timeoutMs: h.timeoutMs ?? opts.timeoutMs }),
    ),
  };
});

/** Minimal registry: one app whose SQLite file lives in a temp dir. Everything
 *  appDbQuery/appDbExec need from Postgres is the existing-row lookup (plus the
 *  best-effort size update), so the mock keeps the whole test on-disk-only. */
vi.mock('@mantle/db', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'app-broker-ro-'));
  h.storagePath = path.join(dir, 'app.sqlite');
  const registryRow = { id: 'reg-1', storagePath: h.storagePath, schemaVersion: 0, sizeBytes: 0 };
  h.registryRow = registryRow;
  const update = () => ({ set: () => ({ where: async () => undefined }) });
  return {
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [registryRow] }) }) }),
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
      update,
      // The schema applier's row lock (apps audit D3).
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          select: () => ({ from: () => ({ where: () => ({ for: async () => [registryRow] }) }) }),
          update,
        }),
    },
    nodes: {},
    appDatabases: {},
  };
});

/**
 * `assertSafe` is the runtime guard on SQL a sandboxed mini app sends through
 * the db-broker. It must reject the statements that let SQLite reach beyond its
 * own file (ATTACH/DETACH, PRAGMA, `VACUUM INTO`) and allow ordinary CRUD.
 */
describe('assertSafe', () => {
  it('allows ordinary CRUD statements', () => {
    expect(() => assertSafe('SELECT * FROM cities')).not.toThrow();
    expect(() => assertSafe('INSERT INTO cities (name) VALUES (?)')).not.toThrow();
    expect(() => assertSafe('UPDATE cities SET name = ? WHERE id = ?')).not.toThrow();
    expect(() => assertSafe('DELETE FROM cities WHERE id = ?')).not.toThrow();
    expect(() => assertSafe('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)')).not.toThrow();
  });

  it('blocks ATTACH / DETACH (cross-database file escape)', () => {
    expect(() => assertSafe("ATTACH DATABASE '/etc/passwd' AS x")).toThrow(/not allowed/i);
    expect(() => assertSafe('DETACH DATABASE x')).toThrow(/not allowed/i);
  });

  it('blocks PRAGMA and `VACUUM INTO`', () => {
    expect(() => assertSafe('PRAGMA journal_mode = WAL')).toThrow(/not allowed/i);
    expect(() => assertSafe("VACUUM INTO '/tmp/copy.sqlite'")).toThrow(/not allowed/i);
  });

  it('ignores leading whitespace and is case-insensitive', () => {
    expect(() => assertSafe('   \n\t attach database "x" as y')).toThrow(/not allowed/i);
    expect(() => assertSafe('  PrAgMa foreign_keys = ON')).toThrow(/not allowed/i);
  });

  it('flags a plain VACUUM too (it attaches a temp database and rewrites the file)', () => {
    expect(() => assertSafe('VACUUM')).toThrow(/not allowed/i);
  });

  it('finds a blocked verb after a comment, inside a statement or after a semicolon', () => {
    // Audit 2026-09-27: a first-word check let these through.
    for (const sql of [
      "/**/VACUUM INTO '/tmp/x.sqlite'",
      "-- note\nVACUUM INTO '/tmp/x.sqlite'",
      "/* a */ ATTACH DATABASE '/tmp/x.db' AS x",
      "SELECT 1; ATTACH DATABASE '/tmp/x.db' AS x",
      '/**/ PRAGMA journal_mode = DELETE',
    ]) {
      expect(() => assertSafe(sql), sql).toThrow(/not allowed/i);
    }
  });

  it('does not flag a blocked word inside a string literal or a comment', () => {
    expect(() => assertSafe("SELECT 'attach' AS w, 'vacuum into' AS v")).not.toThrow();
    expect(() => assertSafe('SELECT 1 -- pragma talk')).not.toThrow();
    expect(() => assertSafe("SELECT name FROM pragma_table_info('t')")).not.toThrow();
  });

  it('does not flag identifiers that merely start with a blocked word', () => {
    // The guard is anchored to the statement verb, so a column/table named
    // `pragmatic` or `attachments` must not trip it.
    expect(() => assertSafe('SELECT * FROM attachments')).not.toThrow();
    expect(() => assertSafe('SELECT pragmatic FROM notes')).not.toThrow();
  });

  it('allows read-only PRAGMA table_info / table_xinfo (schema introspection)', () => {
    // The one PRAGMA exception: generated apps need it for idempotent column
    // migrations. It reads the app's own schema only — no file/engine escape.
    expect(() => assertSafe('PRAGMA table_info(dcl_items)')).not.toThrow();
    expect(() => assertSafe('pragma table_xinfo(cities)')).not.toThrow();
    expect(() => assertSafe('  PRAGMA  TABLE_INFO ( cities ) ; ')).not.toThrow();
    expect(() => assertSafe('PRAGMA table_info("my table")')).not.toThrow();
    expect(() => assertSafe("PRAGMA table_info('cities')")).not.toThrow();
    expect(() => assertSafe('PRAGMA table_info(`cities`)')).not.toThrow();
    expect(() => assertSafe('PRAGMA table_info([cities])')).not.toThrow();
  });

  it('still blocks every other PRAGMA and any piggyback after table_info', () => {
    // The exception is anchored end-to-end — trailing SQL after the closing
    // paren falls through to the blanket PRAGMA block.
    expect(() => assertSafe("PRAGMA table_info(t); ATTACH DATABASE '/etc/passwd' AS x")).toThrow(
      /not allowed/i,
    );
    expect(() => assertSafe('PRAGMA table_info(t) -- comment')).toThrow(/not allowed/i);
    // Assignment form (`= value`) is not introspection — blocked.
    expect(() => assertSafe('PRAGMA table_info = 1')).toThrow(/not allowed/i);
    expect(() => assertSafe('PRAGMA writable_schema = ON')).toThrow(/not allowed/i);
    expect(() => assertSafe('PRAGMA wal_checkpoint(TRUNCATE)')).toThrow(/not allowed/i);
    expect(() => assertSafe('PRAGMA database_list')).toThrow(/not allowed/i);
    expect(() => assertSafe('PRAGMA table_list')).toThrow(/not allowed/i);
  });
});

/**
 * `assertSafeScript` guards multi-statement schema DDL. `assertSafe` alone only
 * inspects the first verb, so the script guard is what stops a piggybacked
 * ATTACH after a legitimate CREATE TABLE.
 */
describe('assertSafeScript', () => {
  it('allows a multi-statement schema of plain DDL', () => {
    const ddl =
      'CREATE TABLE IF NOT EXISTS cities (name TEXT PRIMARY KEY);\n' +
      'CREATE INDEX IF NOT EXISTS cities_name ON cities (name);';
    expect(() => assertSafeScript(ddl)).not.toThrow();
  });

  it('blocks a blocked verb piggybacked after a valid statement', () => {
    const ddl = "CREATE TABLE t (x INTEGER); ATTACH DATABASE '/etc/passwd' AS leak;";
    expect(() => assertSafeScript(ddl)).toThrow(/not allowed/i);
  });

  it('blocks a PRAGMA buried mid-script', () => {
    const ddl = 'CREATE TABLE a (x); PRAGMA writable_schema = ON; CREATE TABLE b (y);';
    expect(() => assertSafeScript(ddl)).toThrow(/not allowed/i);
  });

  it('tolerates trailing semicolons and blank statements', () => {
    expect(() => assertSafeScript('CREATE TABLE t (x);;\n  ;')).not.toThrow();
  });

  it('allows the table_info introspection exception mid-script too', () => {
    expect(() =>
      assertSafeScript('CREATE TABLE t (x); PRAGMA table_info(t); CREATE TABLE u (y);'),
    ).not.toThrow();
  });
});

/**
 * The broker runs queries via `prepare(sql).all()` on node:sqlite — verify the
 * newly-allowed `PRAGMA table_info` actually returns column rows through that
 * exact call shape (a regression here would pass the guard but die at runtime).
 */
describe('PRAGMA table_info through node:sqlite', () => {
  it('returns one row per column via prepare().all()', () => {
    // getBuiltinModule keeps vite/vitest from trying to bundle node:sqlite.
    const { DatabaseSync } = process.getBuiltinModule(
      'node:sqlite',
    ) as typeof import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
      const rows = db.prepare('PRAGMA table_info(items)').all() as { name: string }[];
      expect(rows.map((r) => r.name)).toEqual(['id', 'name']);
    } finally {
      db.close();
    }
  });
});

/**
 * appDbQuery is what BOTH db-broker routes run for op:'query' — including for
 * PUBLIC share visitors, whose op:'exec' is rejected with a "shared apps are
 * read-only" promise. SQLite executes DML through `prepare(sql).all()`, so the
 * read-only guarantee must come from the ENGINE (read-only open), not from the
 * op name. These tests pin that: a write through op:'query' dies inside SQLite
 * while op:'exec' (appDbExec, which the routes gate) still works.
 */
describe('appDbQuery opens the database read-only', () => {
  const owner = 'owner-1';
  const app = 'app-1';

  it('provisions an empty db on the very first query and still answers reads', async () => {
    // Read-only open never creates a file; the broker must first-touch it.
    const rows = await appDbQuery(owner, app, 'SELECT 1 AS x');
    expect(rows).toEqual([{ x: 1 }]);
  });

  it('appDbExec (the gated write path) still writes', async () => {
    await appDbExec(owner, app, 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    const res = await appDbExec(owner, app, "INSERT INTO t (name) VALUES ('keep')");
    expect(res.changes).toBe(1);
  });

  it('rejects INSERT/DELETE through the query path at the engine level', async () => {
    await expect(appDbQuery(owner, app, 'DELETE FROM t')).rejects.toThrow(/readonly/i);
    await expect(
      appDbQuery(owner, app, "INSERT INTO t (name) VALUES ('smuggled')"),
    ).rejects.toThrow(/readonly/i);
    // DML wrapped in a CTE is why a SELECT-only regex could never be the guard.
    await expect(
      appDbQuery(owner, app, 'WITH doomed AS (SELECT id FROM t) DELETE FROM t'),
    ).rejects.toThrow(/readonly/i);
    // Nothing above touched the data.
    const rows = await appDbQuery(owner, app, 'SELECT name FROM t ORDER BY id');
    expect(rows).toEqual([{ name: 'keep' }]);
  });
});

/**
 * On delete we must remove not just the .sqlite file but every sidecar SQLite
 * can leave behind, or the volume leaks files after an app is deleted.
 */
describe('appDbFiles', () => {
  it('lists the db file plus its journal/WAL/SHM sidecars', () => {
    const base = '/data/app-dbs/owner/app.sqlite';
    expect(appDbFiles(base)).toEqual([base, `${base}-journal`, `${base}-wal`, `${base}-shm`]);
  });
});

describe('snapshotDestPath', () => {
  it('mirrors the live <owner>/<app>.sqlite layout under destDir', () => {
    expect(snapshotDestPath('/tmp/snap', 'owner-1', 'app-9')).toBe(
      '/tmp/snap/owner-1/app-9.sqlite',
    );
  });
});

/**
 * The `app_db_seed` plan (apps audit P5): every row is checked against the
 * LIVE columns before anything runs, and the statements then run in one
 * transaction in a SQL child (the transaction itself is pinned in
 * app-sql-runner.test.ts and on Postgres in apps-concurrency.db.test.ts).
 */
describe('planSeedStatements', () => {
  const COLS = ['id', 'name', 'sg', 'flammable'];

  it('one INSERT per row, booleans as 1/0, null kept', () => {
    expect(
      planSeedStatements('fluids', COLS, [
        { name: 'WATER', sg: 1 },
        { name: 'BUTANE', sg: 0.58, flammable: true },
        { name: 'UNKNOWN', sg: null },
      ]),
    ).toEqual([
      { sql: 'INSERT INTO "fluids" ("name", "sg") VALUES (?, ?)', params: ['WATER', 1] },
      {
        sql: 'INSERT INTO "fluids" ("name", "sg", "flammable") VALUES (?, ?, ?)',
        params: ['BUTANE', 0.58, 1],
      },
      { sql: 'INSERT INTO "fluids" ("name", "sg") VALUES (?, ?)', params: ['UNKNOWN', null] },
    ]);
  });

  it('replace empties the table first, in the same batch', () => {
    expect(planSeedStatements('fluids', COLS, [{ name: 'A' }], { replace: true })[0]).toEqual({
      sql: 'DELETE FROM "fluids"',
      params: [],
    });
  });

  it('refuses the whole batch on a bad row, naming the columns', () => {
    expect(() =>
      planSeedStatements('fluids', COLS, [{ name: 'GOOD' }, { nope: 'bad column' }]),
    ).toThrow(/unknown column 'nope'.*columns are/i);
    expect(() => planSeedStatements('fluids', COLS, [{}])).toThrow(/row 0 is empty/);
  });

  it('rejects nested values with a teaching error', () => {
    expect(() => planSeedStatements('fluids', COLS, [{ name: { deep: true } }])).toThrow(
      /must be string, number, boolean, or null/i,
    );
  });

  it('refuses invalid and sqlite-internal table names', () => {
    expect(() =>
      planSeedStatements('fluids"; DROP TABLE fluids;--', COLS, [{ name: 'X' }]),
    ).toThrow(/not a valid table name/i);
    expect(() => planSeedStatements('sqlite_master', COLS, [{ name: 'X' }])).toThrow(
      /not a valid table name/i,
    );
  });
});

/**
 * Apps audit D1: an app that stored something and lost its file is refused
 * loudly. It used to be recreated empty, with the schema not re-run (the
 * registry version was current), so every statement failed with "no such
 * table" and nothing said why.
 */
describe('a lost database file is never recreated empty', () => {
  const swap = async (
    patch: { storagePath: string; schemaVersion: number; sizeBytes: number },
    body: () => Promise<void>,
  ) => {
    const row = h.registryRow!;
    const saved = { ...row };
    Object.assign(row, patch);
    try {
      await body();
    } finally {
      Object.assign(row, saved);
    }
  };
  const gone = () => nodePath.join(nodePath.dirname(h.storagePath), `gone-${Math.random()}.sqlite`);

  it('refuses an app that had data: queries, writes and the agent read', async () => {
    const file = gone();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await swap({ storagePath: file, schemaVersion: 2, sizeBytes: 0 }, async () => {
      await expect(appDbQuery('o', 'lost-app', 'SELECT 1')).rejects.toBeInstanceOf(
        AppDbMissingError,
      );
      await expect(appDbExec('o', 'lost-app', 'CREATE TABLE t (x)')).rejects.toBeInstanceOf(
        AppDbMissingError,
      );
      await expect(appDbReadQuery('o', 'lost-app', 'SELECT 1')).rejects.toBeInstanceOf(
        AppDbMissingError,
      );
    });
    await swap({ storagePath: file, schemaVersion: 0, sizeBytes: 4096 }, async () => {
      await expect(appDbQuery('o', 'lost-app', 'SELECT 1')).rejects.toBeInstanceOf(
        AppDbMissingError,
      );
    });
    expect(existsSync(file)).toBe(false);
    vi.mocked(console.error).mockRestore();
  });

  it('still provisions an app that never stored anything', async () => {
    const file = gone();
    await swap({ storagePath: file, schemaVersion: 0, sizeBytes: 0 }, async () => {
      expect(await appDbQuery('o', 'new-app', 'SELECT 1 AS one')).toEqual([{ one: 1 }]);
    });
    expect(existsSync(file)).toBe(true);
  });
});

/**
 * An app's schema DDL (audit item C) runs in the SQL runner like every other
 * app statement: a worker with the engine authorizer and a time limit, one
 * transaction. It used to run here on the main thread with no timeout, so an
 * endless statement in a schema froze the whole process. Last in the file:
 * the endless case leaves its killed write behind in this process.
 */
describe('ensureAppDatabase applies the schema DDL through the SQL runner', () => {
  const owner = 'owner-1';
  const app = 'app-1';
  const scripts = () => vi.mocked(runAppSql).mock.calls.filter(([, o]) => o.mode === 'script');
  const names = async () =>
    (
      await appDbQuery(
        owner,
        app,
        "SELECT name FROM sqlite_master WHERE name LIKE 'sv%' ORDER BY name",
      )
    ).map((r) => r.name);

  it('applies a newer schema version as one script in the runner', async () => {
    vi.mocked(runAppSql).mockClear();
    const schemaSql =
      'CREATE TABLE sv_polls (id INTEGER PRIMARY KEY, title TEXT); CREATE INDEX sv_polls_title ON sv_polls (title);';
    const reg = await ensureAppDatabase(owner, app, { schemaSql, schemaVersion: 1 });
    expect(reg.schemaVersion).toBe(1);
    expect(scripts()).toEqual([
      [
        h.storagePath,
        {
          sql: schemaSql,
          mode: 'script',
          readOnly: false,
          timeoutMs: APP_SCHEMA_TIMEOUT_MS,
          userVersion: 1,
        },
      ],
    ]);
    expect(await names()).toEqual(['sv_polls', 'sv_polls_title']);
  });

  it('stamps the version into the file; a lost registry update is skipped, not re-run', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const file = new DatabaseSync(h.storagePath, { readOnly: true });
    try {
      expect(file.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    } finally {
      file.close();
    }
    // As if the process died between the SQLite commit and the registry
    // update: the registry still says 0. The plain CREATE would now fail on
    // "already exists"; the stamp makes the runner skip it.
    h.registryRow!.schemaVersion = 0;
    const reg = await ensureAppDatabase(owner, app, {
      schemaSql: 'CREATE TABLE sv_polls (id INTEGER PRIMARY KEY, title TEXT);',
      schemaVersion: 1,
    });
    expect(reg.schemaVersion).toBe(1);
    expect(await names()).toEqual(['sv_polls', 'sv_polls_title']);
  });

  it('checkAppSchemaScript refuses a script that fails on the live tables, and changes nothing', async () => {
    const dir = nodePath.dirname(h.storagePath);
    await expect(checkAppSchemaScript(owner, app, 'CREATE TABLE sv_polls (x);')).rejects.toThrow(
      /fails against the app's current database.*already exists/s,
    );
    await expect(
      checkAppSchemaScript(owner, app, "CREATE TABLE sv_y (x); ATTACH DATABASE 'x' AS y;"),
    ).rejects.toThrow(/not allowed/);
    // A script that runs over the existing tables passes, and the live file
    // does not get its new table: it was tried on a copy.
    await checkAppSchemaScript(
      owner,
      app,
      'CREATE TABLE IF NOT EXISTS sv_polls (id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE IF NOT EXISTS sv_more (x);',
    );
    expect(await names()).toEqual(['sv_polls', 'sv_polls_title']);
    expect(readdirSync(dir).filter((f) => f.startsWith('.schema-check'))).toEqual([]);
  });

  it('does not re-run a version already applied', async () => {
    vi.mocked(runAppSql).mockClear();
    await ensureAppDatabase(owner, app, {
      schemaSql: 'CREATE TABLE sv_polls (x);',
      schemaVersion: 1,
    });
    expect(scripts()).toEqual([]);
  });

  it('refuses a schema with ATTACH before it reaches the file', async () => {
    vi.mocked(runAppSql).mockClear();
    await expect(
      ensureAppDatabase(owner, app, {
        schemaSql: "CREATE TABLE sv_x (x); ATTACH DATABASE '/tmp/x.db' AS o;",
        schemaVersion: 2,
      }),
    ).rejects.toThrow(/not allowed/);
    expect(scripts()).toEqual([]);
    expect(await names()).not.toContain('sv_x');
  });

  it('stops an endless schema statement without blocking the event loop; the version stays', async () => {
    h.timeoutMs = 400;
    let ticks = 0;
    const tick = setInterval(() => (ticks += 1), 20);
    try {
      await expect(
        ensureAppDatabase(owner, app, {
          schemaSql:
            'CREATE TABLE sv_early (x); CREATE TABLE sv_big AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c;',
          schemaVersion: 2,
        }),
      ).rejects.toThrow(/longer than 400 ms/);
    } finally {
      clearInterval(tick);
      h.timeoutMs = undefined;
    }
    expect(ticks).toBeGreaterThan(5);
    expect((await ensureAppDatabase(owner, app)).schemaVersion).toBe(1);
    expect(await names()).toEqual(['sv_polls', 'sv_polls_title']);
  });
});
