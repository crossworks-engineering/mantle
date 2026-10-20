import { describe, expect, it } from 'vitest';
import { CHECK_FLOOR_SQL } from './check-floor';
import { ACTOR_CHECK_DRIFT_SQL, EDIT_CHECK_DRIFT_SQL } from './gateway/check-mode';
import { holdsMoreStatements, NotReadSqlError, readSql } from './read-sql';
import { RUNTIME_LOCK_SQL } from './runtime-role';
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
      expect(readSql(text)).toBe(text);
    }
  });

  it('answers a read with a trailing semicolon, quotes and comments', () => {
    for (const text of [
      'select 1;',
      "select 'a;b' as x -- ; delete from t\n",
      'select "a;b" from t /* ; update t set x = 1 */',
      'select $q$ ; a $q$',
      "select 'it''s; fine'",
      'with recursive w as (select 1) select * from w where x = any($1) limit $2',
    ]) {
      expect(readSql(text)).toBe(text);
    }
  });

  it('refuses a write, DDL, a row lock and more than one statement', () => {
    for (const text of [
      'delete from t',
      'insert into t values (1)',
      'with x as (delete from t returning id) select * from x',
      'update t set x = 1',
      'truncate t',
      'alter table t disable trigger x',
      'select * from t for update',
      'select 1; select 2',
      'select 1; truncate t',
      "select 'x'; delete from t",
    ]) {
      expect(() => readSql(text), text).toThrow(NotReadSqlError);
    }
  });

  it('reads statements outside quotes, comments and dollar quotes', () => {
    expect(holdsMoreStatements('select 1 ; ')).toBe(false);
    expect(holdsMoreStatements('select 1; -- done\n')).toBe(false);
    expect(holdsMoreStatements('select 1; /* c */ select 2')).toBe(true);
    expect(holdsMoreStatements('select $$;$$')).toBe(false);
  });
});
