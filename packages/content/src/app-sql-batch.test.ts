/**
 * host.db.batch on the real SQL runner: an app's writes all or nothing, in a
 * real child on a real file. No Postgres. The Bun lane runs this file too, with
 * a Bun child: it holds the proofs the batch needs on that runtime (the rule
 * swap inside a transaction, a guard with no row, RETURNING, RAISE(ROLLBACK),
 * the memory limit, a kill on a real file, a large job over IPC).
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adoptAppDbFile,
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
 * Full-text search in an app's own database, on every path. FTS5 asks for
 * PRAGMA data_version on its own: the one pragma the rules let through.
 */
/**
 * A file with a trigger on an index's own table, placed before the index in the
 * schema: the engine checks a trigger as it loads it, so it misses this order.
 */
function craftIndexTrigger(target: string, body: string, on = 's_data') {
  type Row = { type: string; name: string; tbl_name: string; rootpage: number; sql: string | null };
  const db = new DatabaseSync(target, { defensive: false });
  db.exec(
    'CREATE TABLE keep (x); CREATE TABLE _timer_runs (x); CREATE VIRTUAL TABLE s USING fts5(body);',
  );
  db.exec('PRAGMA writable_schema = ON');
  const rows = db
    .prepare('SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master')
    .all() as unknown as Row[];
  db.exec('DELETE FROM sqlite_master');
  const add = db.prepare(
    'INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES (?, ?, ?, ?, ?)',
  );
  const virtual = (r: Row) => /^CREATE VIRTUAL/i.test(r.sql ?? '');
  for (const r of rows.filter((x) => !virtual(x))) {
    add.run(r.type, r.name, r.tbl_name, r.rootpage, r.sql);
  }
  const trigger = `CREATE TRIGGER evil AFTER INSERT ON ${on} BEGIN ${body}; END`;
  add.run('trigger', 'evil', on, 0, trigger);
  for (const r of rows.filter(virtual)) add.run(r.type, r.name, r.tbl_name, r.rootpage, r.sql);
  db.exec('PRAGMA writable_schema = OFF');
  db.close();
}

describe('FTS5 in an app database', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'app-sql-fts-'));
  const file = path.join(dir, 'app.sqlite');
  const read = (sql: string, ...params: unknown[]) =>
    runAppSql(file, { sql, params, mode: 'all', readOnly: true }) as Promise<
      Record<string, unknown>[]
    >;
  const hits = async (term: string) =>
    (await read('SELECT rowid AS id FROM docs WHERE docs MATCH ? ORDER BY rowid', term)).map(
      (r) => r.id,
    );
  const member = (sql: string, ...params: unknown[]) =>
    runAppSql(file, { sql, params, mode: 'run', readOnly: false, dataOnly: true });

  beforeAll(async () => {
    await runAppSql(file, {
      sql: `CREATE VIRTUAL TABLE docs USING fts5(title, body);
            CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT);
            CREATE VIRTUAL TABLE items_fts USING fts5(body, content='items', content_rowid='id');
            CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
              INSERT INTO items_fts (rowid, body) VALUES (new.id, new.body);
            END;`,
      mode: 'script',
      readOnly: false,
    });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a read finds a word, ranks it and marks it', async () => {
    await runAppSql(file, {
      sql: "INSERT INTO docs (rowid, title, body) VALUES (1, 'pump', 'the feed pump failed')",
      mode: 'run',
      readOnly: false,
    });
    expect(await hits('feed')).toEqual([1]);
    const rows = await read(
      "SELECT bm25(docs) AS rank, snippet(docs, 1, '[', ']', '', 4) AS s, highlight(docs, 0, '<', '>') AS h FROM docs WHERE docs MATCH 'pump'",
    );
    expect(rows[0]!.s).toContain('[pump]');
    expect(rows[0]!.h).toBe('<pump>');
    expect(typeof rows[0]!.rank).toBe('number');
  });

  it('a rows-only write reaches it, directly and through a trigger', async () => {
    await member("INSERT INTO docs (rowid, title, body) VALUES (2, 'valve', 'a member note')");
    expect(await hits('member')).toEqual([2]);
    await member("INSERT INTO items (body) VALUES ('from a trigger')");
    expect(await read("SELECT rowid FROM items_fts WHERE items_fts MATCH 'trigger'")).toHaveLength(
      1,
    );
    await member("UPDATE docs SET body = 'a changed note' WHERE rowid = 2");
    expect(await hits('member')).toEqual([]);
    await member('DELETE FROM docs WHERE rowid = 2');
    expect(await hits('changed')).toEqual([]);
  });

  it('a rows-only caller still cannot make one', async () => {
    await expect(member('CREATE VIRTUAL TABLE x USING fts5(a)')).rejects.toThrow(/not authorized/);
  });

  it('a batch writes it all or nothing, and a guard can search it', async () => {
    await runAppDataBatch(file, [
      st("INSERT INTO docs (rowid, title, body) VALUES (3, 'tank', 'batch word')"),
    ]);
    expect(await hits('batch')).toEqual([3]);
    await expect(
      runAppDataBatch(file, [
        st("INSERT INTO docs (rowid, title, body) VALUES (4, 'tank', 'rolled word')"),
        st('INSERT INTO nope VALUES (1)'),
      ]),
    ).rejects.toThrow(/^statement 2 of 2: /);
    expect(await hits('rolled')).toEqual([]);
    await expect(
      runAppDataBatch(file, [st("INSERT INTO docs (rowid, body) VALUES (5, 'guarded word')")], {
        guard: st("SELECT 1 FROM docs WHERE docs MATCH 'batch'"),
      }),
    ).resolves.toEqual([1]);
    await expect(
      runAppDataBatch(file, [st("INSERT INTO docs (rowid, body) VALUES (6, 'refused word')")], {
        guard: st("SELECT 1 FROM docs WHERE docs MATCH 'nothing'"),
      }),
    ).rejects.toBeInstanceOf(AppDbGuardError);
    expect(await hits('refused')).toEqual([]);
  });

  it("nobody writes the index's own tables by hand, Admin included", async () => {
    for (const table of ['docs_data', 'docs_idx', 'docs_config', 'docs_content', 'docs_docsize']) {
      const sql = `DELETE FROM ${table}`;
      await expect(member(sql)).rejects.toThrow(/may not be modified/);
      await expect(runAppSql(file, { sql, mode: 'run', readOnly: false })).rejects.toThrow(
        /may not be modified/,
      );
      await expect(runAppDataBatch(file, [st(sql)])).rejects.toThrow(/may not be modified/);
    }
    expect(await hits('batch')).toEqual([3]);
  });

  it('the guide schema: runs again, leaves no deleted word in the raw blocks, and deletes at the file cap', async () => {
    const small = path.join(dir, 'small.sqlite');
    const schema = `CREATE VIRTUAL TABLE IF NOT EXISTS s USING fts5(body);
      INSERT INTO s(s, rank) VALUES ('secure-delete', 1);`;
    for (const _ of [1, 2]) {
      await runAppSql(small, { sql: schema, mode: 'script', readOnly: false });
    }
    const cap = 2 * 1024 * 1024;
    const write = (sql: string, ...params: unknown[]) =>
      runAppSql(small, {
        sql,
        params,
        mode: 'run',
        readOnly: false,
        dataOnly: true,
        maxDbBytes: cap,
      });
    await write("INSERT INTO s (rowid, body) VALUES (1, 'secretword here')");
    await write('DELETE FROM s WHERE rowid = 1');
    const blocks = (await runAppSql(small, {
      sql: 'SELECT hex(block) AS h FROM s_data',
      mode: 'all',
      readOnly: true,
    })) as { h: string }[];
    const raw = blocks.map((b) => Buffer.from(b.h, 'hex').toString('latin1')).join('');
    expect(raw).not.toContain('secretword');
    // Fill the file to its cap, then every row can still go.
    let rows = 0;
    const words = (n: number) =>
      Array.from({ length: 800 }, (_w, i) => `w${n * 1000 + i}`).join(' ');
    await expect(
      (async () => {
        for (;;) await write('INSERT INTO s (rowid, body) VALUES (?, ?)', ++rows + 1, words(rows));
      })(),
    ).rejects.toThrow(/database or disk is full/);
    expect(rows).toBeGreaterThan(10);
    // The large row stopped short of the true cap: small rows go the rest of the way.
    await expect(
      (async () => {
        for (;;) await write('INSERT INTO s (rowid, body) VALUES (?, ?)', ++rows + 1, `x${rows}`);
      })(),
    ).rejects.toThrow(/database or disk is full/);
    const left = (await runAppSql(small, {
      sql: 'SELECT rowid AS id FROM s',
      mode: 'all',
      readOnly: true,
    })) as { id: number }[];
    expect(left.length).toBeGreaterThan(10);
    for (const { id } of left) {
      await expect(write('DELETE FROM s WHERE rowid = ?', id)).resolves.toMatchObject({
        changes: 1,
      });
    }
    await expect(write("INSERT INTO s(s) VALUES ('integrity-check')")).resolves.toBeDefined();
  }, 120_000);

  it("the limit the guide states: a page's first word can stay in _idx until a rebuild", async () => {
    const f = path.join(dir, 'idx.sqlite');
    await runAppSql(f, {
      sql: `CREATE VIRTUAL TABLE s USING fts5(body);
        INSERT INTO s(s, rank) VALUES ('secure-delete', 1);`,
      mode: 'script',
      readOnly: false,
    });
    const tag = (i: number) => `tag${String(i).padStart(6, '0')}`;
    const ids = Array.from({ length: 2000 }, (_x, i) => i);
    await runAppDataBatch(
      f,
      ids.map((i) => st('INSERT INTO s (rowid, body) VALUES (?, ?)', i + 1, tag(i))),
    );
    // Half the rows go, so the pages stay and their first words can be stale.
    const gone = ids.filter((i) => i % 2 === 1);
    await runAppDataBatch(
      f,
      gone.map((i) => st('DELETE FROM s WHERE rowid = ?', i + 1)),
    );
    const q = (sql: string) => runAppSql(f, { sql, mode: 'all', readOnly: true });
    const goneWords = new Set(gone.map(tag));
    const stale = async () =>
      ((await q('SELECT cast(substr(term, 2) AS text) AS t FROM s_idx')) as { t: string }[])
        .map((w) => w.t)
        .filter((t) => goneWords.has(t));
    expect(await q(`SELECT rowid FROM s WHERE s MATCH '${tag(7)}'`)).toEqual([]);
    const blocks = (await q('SELECT hex(block) AS h FROM s_data')) as { h: string }[];
    const raw = blocks.map((b) => Buffer.from(b.h, 'hex').toString('latin1')).join('');
    expect(gone.map(tag).filter((w) => raw.includes(w))).toEqual([]);
    expect((await stale()).length).toBeGreaterThan(0);
    await runAppSql(f, {
      sql: "INSERT INTO s(s) VALUES ('rebuild')",
      mode: 'run',
      readOnly: false,
      dataOnly: true,
    });
    expect(await stale()).toEqual([]);
  }, 60_000);

  it("the guide's search words: every input answers, and two words need not touch", async () => {
    const search = (term: string) => {
      const match = term
        .slice(0, 500)
        .replace(/\0/g, '')
        .trim()
        .split(/\s+/)
        .slice(0, 32)
        .map((word) => '"' + word.replace(/"/g, '""') + '"')
        .join(' ');
      return read('SELECT rowid AS id FROM docs WHERE docs MATCH ?', match);
    };
    await runAppDataBatch(file, [
      st("INSERT INTO docs (rowid, body) VALUES (40, 'the feed pump and the valve')"),
    ]);
    expect(await search('pump valve')).toEqual([{ id: 40 }]);
    expect(await search('  valve   pump ')).toEqual([{ id: 40 }]);
    const long = ['x'.repeat(100_000), 'word '.repeat(100_000)];
    for (const term of [
      '',
      ' ',
      '"',
      "o'brien",
      'NEAR',
      '*',
      '(',
      '^x',
      '---',
      'a\0b',
      '\0',
      ...long,
    ]) {
      await expect(search(term), JSON.stringify(term)).resolves.toBeInstanceOf(Array);
    }
    await runAppDataBatch(file, [st('DELETE FROM docs WHERE rowid = 40')]);
  });

  it('a guard reaches no other pragma, past the text check', async () => {
    await expect(
      runAppDataBatch(file, [st('SELECT 1')], { guard: st('SELECT * FROM pragma_database_list') }),
    ).rejects.toThrow(/^guard: not authorized/);
  });

  it('a killed batch leaves the index whole', async () => {
    // Distinct words past FTS5's 1 MiB buffer, row after row, so index pages
    // leave the page cache for the file before the kill.
    const big = (n: number) =>
      st(
        `INSERT INTO docs (rowid, body) SELECT ${n}, group_concat('killed' || (key + ${n * 100_000}), ' ') FROM json_each('[' || substr(replace(hex(zeroblob(60000)), '00', ',1'), 2) || ']')`,
      );
    let walBytes = 0;
    const watch = setInterval(() => {
      try {
        walBytes = Math.max(walBytes, statSync(`${file}-wal`).size);
      } catch {
        // no log yet
      }
    }, 5);
    const pending = runAppDataBatch(
      file,
      [
        st("INSERT INTO docs (rowid, body) VALUES (7, 'killed word')"),
        big(8),
        big(9),
        big(10),
        st(
          'SELECT count(*) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c)',
        ),
      ],
      { timeoutMs: 3000 },
    );
    await expect(pending)
      .rejects.toThrow(/ran longer/)
      .finally(() => clearInterval(watch));
    expect(walBytes).toBeGreaterThan(0);
    expect(await hits('killed')).toEqual([]);
    expect(await hits('killed800007')).toEqual([]);
    expect(await hits('batch')).toEqual([3]);
    await runAppSql(file, {
      sql: "INSERT INTO docs(docs) VALUES ('integrity-check')",
      mode: 'run',
      readOnly: false,
    });
  });

  it('opens one pragma only: data_version is a number, and the others stay shut', async () => {
    const [row] = await read('SELECT data_version FROM pragma_data_version');
    expect(typeof row!.data_version).toBe('number');
    for (const name of [
      'database_list',
      'journal_mode',
      'compile_options',
      'page_count',
      'integrity_check',
      'schema_version',
    ]) {
      await expect(read(`SELECT * FROM pragma_${name}`)).rejects.toThrow(/not authorized/);
    }
    await expect(
      runAppSql(file, { sql: 'PRAGMA user_version = 5', mode: 'run', readOnly: false }),
    ).rejects.toThrow(/not authorized/);
  });

  it('an adopted file keeps its index, and one with a trigger on the index is refused', async () => {
    const out = path.join(dir, 'adopted.sqlite');
    await adoptAppDbFile(file, out);
    const found = (await runAppSql(out, {
      sql: "SELECT rowid AS id FROM docs WHERE docs MATCH 'batch'",
      mode: 'all',
      readOnly: true,
    })) as { id: number }[];
    expect(found).toEqual([{ id: 3 }]);

    const crafted = path.join(dir, 'crafted.sqlite');
    const db = new DatabaseSync(crafted, { defensive: false });
    db.exec('CREATE VIRTUAL TABLE s USING fts5(body); CREATE TABLE keep (x);');
    db.exec('CREATE TRIGGER evil AFTER INSERT ON s_data BEGIN DELETE FROM keep; END;');
    db.close();
    await expect(adoptAppDbFile(crafted, path.join(dir, 'crafted-out.sqlite'))).rejects.toThrow(
      /malformed|may not be modified|not authorized|damaged/,
    );
    // The trigger before the index, which the engine does not catch, in any case.
    const names = ['s_data', 'S_DATA', 's_idx', 's_content', 's_docsize', 's_config'];
    for (const [i, on] of names.entries()) {
      const swapped = path.join(dir, `swapped-${i}.sqlite`);
      craftIndexTrigger(swapped, 'INSERT INTO keep VALUES (1)', on);
      await expect(
        adoptAppDbFile(swapped, path.join(dir, `swapped-${i}-out.sqlite`)),
      ).rejects.toThrow(/a trigger on a search index table/);
    }
  });

  it('a trigger on an index table meets the rules at COMMIT, in a batch and a script', async () => {
    const f = path.join(dir, 'at-commit.sqlite');
    craftIndexTrigger(f, 'INSERT INTO _timer_runs VALUES (1)');
    const forged = () => {
      const db = new DatabaseSync(f, { readOnly: true });
      const row = db.prepare('SELECT count(*) AS n FROM _timer_runs').get() as { n: number };
      db.close();
      return row.n;
    };
    await expect(runAppDataBatch(f, [st("INSERT INTO s (body) VALUES ('hello')")])).rejects.toThrow(
      /^at commit: /,
    );
    expect(forged()).toBe(0);
    await expect(
      runAppSql(f, {
        sql: "INSERT INTO s (body) VALUES ('hello');",
        mode: 'script',
        readOnly: false,
        userVersion: 2,
      }),
    ).rejects.toThrow(/not authorized|authorization denied/);
    expect(forged()).toBe(0);
  });

  it('a read-only open writes nothing: no command, no row, not one byte', async () => {
    const bytes = () => {
      const wal = `${file}-wal`;
      let log = '';
      try {
        log = readFileSync(wal).toString('hex');
      } catch {
        // no log
      }
      return readFileSync(file).toString('hex') + log;
    };
    const before = bytes();
    const writes = [
      "INSERT INTO docs(docs) VALUES ('rebuild')",
      "INSERT INTO docs(docs) VALUES ('optimize')",
      "INSERT INTO docs(docs, rank) VALUES ('merge', 16)",
      "INSERT INTO docs(docs, rank) VALUES ('pgsz', 512)",
      "INSERT INTO docs(docs, rank) VALUES ('automerge', 2)",
      "INSERT INTO docs(docs, rank) VALUES ('secure-delete', 0)",
      "INSERT INTO docs (rowid, body) VALUES (50, 'nope')",
      "UPDATE docs SET body = 'nope' WHERE rowid = 3",
      'DELETE FROM docs WHERE rowid = 3',
    ];
    for (const sql of writes) {
      for (const mode of ['run', 'all'] as const) {
        await expect(runAppSql(file, { sql, mode, readOnly: true }), sql).rejects.toThrow(
          /readonly|not authorized|authorization denied/,
        );
      }
    }
    expect(bytes() === before).toBe(true);
    expect(await hits('batch')).toEqual([3]);
  });

  it('a copy holds the index', async () => {
    const dest = path.join(dir, 'copy.sqlite');
    await copyAppDbFile(file, dest);
    const rows = (await runAppSql(dest, {
      sql: "SELECT rowid AS id FROM docs WHERE docs MATCH 'batch'",
      mode: 'all',
      readOnly: true,
    })) as { id: number }[];
    expect(rows.map((r) => r.id)).toEqual([3]);
  });
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
