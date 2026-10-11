/**
 * isWriteSql (workspaces W6a): which raw statements of a request scope go to
 * the system pool (writes, row locks) and which run in the scope (reads).
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
  ])('a read: %s', (q) => expect(isWriteSql(q)).toBe(false));
});
