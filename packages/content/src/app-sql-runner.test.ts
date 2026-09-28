/**
 * The app SQL runner (audit 2026-09-27): app SQL runs in a child process with an
 * engine authorizer, a time limit, a row cap and a size cap, so neither a
 * clever statement nor an endless one can escape the file or freeze the
 * server. Real SQLite files in a temp dir; no Postgres.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_SQL_MAX_ROWS, appSqlChildPids, runAppSql } from './app-sql-runner';

describe('runAppSql', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'app-sql-runner-'));
  const file = path.join(dir, 'app.sqlite');
  const run = (sql: string, readOnly = false, timeoutMs?: number) =>
    runAppSql(file, { sql, mode: readOnly ? 'all' : 'run', readOnly, timeoutMs });

  beforeAll(async () => {
    await run('CREATE TABLE t (x INTEGER)');
    await run('INSERT INTO t VALUES (1), (2)');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads and writes the app file', async () => {
    expect(
      await runAppSql(file, { sql: 'SELECT count(*) AS n FROM t', mode: 'all', readOnly: true }),
    ).toEqual([{ n: 2 }]);
    const res = await runAppSql(file, {
      sql: 'INSERT INTO t VALUES (?)',
      params: [3],
      mode: 'run',
      readOnly: false,
    });
    expect(res).toMatchObject({ changes: 1 });
  });

  it('refuses VACUUM INTO and ATTACH at the engine, whatever the text looks like', async () => {
    const out = path.join(dir, 'copy.sqlite');
    for (const sql of [`/**/VACUUM INTO '${out}'`, `VACUUM INTO '${out}'`]) {
      await expect(run(sql)).rejects.toThrow(/authoriz/i);
      await expect(run(sql, true)).rejects.toThrow(/authoriz/i);
    }
    expect(existsSync(out)).toBe(false);
    await expect(run(`ATTACH DATABASE '${path.join(dir, 'other.db')}' AS o`)).rejects.toThrow(
      /authoriz/i,
    );
    expect(existsSync(path.join(dir, 'other.db'))).toBe(false);
  });

  it('refuses every PRAGMA but table_info and table_xinfo', async () => {
    await expect(run('PRAGMA journal_mode = DELETE')).rejects.toThrow(/authoriz/i);
    await expect(run('PRAGMA writable_schema = ON')).rejects.toThrow(/authoriz/i);
    expect(await run('PRAGMA table_info(t)', true)).toEqual([
      expect.objectContaining({ name: 'x' }),
    ]);
    expect(await run("SELECT name FROM pragma_table_xinfo('t')", true)).toEqual([{ name: 'x' }]);
  });

  it('stops an endless statement at the time limit without blocking the event loop', async () => {
    let ticks = 0;
    const tick = setInterval(() => (ticks += 1), 20);
    const started = Date.now();
    await expect(
      run(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c',
        true,
        400,
      ),
    ).rejects.toThrow(/longer than 400 ms/);
    clearInterval(tick);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(ticks).toBeGreaterThan(5);
    // The file still works after a killed statement.
    expect(await run('SELECT count(*) AS n FROM t', true)).toEqual([{ n: 3 }]);
  });

  it('caps the rows a query returns', async () => {
    await expect(
      run(
        `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT ${APP_SQL_MAX_ROWS + 1}) SELECT x FROM c`,
        true,
      ),
    ).rejects.toThrow(/more than 50000 rows/);
  });

  it('caps the size of one string or blob', async () => {
    await expect(run('SELECT length(randomblob(20000000)) AS n', true)).rejects.toThrow(/too big/i);
  });
});

/**
 * Mode 'script': an app's declared schema DDL (audit item C). It used to run
 * on the main thread with only the regex guard; now it runs here, under the
 * same authorizer and time limit, in one transaction.
 */
describe("runAppSql mode 'script' (schema DDL)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'app-sql-script-'));
  const file = path.join(dir, 'app.sqlite');
  const script = (sql: string, timeoutMs?: number) =>
    runAppSql(file, { sql, mode: 'script', readOnly: false, timeoutMs });
  const tables = async () =>
    (
      (await runAppSql(file, {
        sql: "SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'view', 'trigger') ORDER BY name",
        mode: 'all',
        readOnly: true,
      })) as { name: string }[]
    ).map((r) => r.name);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('applies the DDL an app schema uses', async () => {
    await script(`
      CREATE TABLE polls (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'a;b');
      CREATE INDEX polls_title ON polls (title);
      CREATE TABLE votes (poll_id INTEGER REFERENCES polls(id), n INTEGER);
      ALTER TABLE votes ADD COLUMN at TEXT;
      CREATE VIEW poll_totals AS SELECT poll_id, sum(n) AS n FROM votes GROUP BY poll_id;
      CREATE TRIGGER polls_touch AFTER INSERT ON polls BEGIN SELECT 1; END;
      PRAGMA table_info(votes);
    `);
    expect(await tables()).toEqual(['poll_totals', 'polls', 'polls_title', 'polls_touch', 'votes']);
  });

  it('refuses ATTACH and PRAGMA at the engine, and keeps nothing of the script', async () => {
    for (const bad of [
      `ATTACH DATABASE '${path.join(dir, 'other.db')}' AS o`,
      'PRAGMA writable_schema = ON',
      'PRAGMA journal_mode = DELETE',
    ]) {
      await expect(script(`CREATE TABLE leftover (x); ${bad};`), bad).rejects.toThrow(/authoriz/i);
    }
    expect(existsSync(path.join(dir, 'other.db'))).toBe(false);
    expect(await tables()).not.toContain('leftover');
  });

  it('never runs VACUUM: refused at the engine, and inside the script transaction anyway', async () => {
    const out = path.join(dir, 'copy.sqlite');
    for (const bad of [`VACUUM INTO '${out}'`, 'VACUUM']) {
      await expect(script(bad), bad).rejects.toThrow(/authoriz|within a transaction/i);
    }
    expect(existsSync(out)).toBe(false);
  });

  it('is all or nothing: a failing statement rolls back the ones before it', async () => {
    await expect(script('CREATE TABLE half (x); CREATE TABLE polls (y);')).rejects.toThrow(
      /already exists/,
    );
    expect(await tables()).not.toContain('half');
  });

  it('stops an endless statement at the time limit without blocking the event loop', async () => {
    let ticks = 0;
    const tick = setInterval(() => (ticks += 1), 20);
    const started = Date.now();
    await expect(
      script(
        'CREATE TABLE early (x); CREATE TABLE big AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c;',
        400,
      ),
    ).rejects.toThrow(/longer than 400 ms/);
    clearInterval(tick);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(ticks).toBeGreaterThan(5);
    // The killed transaction left nothing, and the file still reads.
    expect(await tables()).not.toContain('early');
    // Its BEGIN IMMEDIATE lock went with its process: the next script writes
    // at once instead of waiting out busy_timeout into "database is locked".
    const next = Date.now();
    await script('CREATE TABLE after_kill (x);');
    expect(Date.now() - next).toBeLessThan(2_000);
    expect(await tables()).toContain('after_kill');
  });

  it('never runs read-only', async () => {
    await expect(
      runAppSql(file, { sql: 'CREATE TABLE ro (x)', mode: 'script', readOnly: true }),
    ).rejects.toThrow(/writable/);
  });
});

/**
 * The child processes (2026-09-28). A worker thread terminated at the time
 * limit kept its SQLite connection, so a killed WRITE held the app's write
 * lock until the web process restarted. A killed process lets go.
 */
describe('runAppSql child processes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'app-sql-child-'));
  const file = path.join(dir, 'app.sqlite');
  const write = (sql: string, timeoutMs?: number) =>
    runAppSql(file, { sql, mode: 'run', readOnly: false, timeoutMs });
  const count = async () =>
    (
      (await runAppSql(file, {
        sql: 'SELECT count(*) AS n FROM t',
        mode: 'all',
        readOnly: true,
      })) as { n: number }[]
    )[0]?.n;
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(cond()).toBe(true);
  };

  beforeAll(async () => {
    await write('CREATE TABLE t (x INTEGER)');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a write stopped at the time limit lets go of the lock: the next write goes straight through', async () => {
    await write('INSERT INTO t VALUES (1)');
    const before = appSqlChildPids();
    await expect(
      write(
        'INSERT INTO t SELECT x FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c)',
        400,
      ),
    ).rejects.toThrow(/longer than 400 ms/);
    // The child that ran it is gone.
    expect(appSqlChildPids().filter((p) => !before.includes(p))).toEqual([]);
    const started = Date.now();
    await expect(write('INSERT INTO t VALUES (2)')).resolves.toMatchObject({ changes: 1 });
    // Straight through, not after waiting out busy_timeout (5 s).
    expect(Date.now() - started).toBeLessThan(2_000);
    // Nothing of the killed write stayed.
    expect(await count()).toBe(2);
  });

  it('reuses one child for statement after statement', async () => {
    await count();
    const pids = appSqlChildPids();
    expect(pids.length).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) await count();
    expect(appSqlChildPids()).toEqual(pids);
  });

  it('replaces a child killed from outside, and the next statement works', async () => {
    await count();
    const killed = appSqlChildPids();
    expect(killed.length).toBeGreaterThan(0);
    for (const pid of killed) process.kill(pid, 'SIGKILL');
    await until(() => appSqlChildPids().every((p) => !killed.includes(p)));
    await expect(write('INSERT INTO t VALUES (3)')).resolves.toMatchObject({ changes: 1 });
    expect(await count()).toBe(3);
    const now = appSqlChildPids();
    expect(now.length).toBeGreaterThan(0);
    expect(now.some((p) => killed.includes(p))).toBe(false);
  });

  it('answers with the SQL error and keeps the child for the next statement', async () => {
    await count();
    const pids = appSqlChildPids();
    await expect(write('INSERT INTO nope VALUES (1)')).rejects.toThrow(/no such table/);
    expect(appSqlChildPids()).toEqual(pids);
    expect(await count()).toBe(3);
  });
});
