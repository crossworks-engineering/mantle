/**
 * The app timers' run log in an app's own database (docs/app-timers.md):
 * `_timer_runs` (and every name it prefixes) is reserved. The server's own
 * timer batch (runAppTimerRunsBatch) makes and writes it; app SQL reads it
 * and never changes it, whatever the statement (a row write, a drop, an
 * alter, a rename, a view, a virtual table, a trigger or an index on it, a
 * schema script, a seed, a data-only MCP write). What the authorizer cannot
 * see (a table renamed ONTO the name, a file an import brought) the timer
 * batch sets right before it writes: a planted trigger or view goes, a
 * table that is not the server's is moved aside with its rows. Real SQLite
 * files in a temp dir; no Postgres.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_TIMER_RUNS_TABLE,
  runAppSql,
  runAppSqlBatch,
  runAppTimerRunsBatch,
  type AppTimerRunsDdl,
} from './app-sql-runner';

const DDL: AppTimerRunsDdl = {
  table: `CREATE TABLE IF NOT EXISTS "${APP_TIMER_RUNS_TABLE}" (id INTEGER PRIMARY KEY, timer_id TEXT NOT NULL, ran_at TEXT NOT NULL, ok INTEGER NOT NULL, ms INTEGER NOT NULL, result TEXT, error TEXT, level TEXT)`,
  index: `CREATE INDEX IF NOT EXISTS "${APP_TIMER_RUNS_TABLE}_timer_ran" ON "${APP_TIMER_RUNS_TABLE}" (timer_id, ran_at)`,
  indexName: `${APP_TIMER_RUNS_TABLE}_timer_ran`,
};
/** One run, as the server writes it. */
const record = (file: string, timer = 't1') =>
  runAppTimerRunsBatch(
    file,
    [
      { sql: DDL.table, params: [] },
      { sql: DDL.index, params: [] },
      {
        sql: `INSERT INTO "${APP_TIMER_RUNS_TABLE}" (timer_id, ran_at, ok, ms, result, error, level) VALUES (?, ?, 1, 5, ?, NULL, 'admin')`,
        params: [timer, '2026-11-03T10:00:00.000Z', '{"v":1}'],
      },
    ],
    DDL,
  );

describe('the reserved _timer_runs table', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'app-timer-runs-'));
  const file = path.join(dir, 'app.sqlite');
  const run = (sql: string, opts: { readOnly?: boolean; dataOnly?: boolean; at?: string } = {}) =>
    runAppSql(opts.at ?? file, {
      sql,
      mode: opts.readOnly ? 'all' : 'run',
      readOnly: opts.readOnly === true,
      ...(opts.dataOnly ? { dataOnly: true } : {}),
    });
  const count = async (at = file) =>
    (
      (await run(`SELECT count(*) AS n FROM ${APP_TIMER_RUNS_TABLE}`, { readOnly: true, at })) as {
        n: number;
      }[]
    )[0]!.n;
  const objects = (at: string) => {
    const db = new DatabaseSync(at, { readOnly: true });
    try {
      return (
        db.prepare('SELECT type, name FROM sqlite_master ORDER BY name').all() as {
          type: string;
          name: string;
        }[]
      ).map((o) => `${o.type} ${o.name}`);
    } finally {
      db.close();
    }
  };

  beforeAll(async () => {
    await run('CREATE TABLE notes (x INTEGER)');
    await record(file);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('the server batch makes and writes it; app SQL reads it', async () => {
    expect(await count()).toBe(1);
    const rows = await run(`SELECT timer_id, ok, result, level FROM _timer_runs`, {
      readOnly: true,
    });
    expect(rows).toEqual([{ timer_id: 't1', ok: 1, result: '{"v":1}', level: 'admin' }]);
    await expect(
      run('SELECT n.x FROM notes n JOIN _timer_runs r ON r.ok = n.x', { readOnly: true }),
    ).resolves.toEqual([]);
    // A second run leaves the server's table as it is.
    expect((await record(file)).setRight).toEqual([]);
    expect(await count()).toBe(2);
  });

  it('app SQL never changes it: rows, drop, alter, rename, view, virtual table, trigger, index', async () => {
    for (const sql of [
      `INSERT INTO _timer_runs (timer_id, ran_at, ok, ms) VALUES ('x', 'y', 1, 1)`,
      `INSERT INTO "_TIMER_RUNS" (timer_id, ran_at, ok, ms) VALUES ('x', 'y', 1, 1)`,
      `UPDATE _timer_runs SET ok = 0`,
      `DELETE FROM _timer_runs`,
      `REPLACE INTO _timer_runs (id, timer_id, ran_at, ok, ms) VALUES (1, 'x', 'y', 0, 0)`,
      `DROP TABLE _timer_runs`,
      `ALTER TABLE _timer_runs RENAME TO kept`,
      `ALTER TABLE _timer_runs ADD COLUMN extra TEXT`,
      `CREATE TRIGGER t_ins AFTER INSERT ON _timer_runs BEGIN SELECT 1; END`,
      `CREATE UNIQUE INDEX hijack ON _timer_runs (timer_id)`,
      `CREATE VIEW _timer_runs AS SELECT 1`,
      // The prefix: a shadow-like name, a virtual table by another name of it.
      `CREATE TABLE _timer_runs_extra (x INTEGER)`,
      `CREATE VIRTUAL TABLE _timer_runs_fts USING fts5(a)`,
    ]) {
      await expect(run(sql), sql).rejects.toThrow(/authoriz/i);
    }
    expect(await count()).toBe(2);
  });

  it("a trigger on the app's own table that writes the log never fires into it", async () => {
    await run(`CREATE TRIGGER t_notes AFTER INSERT ON notes BEGIN DELETE FROM _timer_runs; END`);
    await expect(run('INSERT INTO notes VALUES (1)')).rejects.toThrow(/authoriz/i);
    expect(await count()).toBe(2);
    await run('DROP TRIGGER t_notes');
  });

  it('a data-only write (an MCP app_data_write) is refused there too', async () => {
    await expect(run(`DELETE FROM _timer_runs`, { dataOnly: true })).rejects.toThrow(/authoriz/i);
    await expect(run('INSERT INTO notes VALUES (7)', { dataOnly: true })).resolves.toMatchObject({
      changes: 1,
    });
    expect(await count()).toBe(2);
  });

  it('a schema script and a seed batch cannot make or fill it', async () => {
    const other = path.join(dir, 'fresh.sqlite');
    await expect(
      runAppSql(other, {
        sql: 'CREATE TABLE IF NOT EXISTS _timer_runs (id INTEGER PRIMARY KEY)',
        mode: 'script',
        readOnly: false,
      }),
    ).rejects.toThrow(/authoriz/i);
    await expect(
      runAppSqlBatch(file, [
        {
          sql: `INSERT INTO _timer_runs (timer_id, ran_at, ok, ms) VALUES ('s', 's', 1, 1)`,
          params: [],
        },
      ]),
    ).rejects.toThrow(/authoriz/i);
    expect(await count()).toBe(2);
  });

  it('a script that drops it is refused whole', async () => {
    await expect(
      runAppSql(file, {
        sql: 'CREATE TABLE extra (y INTEGER); DROP TABLE _timer_runs;',
        mode: 'script',
        readOnly: false,
      }),
    ).rejects.toThrow(/authoriz/i);
    expect(await count()).toBe(2);
    await expect(run('SELECT * FROM extra', { readOnly: true })).rejects.toThrow(/no such table/);
  });

  it('a table renamed onto the name before the first run is moved aside, its rows kept', async () => {
    const at = path.join(dir, 'renamed.sqlite');
    await run('CREATE TABLE mine (timer_id TEXT, fake TEXT)', { at });
    await run(`INSERT INTO mine VALUES ('t1', 'planted')`, { at });
    // The authorizer sees the old name: the rename passes.
    await run('ALTER TABLE mine RENAME TO _timer_runs', { at });
    const res = await record(at);
    expect(res.setRight).toEqual(['table']);
    expect(await count(at)).toBe(1);
    const moved = objects(at).find((o) => o.startsWith('table timer_runs_moved_'));
    expect(moved).toBeDefined();
    const kept = await run(`SELECT fake FROM ${moved!.slice(6)}`, { readOnly: true, at });
    expect(kept).toEqual([{ fake: 'planted' }]);
  });

  it('a virtual table of the name (an older file) is moved aside with its shadow tables', async () => {
    const at = path.join(dir, 'vtable.sqlite');
    const db = new DatabaseSync(at);
    db.exec('CREATE VIRTUAL TABLE _timer_runs USING fts5(timer_id, result)');
    db.exec(`INSERT INTO _timer_runs VALUES ('t1', 'planted')`);
    db.close();
    const res = await record(at);
    expect(res.setRight).toEqual(['table']);
    expect(await count(at)).toBe(1);
    const left = objects(at).filter((o) => / _timer_runs/.test(o));
    expect(left.sort()).toEqual(['index _timer_runs_timer_ran', 'table _timer_runs']);
  });

  it('an imported file with a crafted table and triggers on it: set right, and nothing it planted fires', async () => {
    const at = path.join(dir, 'imported.sqlite');
    const db = new DatabaseSync(at);
    db.exec('CREATE TABLE loot (v TEXT)');
    // The server's own shape, so the table stays; the planted parts go.
    db.exec(DDL.table);
    db.exec(`INSERT INTO _timer_runs (timer_id, ran_at, ok, ms) VALUES ('t1', 'x', 1, 1)`);
    db.exec(
      `CREATE TRIGGER steal AFTER INSERT ON _timer_runs BEGIN INSERT INTO loot VALUES (NEW.result); END`,
    );
    db.exec(`CREATE UNIQUE INDEX block ON _timer_runs (timer_id)`);
    db.close();
    const res = await record(at);
    expect([...res.setRight].sort()).toEqual(['index', 'trigger']);
    // The unique index is gone (the second t1 row went in), and the trigger
    // never ran.
    expect(await count(at)).toBe(2);
    expect(await run('SELECT count(*) AS n FROM loot', { readOnly: true, at })).toEqual([{ n: 0 }]);
    expect(objects(at)).not.toContain('trigger steal');
  });

  it("an app table with a foreign key to the log neither blocks the prune nor cascades into the app's rows", async () => {
    const at = path.join(dir, 'fk.sqlite');
    await record(at);
    // App SQL may point its own tables at the log: a plain key (which would
    // refuse the delete) and a cascading one (which would delete the app's
    // rows, a write the timer batch's authorizer refuses).
    await run(`CREATE TABLE plain (run INTEGER REFERENCES ${APP_TIMER_RUNS_TABLE}(id))`, { at });
    await run(
      `CREATE TABLE cascade (run INTEGER REFERENCES ${APP_TIMER_RUNS_TABLE}(id) ON DELETE CASCADE)`,
      { at },
    );
    await run('INSERT INTO plain VALUES (1)', { at });
    await run('INSERT INTO cascade VALUES (1)', { at });
    const res = await runAppTimerRunsBatch(
      at,
      [{ sql: `DELETE FROM "${APP_TIMER_RUNS_TABLE}" WHERE timer_id = ?`, params: ['t1'] }],
      DDL,
    );
    expect(res.changes).toEqual([1]);
    expect(await count(at)).toBe(0);
    // The app's rows stay as they were (dangling now: the app's to mind).
    expect(await run('SELECT count(*) AS n FROM plain', { readOnly: true, at })).toEqual([
      { n: 1 },
    ]);
    expect(await run('SELECT count(*) AS n FROM cascade', { readOnly: true, at })).toEqual([
      { n: 1 },
    ]);
    // And the app's own connection still keeps its keys.
    await expect(run('INSERT INTO plain VALUES (99)', { at })).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("a broken view of the app's does not stop a wrong table being moved aside", async () => {
    const at = path.join(dir, 'broken-view.sqlite');
    await run('CREATE TABLE gone (x INTEGER)', { at });
    await run('CREATE VIEW broken AS SELECT x FROM gone', { at });
    await run('CREATE TABLE mine (timer_id TEXT, fake TEXT)', { at });
    await run(`INSERT INTO mine VALUES ('t1', 'planted')`, { at });
    await run('ALTER TABLE mine RENAME TO _timer_runs', { at });
    // A view whose table is gone: a full rename would re-read it and fail.
    const db = new DatabaseSync(at);
    db.exec('PRAGMA legacy_alter_table = ON');
    db.exec('DROP TABLE gone');
    db.close();
    const res = await record(at);
    expect(res.setRight).toEqual(['table']);
    expect(await count(at)).toBe(1);
    const moved = objects(at).filter((o) => o.startsWith('table timer_runs_moved_'));
    expect(moved).toHaveLength(1);
    // A random name, not a clock the app could guess and take first.
    expect(moved[0]).toMatch(/^table timer_runs_moved_[0-9a-f]{12}$/);
    expect(objects(at)).toContain('view broken');
  });

  it('the batch reaches no other table: a statement that would is refused, nothing stays', async () => {
    await expect(
      runAppTimerRunsBatch(
        file,
        [
          { sql: DDL.table, params: [] },
          {
            sql: `INSERT INTO "${APP_TIMER_RUNS_TABLE}" (timer_id, ran_at, ok, ms) VALUES ('z', 'z', 1, 1)`,
            params: [],
          },
          { sql: 'DELETE FROM notes', params: [] },
        ],
        DDL,
      ),
    ).rejects.toThrow(/authoriz/i);
    expect(await count()).toBe(2);
  });
});
