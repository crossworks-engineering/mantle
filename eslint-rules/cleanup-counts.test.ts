/**
 * The cleanup counts (cleanup-counts.mjs): raw write SQL and history codes
 * in comments, on small inputs. The repo numbers are pinned by
 * `pnpm arch:check`.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  historyCommentLines,
  historyHeadingCodes,
  rawWriteKind,
  rawWriteSqlSites,
  rawWriteSwept,
  // @ts-expect-error: plain-JS module, no types shipped.
} from './cleanup-counts.mjs';

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
    expect(rawWriteSqlSites('x.ts', t)).toEqual([
      { line: 2, why: 'write' },
      { line: 3, why: 'write' },
      { line: 5, why: 'write' },
      { line: 6, why: 'non-literal' },
      { line: 8, why: 'non-literal' },
      { line: 9, why: 'write' },
    ]);
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
    // A provenance word still makes it one.
    expect(lines('// the formula changed in A10 part 2')).toEqual([1]);
  });

  it('counts each line of a block comment', () => {
    const t = '/**\n * F4 fix round 3:\n * the A6b exits\n * nothing here\n */\nconst x = 1;';
    expect(lines(t)).toEqual([2, 3]);
  });

  it("reads the codes of the history file's headings", () => {
    const got = historyHeadingCodes(ROOT) as Set<string>;
    expect(got.has('F4')).toBe(true);
    expect(got.has('A10')).toBe(true);
  });
});
