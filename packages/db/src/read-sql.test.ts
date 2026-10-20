import { describe, expect, it } from 'vitest';
import { CHECK_FLOOR_SQL } from './check-floor';
import { ACTOR_CHECK_DRIFT_SQL, EDIT_CHECK_DRIFT_SQL } from './gateway/check-mode';
import { NotReadSqlError, notReadSqlReason, readSql, WRITE_FUNCTIONS } from './read-sql';
import { RUNTIME_LOCK_SQL } from './runtime-role';
import { sqlCode, sqlStatements, withParts } from './sql-text';
import { GRANT_DRIFT_SQL } from './workspaces-check';

describe('readSql', () => {
  it('answers the shared read text the integrity rows send, unchanged', () => {
    for (const text of [
      ACTOR_CHECK_DRIFT_SQL,
      EDIT_CHECK_DRIFT_SQL,
      CHECK_FLOOR_SQL,
      RUNTIME_LOCK_SQL,
      GRANT_DRIFT_SQL,
    ]) {
      expect(notReadSqlReason(text), text).toBeNull();
      expect(readSql(text)).toBe(text);
    }
  });

  it('answers reads: a trailing semicolon, quotes, comments, WITH, VALUES, TABLE', () => {
    for (const text of [
      'select 1;',
      "select 'a;b' as x -- ; delete from t\n",
      'select "a;b" from t /* ; update t set x = 1 */',
      'select $q$ ; a $q$',
      "select 'it''s; fine'",
      "select 'insert into t; delete from t; nextval(1)'",
      'select "nextval" from t',
      'with recursive w as (select 1) select * from w where x = any($1) limit $2',
      'with a as (select 1), b (x) as materialized (values (2)) select * from a, b',
      'with a as (with b as (select 1) select * from b) select * from a',
      '(select 1) union all (select 2)',
      'values (1), (2)',
      'table t',
      'select a$b$ from t',
      "select E'a\\'b' as x",
      "select currval('s'), lastval(), pg_has_role(1, 2, 'USAGE'), has_schema_privilege(1, 'public', 'CREATE')",
      'select "public"."mantle_check_box_mode"(\'edit_check\')',
      'select 1 /* a /* nested */ comment */',
    ]) {
      expect(notReadSqlReason(text), text).toBeNull();
      expect(readSql(text)).toBe(text);
    }
  });

  // Each shape that writes, locks, changes the session or hides a second
  // statement, as text: each must throw.
  const REFUSED: Array<[string, string]> = [
    ['a delete', 'delete from t'],
    ['an insert', 'insert into t values (1)'],
    ['an update', 'update t set x = 1'],
    ['an update only', 'update only nodes set title = 1'],
    ['a merge', 'merge into t using s on true when matched then do nothing'],
    ['a truncate', 'truncate t'],
    ['DDL', 'alter table t disable trigger x'],
    ['a data-modifying CTE', 'with x as (delete from t returning id) select * from x'],
    [
      'an update CTE, alias without AS',
      'with x as (update nodes n set title = n.title returning 1) select * from x',
    ],
    ['an update only CTE', 'with x as (update only nodes set title = 1 returning 1) select 1'],
    [
      'a merge CTE',
      'with m as (merge into t using s on true when matched then delete returning 1) select 1',
    ],
    ['a materialized delete CTE', 'with d as materialized (delete from t returning 1) select 1'],
    [
      'a `--` in a string before a write CTE',
      "with a as (select '--'), b as (delete from t returning 1) select 1",
    ],
    [
      'a `/*` in a string before a write CTE',
      "with a as (select '/*'), b as (delete from t returning 1) select 1",
    ],
    ['a nested write CTE', 'with a as (with b as (delete from t returning 1) select 1) select 1'],
    ['a WITH whose statement writes', 'with a as (select 1) insert into t select * from a'],
    ['SELECT INTO', 'select * into t2 from t'],
    ['SELECT INTO, quoted', 'select * into "t2" from t'],
    ['COPY FROM', "copy t from '/tmp/x'"],
    ['COPY TO', 'copy (select 1) to stdout'],
    ['GRANT', 'grant select on t to public'],
    ['REVOKE', 'revoke select on t from public'],
    ['SET ROLE', 'set role mantle_owner'],
    ['SET', "set mantle.actor = 'x'"],
    ['RESET', 'reset role'],
    ['set_config', "select set_config('mantle.actor', 'x', false)"],
    ['set_config, qualified and quoted', 'select "pg_catalog"."set_config"(\'role\', \'x\', true)'],
    ['an advisory lock', 'select pg_advisory_lock(1)'],
    ['a try advisory lock', 'select pg_try_advisory_lock(1)'],
    ['an advisory transaction lock', 'select pg_advisory_xact_lock(1)'],
    ['an advisory unlock', 'select pg_advisory_unlock_all()'],
    ['nextval', "select nextval('s')"],
    ['setval', "select setval('s', 1)"],
    ['pg_notify', "select pg_notify('c', 'x')"],
    ['a large object', "select lo_import('/etc/passwd')"],
    ['lo_unlink', 'select lo_unlink(1)'],
    ['dblink', "select * from dblink('x', 'delete from t') as r(a int)"],
    ['dblink_exec', "select dblink_exec('x', 'delete from t')"],
    ['query_to_xml', "select query_to_xml('select 1', true, true, '')"],
    ['pg_terminate_backend', 'select pg_terminate_backend(1)'],
    [
      'EXPLAIN ANALYZE MERGE',
      'explain analyze merge into t using s on true when matched then delete',
    ],
    ['EXPLAIN', 'explain select 1'],
    ['CALL', 'call p()'],
    ['DO', 'do $$ begin delete from t; end $$'],
    ['LOCK', 'lock table t'],
    ['NOTIFY', 'notify c'],
    ['FOR UPDATE', 'select * from t for update'],
    ['FOR NO KEY UPDATE', 'select * from t for no key update'],
    ['FOR SHARE', 'select * from t for share'],
    ['FOR KEY SHARE', 'select * from t for key share'],
    ['two statements', 'select 1; select 2'],
    ['a read then a truncate', 'select 1; truncate t'],
    ['a string then a delete', "select 'x'; delete from t"],
    ['a name with $ hiding a statement', 'select 1 as x$q$, 2; delete from t; select $q$$q$'],
    ['a nested comment hiding a statement', "select 1 /* /* */ ' */; delete from t; -- '"],
    ['an unterminated string', "select 'abc"],
    ['an unterminated comment', 'select 1 /* x'],
    ['an unterminated dollar quote', 'select $q$ x'],
    ['a backslash before a quote in a plain string', "select 'a\\'; delete from t; --'"],
    ['a U&"" name', 'select U&"\\006Eextval"(\'s\')'],
    ['no statement', '  -- nothing\n'],
    [
      'a SEARCH clause',
      'with recursive t(n) as (select 1) search depth first by n set o select * from t',
    ],
    // A `--` comment ends at a carriage return as at a newline (the lexer's
    // non_newline is [^\n\r]): Postgres runs the delete after it.
    ['a statement after a comment a \\r ends', 'select 1 --x\r; delete from t where a = 1'],
    ['a write after a comment a \\r ends', 'select 1 --x\rfrom t; update t set a = 1'],
    [
      'a write CTE after a comment a \\r ends',
      'select 1 --x\r, (with d as (delete from t) select 1)',
    ],
    ['a CTE head with no space before its parenthesis', 'with x as(select 1) delete from t'],
    [
      'a second CTE head with no space',
      'with a as (select 1), b as(select 2) insert into t select 1',
    ],
    [
      'a SEARCH clause before a delete',
      'with recursive t(n) as (select 1) search depth first by n set o delete from x',
    ],
    [
      'a CYCLE clause before an update',
      'with recursive t(n) as (select 1) cycle n set c using p update x set a = 1',
    ],
    ['ts_rewrite (runs its text argument)', "select ts_rewrite('a'::tsquery, 'select 1')"],
    ['pg_clear_relation_stats', "select pg_clear_relation_stats('public', 't')"],
    ['pg_restore_relation_stats', "select pg_restore_relation_stats('schemaname', 'public')"],
    ['pg_clear_attribute_stats', "select pg_clear_attribute_stats('public', 't', 'a', false)"],
    ['pg_restore_attribute_stats', "select pg_restore_attribute_stats('schemaname', 'public')"],
    ['brin_summarize_new_values', "select brin_summarize_new_values('i'::regclass)"],
    ['brin_summarize_range', "select brin_summarize_range('i'::regclass, 0)"],
    ['brin_desummarize_range', "select brin_desummarize_range('i'::regclass, 0)"],
    ['gin_clean_pending_list', "select gin_clean_pending_list('i'::regclass)"],
    ['pg_stat_statements_reset', 'select pg_stat_statements_reset()'],
    ['pg_stat_reset_shared', "select pg_stat_reset_shared('io')"],
    ['pg_log_standby_snapshot', 'select pg_log_standby_snapshot()'],
    ['pg_backup_start', "select pg_backup_start('x')"],
    ['pg_backup_stop', 'select pg_backup_stop()'],
    ['a schema-qualified ts_rewrite', "select pg_catalog.ts_rewrite('a'::tsquery, 'select 1')"],
  ];

  it.each(REFUSED)('refuses %s', (_name, text) => {
    expect(() => readSql(text), text).toThrow(NotReadSqlError);
  });

  it('names every write function as a call, never a value or another name', () => {
    for (const name of [
      'nextval',
      'setval',
      'pg_notify',
      'set_config',
      'pg_advisory_lock',
      'lo_import',
      'dblink_exec',
      'ts_rewrite',
      'pg_restore_relation_stats',
      'brin_summarize_range',
      'gin_clean_pending_list',
      'pg_stat_statements_reset',
      'pg_backup_start',
    ]) {
      expect(notReadSqlReason(`select ${name}(1)`), name).toBe('a call of a function that writes');
      expect(notReadSqlReason(`select '${name}(1)'`), name).toBeNull();
      expect(notReadSqlReason(`select x.${name}_count from x`), name).toBeNull();
    }
    expect(WRITE_FUNCTIONS.length).toBeGreaterThan(0);
  });
});

describe('the shared SQL reader (sql-text.ts)', () => {
  it('blanks comments and literal bodies to the same length', () => {
    const text = 'select \'a;b\', "x y", $t$ ; $t$ -- c ;\n/* d */ from t';
    const { code } = sqlCode(text);
    expect(code.length).toBe(text.length);
    expect(code).not.toMatch(/;/);
    expect(code).toContain('"x_y"');
  });

  it('cuts statements at the code', () => {
    expect(sqlStatements('select 1 ; ')).toEqual(['select 1 ', ' ']);
    expect(sqlStatements("select ';' -- ;\n; select 2")).toEqual([
      "select ';' -- ;\n",
      ' select 2',
    ]);
  });

  it('ends a -- comment at a newline or a carriage return', () => {
    for (const end of ['\n', '\r', '\r\n']) {
      const text = `select 1 -- c ;${end}; select 2`;
      const { code } = sqlCode(text);
      expect(code.length).toBe(text.length);
      expect(sqlStatements(text), JSON.stringify(end)).toHaveLength(2);
    }
    // Code after the carriage return is read as code: a read passes.
    expect(readSql('select a --x\rfrom t')).toBe('select a --x\rfrom t');
  });

  it('walks a CTE head with no space before its parenthesis', () => {
    expect(withParts('with x as(select 1), y as materialized(select 2) delete from t')).toEqual({
      ctes: ['select 1', 'select 2'],
      rest: 'delete from t',
      walked: true,
    });
  });

  it('does not walk a SEARCH or CYCLE clause', () => {
    for (const clause of ['search depth first by n set o', 'cycle n set c using p']) {
      const parts = withParts(`with recursive t(n) as (select 1) ${clause} delete from x`);
      expect(parts.walked, clause).toBe(false);
      expect(parts.rest).toContain('delete from x');
    }
  });

  it('walks a WITH', () => {
    expect(
      withParts('with a as (select 1), "b" (x) as not materialized (values (2)) select 3'),
    ).toEqual({
      ctes: ['select 1', 'values (2)'],
      rest: 'select 3',
      walked: true,
    });
  });
});
