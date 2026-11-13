import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TableSqlError,
  __setRefusalPaceForTests,
  fileDbReadersDefault,
  runReadOnlySql,
  runTableSql,
  tableSqlChildPids,
} from './sql-runner';
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
    // These tests count on a pool of 4, whatever the cores of the runner.
    process.env.FILE_DB_READERS = '4';
  });
  afterEach(() => {
    delete process.env.TABLE_SQL_TIMEOUT_MS;
    delete process.env.FILE_DB_READERS;
  });

  // No pid here, so this holds for any way of running the query: a thread that
  // survives its limit shows up as CPU in this process. It runs first, because
  // on a build where the query survives, it is the failure that says so.
  it('this child binds no value, so fts3_tokenizer hands out no address', async () => {
    const r = await runTableSql(file, "SELECT hex(fts3_tokenizer('simple')) AS p");
    expect(r.rows).toEqual([['']]);
    await expect(
      runTableSql(file, "SELECT fts3_tokenizer('mine', x'4141414141414141') AS p"),
    ).rejects.toThrow(/fts3tokenize disabled/);
  });

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

describe('the reader limit and rows in memory (file_sql over many files)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tabledb-readers-'));
  const file = path.join(dir, 'drawing.sqlite');
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (err) {
      return err instanceof TableSqlError ? err.code : `other: ${String(err)}`;
    }
  };

  beforeAll(() => {
    const db = openTableFile(file, { mustExist: false });
    db.exec("CREATE TABLE t (n INTEGER, s TEXT); INSERT INTO t VALUES (1, 'a'), (2, 'b')");
    db.close();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => {
    delete process.env.TABLE_SQL_TIMEOUT_MS;
    delete process.env.FILE_DB_READERS;
  });

  it('the default is half the cores, at least 1, at most 4', () => {
    expect([1, 2, 3, 4, 8, 16, 64].map((c) => fileDbReadersDefault(c))).toEqual([
      1, 1, 1, 2, 4, 4, 4,
    ]);
  });

  it('N + 1 readers: one waits, then hears busy, and no more than N processes run', async () => {
    process.env.FILE_DB_READERS = '2';
    process.env.TABLE_SQL_TIMEOUT_MS = '600';
    const seen = new Set<number>();
    const watch = setInterval(() => tableSqlChildPids().forEach((p) => seen.add(p)), 5);
    // Their codes are taken at once, so no rejection goes unseen.
    const endless = [code(runTableSql(file, ENDLESS)), code(runTableSql(file, ENDLESS))];
    await sleep(100);
    // Its own wait is short: the slots stay held past it.
    process.env.TABLE_SQL_TIMEOUT_MS = '100';
    const third = runTableSql(file, 'SELECT 1 AS one');
    await expect(third).rejects.toThrow(
      /busy, every file database reader .* try again in a few seconds/,
    );
    expect(await code(third)).toBe('busy');
    expect(await Promise.all(endless)).toEqual(['timeout', 'timeout']);
    clearInterval(watch);
    expect(tableSqlChildPids().length).toBeLessThanOrEqual(2);
    expect(seen.size).toBeLessThanOrEqual(2);
  });

  it('a short read waiting behind a long one gets the reader when it comes free', async () => {
    process.env.FILE_DB_READERS = '1';
    process.env.TABLE_SQL_TIMEOUT_MS = '3000';
    const slow = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 300000)
      SELECT count(*) AS n FROM c`;
    const long = runTableSql(file, slow);
    const short = runTableSql(file, 'SELECT n FROM t ORDER BY n LIMIT 1');
    await expect(short).resolves.toMatchObject({ rows: [[1]] });
    await expect(long).resolves.toMatchObject({ rows: [[300000]] });
  });

  it('gives each failure its code', async () => {
    process.env.TABLE_SQL_TIMEOUT_MS = '2000';
    expect(await code(runReadOnlySql({ file }, 'SELECT * FROM nope', { cap: 5 }))).toBe('sql');
    expect(await code(runReadOnlySql({ file }, 'SELEC 1', { cap: 5 }))).toBe(
      'other: Error: table_sql is read-only: the statement must start with SELECT or WITH',
    );
    expect(await code(runReadOnlySql({ file }, ENDLESS, { cap: 5, limitMs: 200 }))).toBe('timeout');
    const wide = `with recursive c(x) as (select 1 union all select x+1 from c where x < 20)
      select zeroblob(100000) as b from c`;
    expect(await code(runReadOnlySql({ file }, wide, { cap: 50, maxReplyBytes: 500_000 }))).toBe(
      'too-big',
    );
  });

  it('a cap past the table_sql cap is taken as given', async () => {
    process.env.TABLE_SQL_TIMEOUT_MS = '5000';
    const many = `with recursive c(x) as (select 1 union all select x+1 from c where x < 3000)
      select x from c`;
    const r = await runReadOnlySql({ file }, many, { cap: 2500 });
    expect(r.rowCount).toBe(2500);
    expect(r.truncated).toBe(true);
  });

  describe('rows in memory as table results', () => {
    const results = {
      columns: ['_file_id', '_file', 'Key', 'n'],
      rows: [
        ['f1', 'a.dwg', 'VALVE', 1],
        ['f1', 'a.dwg', 'PUMP', 2],
        ['f2', 'b.dwg', 'VALVE', 3],
        ['f2', 'b.dwg', null, new Uint8Array([7])],
      ],
    };

    it('runs a statement over them, values as they were', async () => {
      process.env.TABLE_SQL_TIMEOUT_MS = '5000';
      const r = await runReadOnlySql(
        { results },
        'SELECT "Key", count(*) AS c, count(DISTINCT "_file_id") AS files FROM results WHERE "Key" IS NOT NULL GROUP BY "Key" ORDER BY "Key"',
        { cap: 10 },
      );
      expect(r.columns).toEqual(['Key', 'c', 'files']);
      expect(r.rows).toEqual([
        ['PUMP', 1, 1],
        ['VALVE', 2, 2],
      ]);
      const blob = await runReadOnlySql({ results }, 'SELECT n FROM results WHERE "Key" IS NULL', {
        cap: 1,
      });
      expect(blob.rows[0]![0]).toEqual(new Uint8Array([7]));
    });

    it('a name with a quote in it is a column, not SQL', async () => {
      process.env.TABLE_SQL_TIMEOUT_MS = '5000';
      const r = await runReadOnlySql(
        { results: { columns: ['a"); DROP TABLE x; --'], rows: [[1]] } },
        'SELECT * FROM results',
        { cap: 1 },
      );
      expect(r.columns).toEqual(['a"); DROP TABLE x; --']);
    });

    it.each([
      ['INSERT INTO results VALUES (1, 2, 3, 4)'],
      ['WITH x AS (SELECT 1) INSERT INTO results SELECT 1, 2, 3, 4 FROM x'],
      ["ATTACH DATABASE '/tmp/x.sqlite' AS x"],
      ["SELECT * FROM results; ATTACH DATABASE '/tmp/x.sqlite' AS x"],
      ['PRAGMA writable_schema = 1'],
      ["SELECT * FROM pragma_table_info('results')"],
      ['CREATE TABLE y (a)'],
      ['DELETE FROM results'],
      ["SELECT load_extension('/tmp/x.so')"],
    ])('refuses %s', async (statement) => {
      process.env.TABLE_SQL_TIMEOUT_MS = '5000';
      await expect(runReadOnlySql({ results }, statement, { cap: 5 })).rejects.toThrow();
      // And the rows are still there for the next statement.
      const r = await runReadOnlySql({ results }, 'SELECT count(*) AS n FROM results', { cap: 1 });
      expect(r.rows).toEqual([[4]]);
    });
  });
});
