import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runTableSql, tableSqlChildPids } from './sql-runner';
import { openTableFile } from './sqlite';

/** Counts for ever: an outer LIMIT does not stop an aggregate. */
const ENDLESS =
  'with recursive c(x) as (select 1 union all select x+1 from c) select count(*) from c';

/** True while `pid` exists. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('table_sql child processes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tabledb-sql-runner-'));
  const file = path.join(dir, 'book.sqlite');

  beforeAll(() => {
    const db = openTableFile(file, { mustExist: false });
    db.exec("CREATE TABLE t (n INTEGER, b BLOB); INSERT INTO t VALUES (1, x'0102'), (2, NULL)");
    db.close();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  beforeEach(() => {
    process.env.TABLE_SQL_TIMEOUT_MS = '300';
  });
  afterEach(() => {
    delete process.env.TABLE_SQL_TIMEOUT_MS;
  });

  // No pid here, so this holds for any way of running the query: a thread that
  // survives its limit shows up as CPU in this process. It runs first, because
  // on a build where the query survives, it is the failure that says so.
  it('stops using the CPU once the endless query passes its limit', async () => {
    await expect(runTableSql(file, ENDLESS)).rejects.toThrow(/killed/);
    const before = process.cpuUsage();
    const wall = performance.now();
    await sleep(500);
    const cpu = process.cpuUsage(before);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    expect(cpuMs).toBeLessThan((performance.now() - wall) * 0.5);
  });

  it('kills the process of the endless query before the caller hears of it', async () => {
    const failed = expect(runTableSql(file, ENDLESS)).rejects.toThrow(
      /exceeded the 300ms limit and was killed/,
    );
    await sleep(100);
    const pids = tableSqlChildPids();
    expect(pids.length).toBeGreaterThan(0);
    await failed;
    const killed = pids.filter((p) => !running(p));
    expect(killed.length).toBe(1);
    expect(tableSqlChildPids()).not.toContain(killed[0]);
  });

  it('answers the next statement after a kill', async () => {
    await expect(runTableSql(file, ENDLESS)).rejects.toThrow(/killed/);
    const r = await runTableSql(file, 'SELECT n FROM t ORDER BY n');
    expect(r.rows).toEqual([[1], [2]]);
  });

  it('reuses one child for statements in a row', async () => {
    await runTableSql(file, 'SELECT 1 AS one');
    const pids = tableSqlChildPids();
    await runTableSql(file, 'SELECT 2 AS two');
    expect(tableSqlChildPids()).toEqual(pids);
  });

  it('closes its connection after a failed statement and goes on', async () => {
    await expect(runTableSql(file, 'SELECT nope FROM missing')).rejects.toThrow(/missing/);
    await expect(runTableSql(file, 'SELECT n FROM t LIMIT 1')).resolves.toMatchObject({
      rows: [[1]],
    });
  });

  it('returns values as the worker did: BLOB as bytes, NULL as null', async () => {
    const r = await runTableSql(file, 'SELECT b FROM t ORDER BY n');
    expect(r.rows[0]![0]).toEqual(new Uint8Array([1, 2]));
    expect(r.rows[1]![0]).toBeNull();
  });

  it('runs more statements at once than it has children', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => runTableSql(file, `SELECT ${i} AS i`)),
    );
    expect(results.map((r) => r.rows[0]![0])).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(tableSqlChildPids().length).toBeLessThanOrEqual(4);
  });

  it('holds a statement beyond the cap until an endless one is killed', async () => {
    const endless = Promise.allSettled(Array.from({ length: 4 }, () => runTableSql(file, ENDLESS)));
    process.env.TABLE_SQL_TIMEOUT_MS = '10000';
    const r = await runTableSql(file, 'SELECT n FROM t LIMIT 1');
    expect(r.rows).toEqual([[1]]);
    for (const e of await endless) expect(e.status).toBe('rejected');
  });

  it('refuses a statement that waits past its own limit for a child', async () => {
    process.env.TABLE_SQL_TIMEOUT_MS = '800';
    const endless = Promise.allSettled(Array.from({ length: 4 }, () => runTableSql(file, ENDLESS)));
    process.env.TABLE_SQL_TIMEOUT_MS = '50';
    await expect(runTableSql(file, 'SELECT 1 AS one')).rejects.toThrow(/busy/);
    await endless;
  });
});
