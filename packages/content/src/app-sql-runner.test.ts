/**
 * The app SQL runner (audit 2026-09-27): app SQL runs in a worker with an
 * engine authorizer, a time limit, a row cap and a size cap, so neither a
 * clever statement nor an endless one can escape the file or freeze the
 * server. Real SQLite files in a temp dir; no Postgres.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_SQL_MAX_ROWS, runAppSql } from './app-sql-runner';

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
