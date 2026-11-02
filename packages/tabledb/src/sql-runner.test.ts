import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __setRefusalPaceForTests, runTableSql, tableSqlChildPids } from './sql-runner';
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

  it('refuses a value past the size limit, so its bytes never reach this process', async () => {
    process.env.TABLE_SQL_TIMEOUT_MS = '5000';
    await expect(runTableSql(file, 'SELECT zeroblob(943718400) AS b')).rejects.toThrow(/too big/);
  });

  it('refuses a reply past the size limit, and names the way out', async () => {
    process.env.TABLE_SQL_TIMEOUT_MS = '5000';
    const big = `with recursive c(x) as (select 1 union all select x+1 from c where x < 20)
      select zeroblob(1048576) as b from c`;
    await expect(runTableSql(file, big)).rejects.toThrow(/more than 16 MB: add a LIMIT/);
  });

  const noChildren = async () => {
    for (const pid of tableSqlChildPids()) process.kill(pid, 'SIGKILL');
    await vi.waitFor(() => expect(tableSqlChildPids()).toEqual([]));
  };

  it.each([
    // Each value is legal, and the row is built before the reply cap can read it.
    ['SQLite says it: values made while the row is built', 64, ''],
    ['the engine ends the process: values read one by one', 16, ' - n'],
  ])('refuses one wide row at the kernel limit (Linux): %s', async (_how, width, less) => {
    process.env.TABLE_SQL_TIMEOUT_MS = '10000';
    await noChildren();
    const cols = Array.from({ length: width }, (_, i) => `zeroblob(16777216${less}) AS c${i}`).join(
      ', ',
    );
    const seen = new Set<number>();
    const watch = setInterval(() => tableSqlChildPids().forEach((p) => seen.add(p)), 5);
    await expect(runTableSql(file, `SELECT ${cols}${less ? ' FROM t' : ''}`)).rejects.toThrow(
      process.platform === 'linux'
        ? /more memory than a SQL process|most likely at the memory limit/
        : /more than 16 MB/,
    );
    clearInterval(watch);
    // A new child's answer is the last: the same statement would end the next.
    expect(seen.size).toBeLessThanOrEqual(1);
    // That child goes, and the next statement gets one whose heap is whole.
    if (process.platform === 'linux') {
      await vi.waitFor(() => expect(tableSqlChildPids()).toEqual([]));
    }
    await expect(runTableSql(file, 'SELECT 1 AS a')).resolves.toMatchObject({ rows: [[1]] });
  });

  it.runIf(process.platform === 'linux')(
    'a read that fails at the limit on a used child gets one try on a new one',
    async () => {
      process.env.TABLE_SQL_TIMEOUT_MS = '10000';
      await noChildren();
      await runTableSql(file, 'SELECT 1 AS warm');
      const used = tableSqlChildPids();
      const cols = Array.from({ length: 64 }, (_, i) => `zeroblob(16777216) AS c${i}`).join(', ');
      const seen = new Set<number>();
      const watch = setInterval(() => tableSqlChildPids().forEach((p) => seen.add(p)), 5);
      let paced = 0;
      __setRefusalPaceForTests(async () => void paced++);
      try {
        await expect(runTableSql(file, `SELECT ${cols}`)).rejects.toThrow(
          /more memory than a SQL process|most likely at the memory limit/,
        );
      } finally {
        __setRefusalPaceForTests(async () => {});
      }
      clearInterval(watch);
      // The used child, then one new child, whose answer is the last.
      expect(seen).toContain(used[0]);
      expect(seen.size).toBe(2);
      // The second try forks at once; the next statement's fork waits its turn.
      expect(paced).toBe(0);
      __setRefusalPaceForTests(async () => void paced++);
      try {
        await expect(runTableSql(file, 'SELECT 1 AS a')).resolves.toMatchObject({ rows: [[1]] });
      } finally {
        __setRefusalPaceForTests(async () => {});
      }
      expect(paced).toBe(1);
    },
  );

  it('a second try gives its place back: the pool ends at its cap (Linux)', async () => {
    process.env.TABLE_SQL_TIMEOUT_MS = '20000';
    await noChildren();
    await Promise.all(Array.from({ length: 4 }, () => runTableSql(file, 'SELECT 1 AS warm')));
    const slow = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 4000000)
      SELECT count(*) AS n FROM c`;
    const all = Promise.all(Array.from({ length: 8 }, () => runTableSql(file, slow)));
    // A crash is what a second try answers. These four have served before.
    await vi.waitFor(() => expect(tableSqlChildPids()).toHaveLength(4));
    for (const pid of tableSqlChildPids()) process.kill(pid, 'SIGABRT');
    let peak = 0;
    const watch = setInterval(() => (peak = Math.max(peak, tableSqlChildPids().length)), 1);
    await all;
    clearInterval(watch);
    // One place past the cap at most: four second tries share the fifth.
    expect(peak).toBeLessThanOrEqual(5);
    expect(tableSqlChildPids().length).toBeLessThanOrEqual(4);
  });

  it('answers a reply just under the size limit, under the kernel limit', async () => {
    process.env.TABLE_SQL_TIMEOUT_MS = '10000';
    const big = `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 15)
      select zeroblob(1048576) as b from c`;
    const out = await runTableSql(file, big);
    expect(out.rowCount).toBe(15);
    expect((await runTableSql(file, 'SELECT n FROM t LIMIT 1')).rows).toEqual([[1]]);
  });

  it('a child SIGKILLed mid-statement by someone else: one more try, on a new child', async () => {
    process.env.TABLE_SQL_TIMEOUT_MS = '20000';
    await runTableSql(file, 'SELECT 1 AS warm');
    const first = tableSqlChildPids();
    const slow = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000)
      SELECT count(*) AS n FROM c`;
    const seen = new Set<number>();
    const watch = setInterval(() => tableSqlChildPids().forEach((p) => seen.add(p)), 5);
    const out = runTableSql(file, slow);
    await sleep(50);
    for (const pid of first) process.kill(pid, 'SIGKILL');
    await expect(out).resolves.toMatchObject({ rows: [[3000000]] });
    clearInterval(watch);
    // Exactly one new child: the second try (the idle ones killed too are not
    // replaced until a statement needs them).
    expect([...seen].filter((p) => !first.includes(p))).toHaveLength(1);
  });

  it('runs a statement again when its child died between two statements', async () => {
    process.env.TABLE_SQL_TIMEOUT_MS = '5000';
    await runTableSql(file, 'SELECT 1 AS one');
    for (const pid of tableSqlChildPids()) process.kill(pid, 'SIGKILL');
    const r = await runTableSql(file, 'SELECT n FROM t LIMIT 1');
    expect(r.rows).toEqual([[1]]);
  });

  it('refuses a statement that waits past its own limit for a child', async () => {
    process.env.TABLE_SQL_TIMEOUT_MS = '800';
    const endless = Promise.allSettled(Array.from({ length: 4 }, () => runTableSql(file, ENDLESS)));
    process.env.TABLE_SQL_TIMEOUT_MS = '50';
    await expect(runTableSql(file, 'SELECT 1 AS one')).rejects.toThrow(/busy/);
    await endless;
  });
});
