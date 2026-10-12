/**
 * Which statements the system pool sends outside a transaction block, with
 * no actor set (arch A2a fix round, M3b): Postgres refuses them inside one.
 */
import { describe, expect, it } from 'vitest';
import { needsActorWrap, runsOutsideTransaction } from './client';

describe('runsOutsideTransaction', () => {
  it('finds them after comments, whitespace and SET statements', () => {
    for (const q of [
      'vacuum analyze nodes',
      '  -- a note\n/* more */ VACUUM nodes',
      "set statement_timeout = '0'; vacuum nodes",
      'create index concurrently x on nodes (id)',
      'drop index concurrently x',
      'reindex database brain',
      'REINDEX (VERBOSE) SCHEMA public',
      'reindex system brain',
      'reindex index concurrently x',
      'call mantle_backfill()',
      'create database x',
      'alter system set work_mem = 1',
      'discard all',
    ]) {
      expect(runsOutsideTransaction(q), q).toBe(true);
    }
  });

  it('leaves everything else in its transaction', () => {
    for (const q of [
      'select 1',
      'insert into nodes default values',
      'reindex table nodes',
      'set transaction read only',
      "select 'vacuum'",
      '-- vacuum\nselect 1',
    ]) {
      expect(runsOutsideTransaction(q), q).toBe(false);
    }
  });
});

describe('needsActorWrap (owner decision: writes and unknown verbs only)', () => {
  it('runs reads plain', () => {
    for (const q of [
      'select 1',
      '  -- a note\nSELECT * from nodes',
      'with x as (select 1) select * from x',
      'values (1)',
      'show work_mem',
      'explain select 1',
      'select mantle_ws_private_workspace($1)',
    ]) {
      expect(needsActorWrap(q), q).toBe(false);
    }
  });

  it('wraps writes, a writing WITH and anything it cannot name', () => {
    for (const q of [
      'insert into nodes default values',
      '/* x */ update nodes set title = $1',
      'delete from nodes',
      'merge into nodes using x on true when matched then do nothing',
      'truncate nodes',
      'copy nodes from stdin',
      'with u as (update nodes set title = title returning id) select * from u',
      'with x as (select 1) insert into t select * from x',
      'explain analyze delete from nodes',
      'lock table nodes',
      'frobnicate',
    ]) {
      expect(needsActorWrap(q), q).toBe(true);
    }
  });
});
