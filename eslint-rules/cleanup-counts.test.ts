/**
 * The cleanup counts (cleanup-counts.mjs): raw write SQL and history codes
 * in comments, on small inputs. The repo numbers are pinned by
 * `pnpm arch:check`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HEADING_CODES_LEFT_OUT,
  HISTORY_CODE_STOPLIST,
  HISTORY_HEADING_CODES,
  cleanupCounts,
  headingCodeProblems,
  historyCommentLines,
  historyHeadingCodes,
  rawWriteKind,
  rawWriteSqlSites,
  rawWriteSwept,
  sqlStatements,
  // @ts-expect-error: plain-JS module, no types shipped.
  rawWriteTargetRegexSites,
  readsWriteTarget,
} from './cleanup-counts.mjs';
import { notReadSqlReason } from '../packages/db/src/read-sql';

const ROOT = join(__dirname, '..');

describe('rawWriteKind', () => {
  it('finds a write, after comments and a leading WITH', () => {
    expect(rawWriteKind('insert into t values (1)')).toBe('write');
    expect(rawWriteKind('  -- note\n UPDATE t set a = 1')).toBe('write');
    expect(rawWriteKind('/* x */ delete from t')).toBe('write');
    expect(rawWriteKind('merge into t using s on true when matched then do nothing')).toBe('write');
    expect(rawWriteKind('truncate t')).toBe('write');
    expect(
      rawWriteKind('with a as (select 1), b (x) as (select 2) insert into t select * from a'),
    ).toBe('write');
    expect(rawWriteKind('with recursive a as (select 1) update t set x = 1')).toBe('write');
  });

  it('finds a data-modifying CTE under a read', () => {
    expect(rawWriteKind('with d as (delete from t returning id) select count(*) from d')).toBe(
      'write-cte',
    );
    expect(rawWriteKind('with d as materialized (update t set a = 1 returning 1) select 1')).toBe(
      'write-cte',
    );
  });

  it('leaves out reads, FOR UPDATE, and definer calls', () => {
    expect(rawWriteKind('select * from t for update')).toBeNull();
    expect(rawWriteKind('select "public"."mantle_ws_add_user"($1, $2)')).toBeNull();
    expect(rawWriteKind('with a as (select 1) select * from a')).toBeNull();
    expect(rawWriteKind(', updated_at = now()')).toBeNull();
  });
});

describe('rawWriteKind and readSql share one reader', () => {
  // The lint reads literal text, readSql composed text, both with
  // packages/db/src/sql-text.ts: a text the lint calls a write, readSql
  // refuses (readSql refuses more: locks, session calls, INTO).
  const WRITES = [
    "with a as (select '--'), b as (delete from t returning 1) select 1",
    "with a as (select '/*'), b as (delete from t returning 1) select 1",
    'with x as (update nodes n set title = n.title returning 1) select * from x',
    'with x as (update only nodes set title = 1 returning 1) select 1',
    'update only nodes set title = 1',
    'with m as (merge into t using s on true when matched then delete returning 1) select 1',
    "select 1 /* /* */ ' */; delete from t; -- '",
    "select 'a;b'; delete from t",
    'select 1 as x$q$, 2; delete from t; select $q$$q$',
    // A `--` comment ends at a carriage return too (Postgres runs these).
    'select 1 --x\r; delete from t where a = 1',
    'select 1 --x\r; with d as (delete from t returning 1) select 1',
    // CTE heads with no space before the parenthesis, a SEARCH or CYCLE
    // clause: each writes on pg18.
    'with x as(select 1) delete from t',
    'with a as (select 1), b as(select 2) insert into t select 1',
    'with x as materialized(select 1) update t set a = 1',
    'with recursive t(n) as (select 1) search depth first by n set o delete from x',
    'with recursive t(n) as (select 1) cycle n set c using p update x set a = 1',
    'with recursive t(n) as (select 1) search breadth first by n set o insert into x select 1',
  ];

  it('finds each write the reader shows', () => {
    for (const text of WRITES) {
      expect(rawWriteKind(text), text).not.toBeNull();
      expect(notReadSqlReason(text), text).not.toBeNull();
    }
  });

  it('reads a value as a value', () => {
    for (const text of [
      "select 'delete from t' as a",
      'select 1 -- ; delete from t\n',
      'select $q$ ; update t set a = 1 $q$',
      'select "update" from t',
      'select 1 -- ; delete from t\r\n',
    ]) {
      expect(rawWriteKind(text), text).toBeNull();
      expect(notReadSqlReason(text), text).toBeNull();
    }
  });

  it('counts the write an EXPLAIN ANALYZE or a PREPARE runs, not a plain EXPLAIN', () => {
    for (const text of [
      'explain analyze delete from t',
      'explain analyse verbose update t set a = 1',
      'explain (analyze, buffers) insert into t values (1)',
      'explain(analyze) delete from t',
      'EXPLAIN(ANALYZE, BUFFERS) update t set a = 1',
      'explain (format json, analyze true) merge into t using s on true when matched then delete',
      'explain analyze with d as (delete from t returning 1) select * from d',
      'prepare p as delete from t where a = $1',
      'prepare "p" (int, text) as insert into t values ($1, $2)',
      'prepare p as with x as (select 1) update t set a = 1',
      'select 1; explain analyze truncate t',
    ]) {
      expect(rawWriteKind(text), text).not.toBeNull();
      expect(notReadSqlReason(text), text).not.toBeNull();
    }
    for (const text of [
      'explain delete from t',
      'explain verbose update t set a = 1',
      'explain (analyze false) delete from t',
      'explain (costs off) insert into t values (1)',
      'explain(costs off) delete from t',
      'explainanalyze delete from t',
      'explain analyze select * from t',
      'prepare p as select 1',
      "prepare p as select 'delete from t'",
    ]) {
      expect(rawWriteKind(text), text).toBeNull();
    }
  });

  it('counts a write in a WITH it cannot walk, not a read or a row lock there', () => {
    expect(rawWriteKind('with x as(select 1) delete from t')).toBe('write');
    expect(
      rawWriteKind('with recursive t(n) as (select 1) search depth first by n set o delete from x'),
    ).toBe('write');
    expect(
      rawWriteKind('with recursive t(n) as (select 1) search depth first by n set o select 1'),
    ).toBeNull();
    expect(
      rawWriteKind(
        'with recursive t(n) as (select 1) cycle n set c using p select * from x for update',
      ),
    ).toBeNull();
  });
});

describe('rawWriteSqlSites', () => {
  it('counts SQL tags, a renamed import of sql, .unsafe, sql.raw and .execute text', () => {
    const t = [
      "import { sql as dsql } from 'drizzle-orm';",
      'await db.execute(sql`insert into t values (${a})`);',
      'await tx.execute(dsql`update t set a = ${b}`);',
      'await q.execute(sqlTag`select 1`);',
      "await pg.unsafe('delete from t where id = $1', [id]);",
      'await pg.unsafe(text, params);',
      'await pg.unsafe(readSql(text));',
      'const s = sql.raw(stmt);',
      "await client.execute('truncate t');",
      'await q.execute(query);',
      'await db.insert(nodes).values({ id });',
      'const doc = `insert the coin`;',
      '// sql`insert into t`',
    ].join('\n');
    // readSql counts as any call unless imported from @mantle/db, and
    // execute of a name that holds no built SQL may run a string.
    expect(rawWriteSqlSites('x.ts', t)).toEqual([
      { line: 2, why: 'write' },
      { line: 3, why: 'write' },
      { line: 5, why: 'write' },
      { line: 6, why: 'non-literal' },
      { line: 7, why: 'non-literal' },
      { line: 8, why: 'non-literal' },
      { line: 9, why: 'write' },
      { line: 10, why: 'non-literal' },
    ]);
  });

  it('reads each statement of a text on its own, outside quotes and dollar quotes', () => {
    expect(sqlStatements("select ';' as a; delete from t")).toEqual([
      "select ';' as a",
      ' delete from t',
    ]);
    expect(sqlStatements('select $q$ ; $q$; update t set a = 1')).toEqual([
      'select $q$ ; $q$',
      ' update t set a = 1',
    ]);
    expect(rawWriteKind('select 1; delete from t')).toBe('write');
    expect(rawWriteKind(';delete from t')).toBe('write');
    expect(rawWriteKind('select 1; with d as (select 1) insert into t select * from d')).toBe(
      'write',
    );
    expect(rawWriteKind(`select 'a; delete from t'`)).toBeNull();
    expect(rawWriteKind('select "a;delete from t" from x')).toBeNull();
    expect(rawWriteKind('select $$; delete from t$$')).toBeNull();
    const t = [
      "await pg.unsafe('select 1; delete from t');",
      'await db.execute(sql`;delete from t`);',
      'await db.execute(sql`select ${a}; update t set a = ${b}`);',
      "await pg.unsafe(`select ';'`);",
    ].join('\n');
    expect(rawWriteSqlSites('x.ts', t)).toEqual([
      { line: 1, why: 'write' },
      { line: 2, why: 'write' },
      { line: 3, why: 'write' },
    ]);
  });

  it('reads execute of anything but built SQL as text', () => {
    const t = [
      'const q = sql`select 1`;',
      'await db.execute(q);',
      'async function f(a: SQL, b: string, c: ReturnType<typeof sql>) {',
      '  await db.execute(a);',
      '  await db.execute(b);',
      '  await db.execute(c);',
      '}',
      'const mk = (id: string) => sql`select ${id}`;',
      'await db.execute(mk(x));',
      'function g() { if (x) return sql`select 1`; return text; }',
      'await db.execute(g());',
      'await db.execute(x ? sql`select 1` : text);',
      'await db.execute(sql.join([a, b]));',
      'type D = { query: (o: string) => SQL };',
      'await db.execute(d.query(o));',
      'await db.execute(other.query(o));',
    ].join('\n');
    expect(rawWriteSqlSites('x.ts', t)).toEqual([
      { line: 5, why: 'non-literal' },
      { line: 11, why: 'non-literal' },
      { line: 12, why: 'non-literal' },
    ]);
  });

  it('takes readSql only from @mantle/db, and still reads a literal in it', () => {
    const ok = "import { readSql as r } from '@mantle/db';\nawait pg.unsafe(r(text));";
    expect(rawWriteSqlSites('x.ts', ok)).toEqual([]);
    const local = "import { readSql } from './read-sql';\nawait pg.unsafe(readSql(text));";
    expect(rawWriteSqlSites('x.ts', local)).toEqual([{ line: 2, why: 'non-literal' }]);
    const lit = "import { readSql } from '@mantle/db';\nawait pg.unsafe(readSql('delete from t'));";
    expect(rawWriteSqlSites('x.ts', lit)).toEqual([{ line: 2, why: 'write' }]);
    const read = "import { readSql } from '@mantle/db';\nawait db.execute(readSql('select 1'));";
    expect(rawWriteSqlSites('x.ts', read)).toEqual([]);
  });

  it('reads a tag under any name: an alias, a transaction handle, a parameter', () => {
    const t = [
      'const q = sql;',
      'await q`insert into t values (1)`;',
      'await sql.begin(async (tx) => {',
      '  await tx`delete from t where id = ${id}`;',
      '});',
      'function run(db) { return db`update t set a = 1`; }',
      'let r; r = sql;',
      'await r.raw(stmt);',
      'await pg.reserve().then((c) => c`select 1`);',
    ].join('\n');
    expect(rawWriteSqlSites('x.ts', t)).toEqual([
      { line: 2, why: 'write' },
      { line: 4, why: 'write' },
      { line: 6, why: 'write' },
      { line: 8, why: 'non-literal' },
    ]);
  });

  it('reads a text method under a literal key or another name', () => {
    const t = [
      "await sql['raw'](stmt);",
      "await pg['unsafe'](text);",
      "await pg['unsafe']('delete from t');",
      'const raw = sql.raw;',
      'await raw(stmt);',
      'const { raw: r2 } = sql;',
      'r2(stmt);',
      'const { unsafe } = pg;',
      "await unsafe('update t set a = 1');",
      'const u = pg.unsafe.bind(pg);',
      'await u(text);',
      'let v; v = pg["unsafe"];',
      'await v(text);',
      "await other['raw'](stmt);",
      'const w = other.raw;',
      'await w(stmt);',
    ].join('\n');
    expect(rawWriteSqlSites('x.ts', t)).toEqual([
      { line: 1, why: 'non-literal' },
      { line: 2, why: 'non-literal' },
      { line: 3, why: 'write' },
      { line: 5, why: 'non-literal' },
      { line: 7, why: 'non-literal' },
      { line: 9, why: 'write' },
      { line: 11, why: 'non-literal' },
      { line: 13, why: 'non-literal' },
    ]);
  });

  it('a template is a literal only when its static text starts a statement', () => {
    const t = [
      "await tx.unsafe(`${'insert'} into t values (1)`);",
      'await tx.unsafe(`${stmt}; select 1`);',
      'await tx.unsafe(`${a} where id = ${b}`);',
      'await tx.unsafe(`/* tag */ ${stmt}`);',
      'await tx.unsafe(`(select 1) union ${rest}`);',
      'await tx.unsafe(`  ${TAG}  update t set a = 1`);',
    ].join('\n');
    expect(rawWriteSqlSites('x.ts', t)).toEqual([
      { line: 1, why: 'non-literal' },
      { line: 2, why: 'non-literal' },
      { line: 3, why: 'non-literal' },
      { line: 4, why: 'non-literal' },
      { line: 6, why: 'write' },
    ]);
  });

  it('a template with no SQL word in its static text is no literal', () => {
    const t = [
      'await tx.unsafe(`${stmt}`);',
      'await tx.unsafe(`${TAG} ${STMT}`);',
      'await tx.unsafe(`${stmt};`);',
      'const c = sql.raw(`${alias}.${name}`);',
      "const k = sql.raw(`array[${keys.map((x) => `'${x}'`).join(', ')}]::text[]`);",
      'await tx.unsafe(`delete from t where id = ${id}`);',
      'await tx.unsafe(`select * from ${table}`);',
      'await tx.unsafe(`${TAG} insert into t values (1)`);',
    ].join('\n');
    expect(rawWriteSqlSites('x.ts', t)).toEqual([
      { line: 1, why: 'non-literal' },
      { line: 2, why: 'non-literal' },
      { line: 3, why: 'non-literal' },
      { line: 4, why: 'non-literal' },
      { line: 5, why: 'non-literal' },
      { line: 6, why: 'write' },
      { line: 8, why: 'write' },
    ]);
  });

  it('reads .raw on a member whose last name is a tag, and an alias of an alias', () => {
    const t = [
      'await this.sql.raw(stmt);',
      'await deps.sql.raw(stmt);',
      "await d.sqlTag['raw'](stmt);",
      'await deps.db.raw(stmt);',
      'const r = sql.raw;',
      'const r2 = r;',
      'await r2(stmt);',
      'let r3; r3 = r2;',
      'await r3(stmt);',
      'const u = pg.unsafe;',
      'const u2 = (u);',
      "await u2('update t set a = 1');",
    ].join('\n');
    expect(rawWriteSqlSites('x.ts', t)).toEqual([
      { line: 1, why: 'non-literal' },
      { line: 2, why: 'non-literal' },
      { line: 3, why: 'non-literal' },
      { line: 7, why: 'non-literal' },
      { line: 9, why: 'non-literal' },
      { line: 12, why: 'write' },
    ]);
  });

  it('pins literal writes and non-literal text apart', () => {
    const n = cleanupCounts(ROOT, [
      {
        path: 'packages/x/src/a.ts',
        text: 'await sql`insert into t values (1)`;\nawait pg.unsafe(text);\nawait pg.unsafe(more);',
      },
    ]).numbers as Record<string, number>;
    expect([n.rawWriteSqlScoped, n.rawSqlNonLiteral, n.rawWriteSqlFiles]).toEqual([1, 2, 1]);
  });

  it('sweeps packages/*/src and server/ only', () => {
    expect(rawWriteSwept('packages/db/src/client.ts')).toBe(true);
    expect(rawWriteSwept('server/web/lib/x.ts')).toBe(true);
    expect(rawWriteSwept('packages/db/scripts/x.ts')).toBe(false);
    expect(rawWriteSwept('scripts/x.ts')).toBe(false);
  });
});

describe('history codes in comments', () => {
  const codes = new Set(['A10', 'F4', 'A6b']);
  const lines = (t: string, path = 'x.ts') => historyCommentLines(path, t, codes);

  it('counts fix rounds, round codes and audit finding codes in comments only', () => {
    const t = [
      '// set in F4 fix round 2',
      '/* the W7a round A note */',
      '// audit M3 found it',
      "const s = 'fix round 1';",
      '// a fixed rounding mode',
    ].join('\n');
    expect(lines(t)).toEqual([1, 2, 3]);
  });

  it('counts a step code next to a provenance word, or one the history headings name', () => {
    const t = [
      '// W7c part 2 moved it',
      '// (workspaces arch A9)',
      '// A10 #13: one list',
      '// the W9 batch',
      '// see F4.',
      '// set A1 to the total',
    ].join('\n');
    expect(lines(t)).toEqual([1, 2, 3, 5]);
  });

  it('leaves a cell reference alone in a sheet or formula comment', () => {
    const t = ['// the formula reads A10 first', '// cell F4 holds the sum'].join('\n');
    expect(lines(t)).toEqual([]);
    expect(lines('// F4 in the header row', 'packages/tabledb/src/x.ts')).toEqual([]);
    // Next to a provenance word too, when the line says sheet, formula or
    // cell (a cell's step, `fix A1`, is no history code).
    expect(lines('// the formula changed in A10 part 2')).toEqual([]);
    expect(lines('// fix A1 in the sheet first')).toEqual([]);
    // A sheet file's step code on a line with no sheet word is the step.
    expect(lines('// the one error answer (A10 part 2)', 'packages/tabledb/src/x.ts')).toEqual([1]);
    // A row, a column or a range is a database's too: no cell.
    expect(lines('// the login row (A10 #8)')).toEqual([1]);
    // A code that is no cell shape stays one in a sheet comment.
    expect(lines('// the sheet export (A6b)')).toEqual([1]);
  });

  it('counts a bare round only in a finding shape', () => {
    const t = [
      '// round 2 decimals',
      '// (round 3, H1)',
      '// round 1 M1 found it',
      '// as "F9 round 3" says, the contract',
      '// moved here (round 2).',
      '// the lock round 1 waits, rounds 2 to 5 do not',
    ].join('\n');
    expect(lines(t)).toEqual([2, 3, 4, 5]);
  });

  it('reads codes of any letter and their sub-steps', () => {
    const wide = new Set(['R0', 'D1', 'A2b1', 'A2b2b', 'S3', 'P1a']);
    const w = (t: string, path = 'x.ts') => historyCommentLines(path, t, wide);
    const t = [
      '// the edit (R0), then the manage (S3)',
      '// D1 moved the text',
      '// the gateway (A2b2b)',
      '// in A2b1: one statement',
      '// since P1a',
      '// R2 is not a heading code',
      '// fix A2b2 first',
    ].join('\n');
    expect(w(t)).toEqual([1, 2, 3, 4, 5, 7]);
  });

  it('the stoplist: S3 the store, A4 the paper, the A8 suite names', () => {
    const wide = new Set(['S3', 'A4', 'A8', 'S1']);
    const w = (t: string, path = 'x.ts') => historyCommentLines(path, t, wide);
    expect(
      w(
        [
          '// The object store answered (any S3 backend).',
          '// plain S3 calls, so any S3-compatible server works',
          '// the S3 client',
          '// an A4 paper page',
          '// the suite, "A8 matrix", names each finding',
          '// the A8 grid does not run them',
          '// the export link (plan v3 S3)',
          '// its row rule (A8 matrix F9)',
          '// the A4 hand batch',
        ].join('\n'),
      ),
    ).toEqual([7, 8, 9]);
    expect(w('// the bucket for S3', 'x.ts')).toEqual([]);
    expect(w('// S3 is the default', 'packages/storage/src/index.ts')).toEqual([]);
    // None of these counts: the store's API, SDK and URLs, the paper's
    // orientation, a Sentry severity.
    expect(
      w(
        [
          '// RustFS on 9000 (S3 API)',
          '// the AWS S3 SDK pointed at the store',
          '// an S3 SDK client',
          '// an S3 URL, or S3 presigned links',
          '// A4 landscape, 10mm margins',
          '// an A4 portrait print',
          '// a Sentry S1 alert',
          '// raised at S1 severity',
        ].join('\n'),
      ),
    ).toEqual([]);
    // Next to them the plan steps still count.
    expect(w('// the S1 step\n// in S3 the export moved')).toEqual([1, 2]);
    expect((HISTORY_CODE_STOPLIST as { code: string }[]).map((s) => s.code)).toEqual([
      'S3',
      'A4',
      'S1',
      'A8',
      'Dn',
    ]);
  });

  it('an owner decision label is no step code, where it stands', () => {
    const wide = new Set(['D1', 'D4', 'D5', 'D6', 'A1']);
    const w = (t: string) => historyCommentLines('x.ts', t, wide);
    expect(
      w(
        [
          '// joined with the registry (owner decision D1): before',
          "// the owner's decisions D4 to D6) says",
          '// owner decisions D4, D5 and D6',
          '// owner decision D1 and the A1 step',
          '// step D1 then owner decision D1',
        ].join('\n'),
      ),
    ).toEqual([4, 5]);
    // The repo's list leaves D1 out, so an owner decision there counts
    // nothing by either path.
    const n = cleanupCounts(ROOT, [
      { path: 'packages/x/src/a.ts', text: '/** owner decision D1 */\n// (D1)\nconst x = 1;' },
    ]).numbers as Record<string, number>;
    expect(n.historyCodeComments).toBe(0);
  });

  it('counts an audit code of any letter, and a W or plan v3.2 step code by name', () => {
    const repo = new Set(HISTORY_HEADING_CODES as string[]);
    const r = (t: string) => historyCommentLines('x.ts', t, repo);
    expect(
      r(
        [
          '// capped (apps audit S2)',
          '// the one answer (audit B23)',
          '// the chat is paired to its user (W8a)',
          '// the role follows membership, S8b',
          '// the S3 client',
          '// an audit trail',
        ].join('\n'),
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  it('counts a finding split over two lines on its first line', () => {
    const repo = new Set(HISTORY_HEADING_CODES as string[]);
    const r = (t: string) => historyCommentLines('x.ts', t, repo);
    // Two `//` lines are one comment's text.
    expect(r(['// capped by the apps audit', '// H1: one cap', 'const x = 1;'].join('\n'))).toEqual(
      [1],
    );
    expect(r(['// capped by the apps audit', '// a cap of 1 MB'].join('\n'))).toEqual([]);
    expect(r(['// moved in the', '// fix round of the cap'].join('\n'))).toEqual([2]);
    expect(r(['// set in the', '// round 3, the cap'].join('\n'))).toEqual([2]);
    expect(r(['const a = 1; // the apps audit', 'const b = 2; // H1 cap'].join('\n'))).toEqual([]);
    expect(r(['/**', ' * capped by the apps audit', ' * H1 cap', ' */'].join('\n'))).toEqual([2]);
    expect(r(['// the fix', '// round 2 moved it'].join('\n'))).toEqual([1]);
    // A stoplisted S3 split from its store word stays the store.
    expect(r(['// plain', '// S3 calls'].join('\n'))).toEqual([]);
    expect(r(['/**', ' * any self-hosted', ' * S3 backend', ' */'].join('\n'))).toEqual([]);
  });

  it('counts each line of a block comment', () => {
    const t = '/**\n * F4 fix round 3:\n * the A6b exits\n * nothing here\n */\nconst x = 1;';
    expect(lines(t)).toEqual([2, 3]);
  });

  it("reads the codes of the history file's headings and the plan v3 handovers'", () => {
    const got = historyHeadingCodes(ROOT) as Map<string, string>;
    for (const c of ['F4', 'A10', 'R0', 'D1', 'A2b1', 'A2b2b', 'S3', 'P1a']) {
      expect(got.has(c), c).toBe(true);
    }
  });

  it('counts by the frozen list: every heading code is in it or left out, none both', () => {
    expect(headingCodeProblems(ROOT)).toEqual([]);
    const left = Object.keys(HEADING_CODES_LEFT_OUT as Record<string, string>);
    expect((HISTORY_HEADING_CODES as string[]).filter((c) => left.includes(c))).toEqual([]);
  });

  it('reads no heading inside a fenced code block', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanup-counts-'));
    try {
      mkdirSync(join(root, 'docs/_archive'), { recursive: true });
      writeFileSync(
        join(root, 'docs/_archive/actors-history.md'),
        [
          '# History',
          '```sh',
          '# Z8 a shell comment',
          '```',
          '~~~~',
          '# Z7 still code',
          '```',
          '# Z6 still code, a shorter or other fence closes nothing',
          '~~~~',
          '## Z5 a heading',
        ].join('\n'),
      );
      expect([...(historyHeadingCodes(root) as Map<string, string>).keys()]).toEqual(['Z5']);
      expect(headingCodeProblems(root)).toHaveLength(1);
      writeFileSync(
        join(root, 'docs/_archive/plan-v3-x-handover.md'),
        '# X\n```\n## Z4 never read\n',
      );
      expect(headingCodeProblems(root)).toContain(
        'docs/_archive/plan-v3-x-handover.md ends inside a fenced code block, so no heading after its last fence is read: close the fence',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a heading code in neither list is a problem, and the count does not read it', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanup-counts-'));
    try {
      mkdirSync(join(root, 'docs/_archive'), { recursive: true });
      writeFileSync(
        join(root, 'docs/_archive/actors-history.md'),
        '# History\n\n## Z9 a new step\n',
      );
      expect(headingCodeProblems(root)).toEqual([
        'heading code Z9 (docs/_archive/actors-history.md) is in neither HISTORY_HEADING_CODES nor HEADING_CODES_LEFT_OUT (eslint-rules/cleanup-counts.mjs); add it to one, with why if left out',
      ]);
      const r = cleanupCounts(root, [{ path: 'packages/x/src/a.ts', text: '// the Z9 rule' }]);
      expect((r.numbers as Record<string, number>).historyCodeComments).toBe(0);
      expect((r.detail as { problems: string[] }).problems).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("rawWriteTargetRegexSites: a write statement's table read from its text", () => {
  const of = (text: string) => rawWriteTargetRegexSites('packages/db/src/x.ts', text);

  it('finds the regex the gateway routed by, and its other spellings', () => {
    // The removed rawWriteTarget's regex, as main had it.
    expect(
      of(
        'const m = /^(?:insert\\s+into|update(?:\\s+only)?|delete\\s+from(?:\\s+only)?)\\s+(?:"?([a-z_][a-z0-9_]*)"?\\s*\\.\\s*)?"?([a-z_][a-z0-9_]*)"?(?=[\\s(;]|$)/i.exec(b);',
      ),
    ).toEqual([1]);
    expect(of('const r = /insert\\s+into\\s+(\\w+)/;')).toEqual([1]);
    expect(of("const r = new RegExp('delete\\\\s+from\\\\s+([^\\\\s]+)');")).toEqual([1]);
    expect(of('const r = RegExp(String.raw`update\\s+([A-Za-z_.]+)\\s+set`, "i");')).toEqual([1]);
  });

  it('finds a capture that starts with \\S, a quote, any character or a name; a grouped verb; MERGE INTO; spaces', () => {
    expect(of('const r = /insert\\s+into\\s+(\\S+)/i;')).toEqual([1]);
    expect(of('const r = /update\\s+([\\S]+)\\s+set/i;')).toEqual([1]);
    expect(of('const r = /(insert)\\s+into\\s+(\\w+)/i;')).toEqual([1]);
    expect(of('const r = /(?:delete)\\s+(from)\\s+([a-z_]+)/i;')).toEqual([1]);
    expect(of('const r = /merge\\s+into\\s+(\\w+)/i;')).toEqual([1]);
    expect(of("const r = new RegExp('(merge)\\\\s+into\\\\s+(\\\\S+)', 'i');")).toEqual([1]);
    expect(of('const r = /insert into ("?\\w+"?)/i;')).toEqual([1]);
    expect(of('const r = /delete\\s+from\\s+(?<table>\\w+)/i;')).toEqual([1]);
    expect(of('const r = /update\\s+(.+?)\\s+set/i;')).toEqual([1]);
    expect(readsWriteTarget('(insert)\\s+into\\s+(\\S+)')).toBe(true);
    expect(readsWriteTarget('MERGE INTO (\\w+)')).toBe(true);
  });

  it('a write verb with no name captured, a name with no write verb, a comment: none', () => {
    // The gateway's write test (handles.ts isWriteSql) and the WITH test.
    expect(
      of(
        'const r = /\\b(insert\\s+into|delete\\s+from|update\\s+[\\w".]+\\s+(as\\s+\\w+\\s+)?set|for\\s+(no\\s+key\\s+)?update)\\b/i;',
      ),
    ).toEqual([]);
    expect(of('const W = /\\b(insert|update|delete|merge)\\b/i;')).toEqual([]);
    expect(of('const r = /^select\\s+([a-z_]+)/;')).toEqual([]);
    expect(of('// /insert\\s+into\\s+(\\w+)/ in a comment\nconst a = 1;')).toEqual([]);
    expect(readsWriteTarget('insert\\s+into\\s+(?:\\w+)')).toBe(false);
    // Lookarounds and a non-capturing group capture nothing.
    expect(readsWriteTarget('merge\\s+into\\s+(?=\\w)(?<!x)(?:\\S+)')).toBe(false);
    expect(of('const r = /^merge\\b/i; const s = /(\\w+)/;')).toEqual([]);
  });
});
