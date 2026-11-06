/**
 * host.db.batch on the real SQL runner: an app's writes all or nothing, in a
 * real child on a real file. No Postgres. The Bun lane runs this file too, with
 * a Bun child: it holds the proofs the batch needs on that runtime (the rule
 * swap inside a transaction, a guard with no row, RETURNING, RAISE(ROLLBACK),
 * the memory limit, a kill on a real file, a large job over IPC).
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_SQL_BATCH_BUSY_MS,
  AppDbGuardError,
  AppDbRestoringError,
  AppSqlBatchError,
  AppSqlBusyError,
  AppSqlError,
  appSqlChildPids,
  copyAppDbFile,
  runAppDataBatch,
  runAppSql,
} from './app-sql-runner';

const st = (sql: string, ...params: unknown[]) => ({ sql, params });
/** Runs for a good while on any box, and the time limit stops it. */
const ENDLESS =
  'INSERT INTO t (x) SELECT x FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c)';

describe('runAppDataBatch', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'app-sql-batch-'));
  const file = path.join(dir, 'app.sqlite');
  const count = async (table = 't') => {
    const rows = (await runAppSql(file, {
      sql: `SELECT count(*) AS n FROM ${table}`,
      mode: 'all',
      readOnly: true,
    })) as { n: number }[];
    return rows[0]!.n;
  };
  const ddl = (sql: string) => runAppSql(file, { sql, mode: 'script', readOnly: false });
  /** A clean slate for one test: `t` empty. */
  const empty = () =>
    runAppSql(file, { sql: 'DELETE FROM t', mode: 'run', readOnly: false }).then(() => undefined);

  beforeAll(async () => {
    await ddl(`
      CREATE TABLE t (x INTEGER);
      CREATE TABLE u (k TEXT UNIQUE);
      CREATE TABLE lock_row (id INTEGER PRIMARY KEY, holder TEXT);
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (p INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TABLE trig (x INTEGER);
      CREATE TRIGGER trig_rollback BEFORE INSERT ON trig WHEN new.x = 2
        BEGIN SELECT RAISE(ROLLBACK, 'told to stop'); END;
      CREATE TRIGGER trig_words BEFORE INSERT ON trig WHEN new.x = 3
        BEGIN SELECT RAISE(ABORT, 'guard'); END;
      CREATE TRIGGER trig_restoring BEFORE INSERT ON trig WHEN new.x = 4
        BEGIN SELECT RAISE(ABORT, 'restoring'); END;
      CREATE TRIGGER trig_locked BEFORE INSERT ON trig WHEN new.x = 5
        BEGIN SELECT RAISE(ABORT, 'database is locked'); END;
    `);
    // The server's own run log, as a timer's first run makes it: app text may
    // never write it.
    const seed = new DatabaseSync(file);
    seed.exec('CREATE TABLE _timer_runs (id INTEGER PRIMARY KEY, timer_id TEXT)');
    seed.close();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('commits every statement, and answers one change count each', async () => {
    await empty();
    await expect(
      runAppDataBatch(file, [
        st('INSERT INTO t VALUES (?)', 1),
        st('INSERT INTO t VALUES (2), (3)'),
        st('UPDATE t SET x = x + 10 WHERE x > 1'),
      ]),
    ).resolves.toEqual([1, 2, 2]);
    expect(await count()).toBe(3);
  });

  it('a failed statement leaves nothing, and the error names it', async () => {
    await empty();
    const err = await runAppDataBatch(file, [
      st('INSERT INTO t VALUES (1)'),
      st('INSERT INTO u VALUES (?)', 'a'),
      st('INSERT INTO u VALUES (?)', 'a'),
      st('INSERT INTO t VALUES (2)'),
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppSqlBatchError);
    expect((err as AppSqlBatchError).at).toBe(2);
    expect((err as Error).message).toMatch(/^statement 3 of 4: UNIQUE constraint failed: u\.k$/);
    expect(await count()).toBe(0);
    expect(await count('u')).toBe(0);
  });

  it('a syntax error in a later statement leaves nothing', async () => {
    await empty();
    await expect(
      runAppDataBatch(file, [st('INSERT INTO t VALUES (1)'), st('INSERT INTO nope VALUES (1)')]),
    ).rejects.toThrow(/^statement 2 of 2: no such table: nope$/);
    expect(await count()).toBe(0);
  });

  describe('the guard', () => {
    it('passes on a row, and refuses no row (undefined on Node, null on Bun)', async () => {
      await empty();
      await expect(
        runAppDataBatch(file, [st('INSERT INTO t VALUES (1)')], { guard: st('SELECT 1') }),
      ).resolves.toEqual([1]);
      await expect(
        runAppDataBatch(file, [st('INSERT INTO t VALUES (2)')], {
          guard: st('SELECT 1 FROM t WHERE x = ?', 99),
        }),
      ).rejects.toBeInstanceOf(AppDbGuardError);
      expect(await count()).toBe(1);
    });

    it.each([
      ['a count of 0', 'SELECT count(*) FROM t WHERE x = 99'],
      ['NULL', 'SELECT NULL'],
      ['a real 0', 'SELECT 0.0'],
      ['a false', 'SELECT 1 = 2'],
      ['a max over no rows', 'SELECT max(x) FROM t WHERE x = 99'],
    ])('reads %s as no', async (_name, sql) => {
      await empty();
      await expect(
        runAppDataBatch(file, [st('INSERT INTO t VALUES (1)')], { guard: st(sql) }),
      ).rejects.toBeInstanceOf(AppDbGuardError);
      expect(await count()).toBe(0);
    });

    it.each([
      ['a count above 0', 'SELECT count(*) + 1 FROM t'],
      ['text', "SELECT 'held'"],
      ['a negative', 'SELECT -1'],
    ])('reads %s as yes', async (_name, sql) => {
      await empty();
      await expect(
        runAppDataBatch(file, [st('INSERT INTO t VALUES (1)')], { guard: st(sql) }),
      ).resolves.toEqual([1]);
    });

    it.each([
      ['two columns of one name', 'SELECT 0 AS a, 1 AS a'],
      ['a later column named like a number', 'SELECT 0 AS ok, 5 AS "1"'],
    ])('reads the first column by position, not by name: %s', async (_name, sql) => {
      await empty();
      await expect(
        runAppDataBatch(file, [st('INSERT INTO t VALUES (1)')], { guard: st(sql) }),
      ).rejects.toBeInstanceOf(AppDbGuardError);
      expect(await count()).toBe(0);
    });

    it('only reads: a guard that writes is refused, and writes nothing', async () => {
      await empty();
      const err = await runAppDataBatch(file, [st('INSERT INTO t VALUES (1)')], {
        guard: st('INSERT INTO t VALUES (2) RETURNING 1'),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppSqlBatchError);
      expect((err as AppSqlBatchError).at).toBe('guard');
      expect((err as Error).message).toMatch(/^guard: not authorized$/);
      expect(await count()).toBe(0);
    });

    it('a trigger that RAISEs the word "guard" is a failed statement, not a guard refusal', async () => {
      const err = await runAppDataBatch(file, [st('INSERT INTO trig VALUES (3)')]).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AppSqlBatchError);
      expect(err).not.toBeInstanceOf(AppDbGuardError);
    });

    it('a trigger that RAISEs the words of a busy database is a failed statement too', async () => {
      const err = await runAppDataBatch(file, [st('INSERT INTO trig VALUES (5)')]).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AppSqlBatchError);
      expect(err).not.toBeInstanceOf(AppSqlBusyError);
    });

    it('reads under the write lock: a batch that starts inside another sees what it did', async () => {
      await empty();
      await runAppSql(file, {
        sql: "INSERT OR REPLACE INTO lock_row VALUES (2, 'pat')",
        mode: 'run',
        readOnly: false,
      });
      const guard = st('SELECT 1 FROM lock_row WHERE id = 2');
      const first = runAppDataBatch(
        file,
        [
          st('DELETE FROM lock_row WHERE id = 2'),
          // A pause with the lock held, well under the second one's busy wait.
          st(
            'SELECT count(*) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 4000000) SELECT x FROM c)',
          ),
        ],
        { guard },
      );
      await new Promise((r) => setTimeout(r, 50));
      await expect(
        runAppDataBatch(file, [st('INSERT INTO t VALUES (1)')], { guard }),
      ).rejects.toBeInstanceOf(AppDbGuardError);
      await first;
      expect(await count()).toBe(0);
    }, 30_000);

    it('a trigger that RAISEs the word "restoring" is a failed statement too', async () => {
      const err = await runAppDataBatch(file, [st('INSERT INTO trig VALUES (4)')]).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AppSqlBatchError);
      expect(err).not.toBeInstanceOf(AppDbRestoringError);
    });

    it('a lost lock: two batches race for one row, and the second is refused', async () => {
      await runAppSql(file, {
        sql: "INSERT OR REPLACE INTO lock_row VALUES (1, 'pat')",
        mode: 'run',
        readOnly: false,
      });
      const guard = st('SELECT 1 FROM lock_row WHERE id = 1');
      const release = [st('DELETE FROM lock_row WHERE id = 1'), st('INSERT INTO t VALUES (7)')];
      await empty();
      const out = await Promise.allSettled([
        runAppDataBatch(file, release, { guard }),
        runAppDataBatch(file, release, { guard }),
      ]);
      expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const lost = out.find((o) => o.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(AppDbGuardError);
      expect(await count()).toBe(1);
    });
  });

  describe('author text never touches the transaction', () => {
    it.each([
      ['BEGIN', /not authorized/],
      ['BEGIN IMMEDIATE', /not authorized/],
      ['COMMIT', /not authorized/],
      ['ROLLBACK', /not authorized/],
      ['SAVEPOINT s', /not authorized/],
      ['RELEASE s', /not authorized/],
      ['CREATE TABLE IF NOT EXISTS t (x INTEGER)', /not authorized/],
      ['CREATE TABLE z (x)', /not authorized/],
      ['DROP TABLE t', /not authorized/],
      ['ALTER TABLE t ADD COLUMN y', /not authorized/],
      ['CREATE TRIGGER z AFTER INSERT ON t BEGIN SELECT 1; END', /not authorized/],
      ['PRAGMA table_info(t)', /not authorized/],
      ["UPDATE sqlite_master SET sql = ''", /not authorized|may not be modified/],
      ['INSERT INTO _timer_runs (timer_id) VALUES (1)', /not authorized/],
    ])(
      '%s is refused, with a guard or none, and the write before it does not stay',
      async (sql, words) => {
        for (const opts of [{}, { guard: st('SELECT 1') }]) {
          await empty();
          const err = await runAppDataBatch(
            file,
            [st('INSERT INTO t VALUES (1)'), st(sql)],
            opts,
          ).catch((e: unknown) => e);
          expect(err).toBeInstanceOf(AppSqlBatchError);
          expect((err as Error).message).toMatch(/^statement 2 of 2: /);
          expect((err as Error).message).toMatch(words);
          expect(await count()).toBe(0);
        }
      },
    );
  });

  it("a trigger's RAISE(ROLLBACK) in statement 2 of 3 leaves nothing", async () => {
    await empty();
    await expect(
      runAppDataBatch(file, [
        st('INSERT INTO t VALUES (1)'),
        st('INSERT INTO trig VALUES (2)'),
        st('INSERT INTO t VALUES (2)'),
      ]),
    ).rejects.toThrow(/^statement 2 of 3: told to stop$/);
    expect(await count()).toBe(0);
    expect(await count('trig')).toBe(0);
  });

  describe('one statement per entry, by what the engine read', () => {
    const NUL = String.fromCharCode(0);
    it.each([
      ['a second statement', 'INSERT INTO t VALUES (1); DELETE FROM t'],
      ['behind an apostrophe in a comment', "INSERT INTO t VALUES (1) -- it's\n; DELETE FROM t"],
      ['behind a block comment', "INSERT INTO t VALUES (1) /* it's */ ; DELETE FROM t"],
      ['behind a bracketed variable', "INSERT INTO t VALUES ($a(') ); DELETE FROM t; --'"],
      [
        'behind a variable with a wide name',
        "INSERT INTO t VALUES ($\u00e9(') ); DELETE FROM t; --'",
      ],
      ['behind a wide blank', "INSERT INTO t VALUES ($a(\u00a0') ); DELETE FROM t; --'"],
      ['behind a NUL', `INSERT INTO t VALUES (1)${NUL} DELETE FROM t`],
      // Wider in bytes than its tail: a length in bytes would swallow the tail.
      [
        'behind wide text',
        "INSERT INTO t VALUES (length('日本語日本語日本語日本語'));DELETE FROM t",
      ],
    ])('%s is refused, and nothing stays', async (_name, sql) => {
      await empty();
      await runAppSql(file, { sql: 'INSERT INTO t VALUES (9)', mode: 'run', readOnly: false });
      await expect(runAppDataBatch(file, [st(sql)])).rejects.toThrow(
        /^statement 1 of 1: one statement per entry/,
      );
      expect(await count()).toBe(1);
    });

    it('a text the engine did not read as written is refused, in its own words', async () => {
      await empty();
      await expect(
        runAppDataBatch(file, [st("INSERT INTO t VALUES (length('\ud800'))")]),
      ).rejects.toThrow(/^statement 1 of 1: the database did not read this text as written/);
      expect(await count()).toBe(0);
    });

    it('a guard is held to it too', async () => {
      await empty();
      await expect(
        runAppDataBatch(file, [st('INSERT INTO t VALUES (1)')], {
          guard: st('SELECT 1; DELETE FROM t'),
        }),
      ).rejects.toThrow(/^guard: one statement per entry/);
      expect(await count()).toBe(0);
    });

    it.each([
      'INSERT INTO t VALUES (1);',
      'INSERT INTO t VALUES (1) ; ;; ',
      'INSERT INTO t VALUES (1); -- done',
      "INSERT INTO t VALUES (1); /* it's done */\n-- and more\n",
      'INSERT INTO t VALUES (1); /* never closed',
      "-- first\nINSERT INTO t VALUES (length('a;b'))",
      "INSERT INTO t VALUES (length('日本語')); -- 日本語",
    ])('%j passes', async (sql) => {
      await empty();
      await expect(runAppDataBatch(file, [st(sql)])).resolves.toEqual([1]);
      expect(await count()).toBe(1);
    });
  });

  it('a repeated statement with fewer values binds them afresh', async () => {
    await empty();
    await runAppDataBatch(file, [
      st('INSERT INTO t VALUES (?)', 5),
      st('INSERT INTO t VALUES (?)'),
    ]);
    const rows = (await runAppSql(file, {
      sql: 'SELECT x FROM t ORDER BY rowid',
      mode: 'all',
      readOnly: true,
    })) as { x: number | null }[];
    expect(rows.map((r) => r.x)).toEqual([5, null]);
  });

  it('a file not yet in WAL, held by another writer, answers busy as well', async () => {
    const plain = path.join(dir, 'plain.sqlite');
    const holder = new DatabaseSync(plain);
    holder.exec('CREATE TABLE p (x); BEGIN EXCLUSIVE');
    try {
      await expect(runAppDataBatch(plain, [st('INSERT INTO p VALUES (1)')])).rejects.toBeInstanceOf(
        AppSqlBusyError,
      );
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  }, 15_000);

  it('INSERT OR ROLLBACK ends the transaction and the batch', async () => {
    await empty();
    await runAppDataBatch(file, [st("INSERT INTO u VALUES ('held')")]);
    await expect(
      runAppDataBatch(file, [
        st('INSERT INTO t VALUES (1)'),
        st("INSERT OR ROLLBACK INTO u VALUES ('held')"),
        st('INSERT INTO t VALUES (2)'),
      ]),
    ).rejects.toThrow(/^statement 2 of 3: UNIQUE/);
    expect(await count()).toBe(0);
    await runAppDataBatch(file, [st("DELETE FROM u WHERE k = 'held'")]);
  });

  it('a deferred foreign key fails at the commit, and leaves nothing', async () => {
    await empty();
    const err = await runAppDataBatch(file, [
      st('INSERT INTO t VALUES (1)'),
      st('INSERT INTO child VALUES (99)'),
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppSqlBatchError);
    expect((err as AppSqlBatchError).at).toBe('commit');
    expect((err as Error).message).toMatch(/^at commit: FOREIGN KEY constraint failed$/);
    expect(await count()).toBe(0);
    expect(await count('child')).toBe(0);
    // The lock is free again.
    await expect(runAppDataBatch(file, [st('INSERT INTO t VALUES (1)')])).resolves.toEqual([1]);
  });

  it('counts RETURNING as a change and hands no row back', async () => {
    await empty();
    await expect(
      runAppDataBatch(file, [st('INSERT INTO t VALUES (1), (2) RETURNING x')]),
    ).resolves.toEqual([2]);
    expect(await count()).toBe(2);
  });

  it('last_insert_rowid() links rows inside a batch', async () => {
    await runAppSql(file, { sql: 'DELETE FROM parent', mode: 'run', readOnly: false });
    await runAppSql(file, { sql: 'DELETE FROM child', mode: 'run', readOnly: false });
    await runAppDataBatch(file, [
      st('INSERT INTO parent VALUES (NULL)'),
      st('INSERT INTO child VALUES (last_insert_rowid())'),
    ]);
    expect(await count('child')).toBe(1);
  });

  it('a batch stopped at the time limit leaves nothing, and the next write goes straight through', async () => {
    await empty();
    const before = appSqlChildPids();
    await expect(
      runAppDataBatch(file, [st('INSERT INTO t VALUES (1)'), st(ENDLESS)], { timeoutMs: 400 }),
    ).rejects.toThrow(/the batch ran longer than 400 ms and was stopped\. It may have landed/);
    expect(appSqlChildPids().filter((p) => !before.includes(p))).toEqual([]);
    const started = Date.now();
    await expect(runAppDataBatch(file, [st('INSERT INTO t VALUES (2)')])).resolves.toEqual([1]);
    expect(Date.now() - started).toBeLessThan(APP_SQL_BATCH_BUSY_MS);
    expect(await count()).toBe(1);
  });

  it('a child killed from outside mid-batch leaves nothing on the real file', async () => {
    await empty();
    const pending = runAppDataBatch(file, [st('INSERT INTO t VALUES (1)'), st(ENDLESS)], {
      timeoutMs: 30_000,
    }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 300));
    for (const pid of appSqlChildPids()) process.kill(pid, 'SIGKILL');
    const err = await pending;
    expect(err).toBeInstanceOf(AppSqlError);
    expect(await count()).toBe(0);
    await expect(runAppDataBatch(file, [st('INSERT INTO t VALUES (2)')])).resolves.toEqual([1]);
  });

  it('two batches at once run one after the other, both whole, and a reader never sees part of one', async () => {
    await empty();
    const size = 500;
    const load = (from: number) =>
      runAppDataBatch(
        file,
        Array.from({ length: size }, (_, i) => st('INSERT INTO t VALUES (?)', from + i)),
      );
    const seen = new Set<number>();
    let done = false;
    const reader = (async () => {
      while (!done) seen.add(await count());
    })();
    const [a, b] = await Promise.all([load(0), load(1000)]);
    done = true;
    await reader;
    expect(a).toHaveLength(size);
    expect(b).toHaveLength(size);
    expect(await count()).toBe(size * 2);
    for (const n of seen) expect([0, size, size * 2]).toContain(n);
  });

  it('another writer holding the lock past the wait answers busy, and nothing is written', async () => {
    await empty();
    const holder = runAppDataBatch(file, [st(ENDLESS)], {
      timeoutMs: APP_SQL_BATCH_BUSY_MS + 1_500,
    }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    const err = await runAppDataBatch(file, [st('INSERT INTO t VALUES (1)')]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppSqlBusyError);
    expect(Date.now() - started).toBeLessThan(APP_SQL_BATCH_BUSY_MS + 1_000);
    await holder;
    expect(await count()).toBe(0);
  });

  it('a snapshot taken in the middle of a batch holds none of it', async () => {
    await empty();
    let finished = false;
    const batch = runAppDataBatch(
      file,
      [
        st('INSERT INTO t VALUES (-1)'),
        // Long enough for the copy below to land inside the batch.
        st(
          'SELECT count(*) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 30000000) SELECT x FROM c)',
        ),
      ],
      { timeoutMs: 30_000 },
    ).then(() => {
      finished = true;
    });
    await new Promise((r) => setTimeout(r, 200));
    const dest = path.join(dir, 'copy.sqlite');
    rmSync(dest, { force: true });
    await copyAppDbFile(file, dest);
    const inside = !finished;
    const seen = (await runAppSql(dest, {
      sql: 'SELECT count(*) AS n FROM t',
      mode: 'all',
      readOnly: true,
    })) as { n: number }[];
    expect(inside).toBe(true);
    expect(seen[0]!.n).toBe(0);
    await batch;
    expect(await count()).toBe(1);
  }, 60_000);

  it('a file under restore answers busy, and nothing is written', async () => {
    await empty();
    const marker = `${file}.restoring`;
    writeFileSync(marker, 'x');
    try {
      await expect(runAppDataBatch(file, [st('INSERT INTO t VALUES (1)')])).rejects.toBeInstanceOf(
        AppDbRestoringError,
      );
    } finally {
      rmSync(marker, { force: true });
    }
    expect(await count()).toBe(0);
  });

  it('a batch past the file cap rolls back whole', async () => {
    const small = path.join(dir, 'small.sqlite');
    const MB = 1024 * 1024;
    await runAppSql(small, {
      sql: 'CREATE TABLE b (x BLOB)',
      mode: 'script',
      readOnly: false,
    });
    const err = await runAppDataBatch(
      small,
      [
        st('INSERT INTO b VALUES (zeroblob(1000))'),
        st('INSERT INTO b VALUES (randomblob(2000000))'),
      ],
      { maxDbBytes: MB },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppSqlBatchError);
    expect((err as Error).message).toMatch(/^statement 2 of 2: database or disk is full$/);
    expect(statSync(small).size).toBeLessThanOrEqual(MB);
    const rows = (await runAppSql(small, {
      sql: 'SELECT count(*) AS n FROM b',
      mode: 'all',
      readOnly: true,
    })) as { n: number }[];
    expect(rows[0]!.n).toBe(0);
  });

  // The kernel limit on a child is set on Linux only.
  it.runIf(process.platform === 'linux')(
    'a statement at the memory limit answers the step words, ends its child, and leaves nothing',
    async () => {
      await empty();
      // SQLite's code must survive the batch's handling: the words here come
      // only from that code (or the engine's own error on Bun), and the
      // child goes.
      const columns = Array.from({ length: 64 }, (_, i) => `c${i}`).join(', ');
      await ddl(`CREATE TABLE IF NOT EXISTS wide (${columns})`);
      const values = Array.from({ length: 64 }, () => 'hex(zeroblob(8388600))').join(', ');
      const err = await runAppDataBatch(
        file,
        [st('INSERT INTO t VALUES (1)'), st(`INSERT INTO wide VALUES (${values})`)],
        { timeoutMs: 60_000 },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppSqlError);
      expect((err as Error).message).toMatch(
        /this step needs more memory than a SQL process may use|may be too large for it/,
      );
      expect(await count()).toBe(0);
    },
    90_000,
  );

  it('takes a job of 8 MiB over IPC', async () => {
    await empty();
    const text = 'x'.repeat(1024 * 1024);
    const statements = Array.from({ length: 8 }, () =>
      st('INSERT INTO u VALUES (? || ?)', text, ''),
    );
    statements.forEach((s, i) => {
      s.params[1] = String(i);
    });
    await expect(runAppDataBatch(file, statements, { timeoutMs: 30_000 })).resolves.toEqual(
      Array.from({ length: 8 }, () => 1),
    );
    expect(await count('u')).toBe(8);
    await runAppDataBatch(file, [st('DELETE FROM u')]);
  }, 60_000);

  it('a caller waits its turn instead of hearing busy', async () => {
    await empty();
    const slow = st(
      'SELECT count(*) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c LIMIT 200000000)',
    );
    // Holds the write lock past the busy wait, until its time limit stops it.
    const first = runAppDataBatch(file, [st('INSERT INTO t VALUES (1)'), slow], {
      callerKey: 'c:1',
      timeoutMs: APP_SQL_BATCH_BUSY_MS + 800,
    }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 200));
    const second = await runAppDataBatch(file, [st('INSERT INTO t VALUES (2)')], {
      callerKey: 'c:1',
    });
    expect(second).toEqual([1]);
    expect(await first).toBeInstanceOf(AppSqlError);
    expect(await count()).toBe(1);
  }, 30_000);
});

/**
 * An author's host.db.exec('BEGIN') on the Admin path: the plain rule, no
 * data-only. Each job has its own connection, so a transaction cannot span
 * two calls.
 */
describe("an author's exec('BEGIN') on the Admin path", () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'app-sql-begin-'));
  const file = path.join(dir, 'app.sqlite');
  const exec = (sql: string) => runAppSql(file, { sql, mode: 'run', readOnly: false });
  const count = async () =>
    (
      (await runAppSql(file, {
        sql: 'SELECT count(*) AS n FROM t',
        mode: 'all',
        readOnly: true,
      })) as { n: number }[]
    )[0]!.n;
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  beforeAll(async () => {
    await exec('CREATE TABLE t (x INTEGER)');
  });

  it.each(['BEGIN', 'BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK', 'END', 'SAVEPOINT s', 'RELEASE s'])(
    '%s is refused: it could only promise a transaction it cannot hold',
    async (sql) => {
      await expect(exec(sql)).rejects.toThrow(/not authorized: .*use host\.db\.batch/);
    },
  );

  it('so the pattern stops at its first step, before any row', async () => {
    const steps = async () => {
      await exec('BEGIN');
      await exec('INSERT INTO t VALUES (1)');
      await exec('ROLLBACK');
    };
    await expect(steps()).rejects.toThrow(/use host\.db\.batch/);
    expect(await count()).toBe(0);
  });

  it('a plain write still answers as it did', async () => {
    await expect(exec('INSERT INTO t VALUES (2)')).resolves.toEqual({
      changes: 1,
      lastInsertRowid: expect.any(Number),
    });
    await exec('DELETE FROM t');
  });

  it('a schema script keeps its own transaction', async () => {
    await expect(
      runAppSql(file, {
        sql: 'CREATE TABLE s (x); CREATE TABLE s2 (x)',
        mode: 'script',
        readOnly: false,
      }),
    ).resolves.toMatchObject({ skipped: false });
  });
});
