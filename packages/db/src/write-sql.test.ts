/**
 * isWriteSql (workspaces W6a): which raw statements write (writes, row
 * locks). Since fix round 1 (M3) it no longer routes a request scope's raw
 * statements (they all run in the scope); executeWrite refuses a statement
 * it does not take for a write.
 */
import { describe, expect, it } from 'vitest';
import { isWriteSql } from './client';

describe('isWriteSql', () => {
  it.each([
    'insert into nodes (id) values ($1)',
    '  UPDATE "pages" set doc = $1 where node_id = $2',
    'delete from item_marks where node_id = $1',
    '/* a note */ update nodes set title = $1',
    'with x as (update nodes set title = $1 returning id) select id from x',
    'with d as (delete from shares where id = $1 returning id) select count(*) from d',
    'select id from nodes where id = $1 for update',
    'select id from nodes where id = $1 for no key update',
    'select id from nodes for share',
    "select pg_notify('x', 'y')",
    'select pg_advisory_xact_lock(1)',
    "select nextval('s')",
    'truncate t',
  ])('a write: %s', (q) => expect(isWriteSql(q)).toBe(true));

  it.each([
    'select id, updated_at from nodes where id = $1',
    "select count(*) from nodes where data->>'deleted' is null",
    'with r as (select id from nodes) select * from r',
    '-- update nodes set x\nselect 1',
    'select "update_count" from stats',
    // Read as Postgres's lexer reads it (sql-text.ts): a nested comment
    // hides its whole text, a write verb in a value is no write, and text
    // that never closes runs nothing.
    '/* a /* b */ insert into nodes (id) values ($1) */ select 1',
    "select 'insert into nodes' as x",
    'select $q$delete from nodes$q$ as x',
    'select 1 /* update nodes set x = 1',
  ])('a read: %s', (q) => expect(isWriteSql(q)).toBe(false));

  it.each([
    // Text Postgres may read otherwise (sql-text.ts `ambiguous`): a
    // backslash before a quote in a plain string, a U& name. Refused like
    // text that never closes, whichever way it would be read.
    "update nodes set title = 'a\\' where id = $1",
    "select 'x\\'; delete from nodes where id = $1; select '1'",
    'update U&"nodes" set title = $1',
  ])('not a write (refused), read otherwise: %s', (q) => expect(isWriteSql(q)).toBe(false));

  it.each([
    // A `--` comment a carriage return ends: the delete after it is code.
    'select 1 --x\r; delete from nodes where id = $1',
    // A dollar quote whose tag is not ASCII ends where Postgres ends it.
    'select $é$x$é$; update nodes set title = $1',
  ])('a write after text the old reader misread: %s', (q) => expect(isWriteSql(q)).toBe(true));
});
