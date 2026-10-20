/**
 * What the narrow system route refuses by text (gateway/narrow-sendable.ts
 * narrowSendable), no database: a role change whatever builds its name, a
 * DO block, pg_settings, a session setting, and any set_config but a
 * transaction-local one of a literal mantle.* setting (or a named local
 * setting). The same probes run on Postgres in narrow-route.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  NarrowRouteRefusedError,
  gatewaySettings,
  narrowSendable,
} from './gateway/narrow-sendable';

const verdict = (q: string, tagged = false): string => {
  try {
    narrowSendable(q, tagged);
    return 'sent';
  } catch (err) {
    if (err instanceof NarrowRouteRefusedError) return 'refused';
    throw err;
  }
};

describe('narrowSendable (plan v3.2 S7a)', () => {
  it('refuses the escapes no literal shows', () => {
    for (const q of [
      "select set_config('ro' || 'le', 'none', true)",
      'select set_config($1, $2, true)',
      "select set_config($1, 'none', true)",
      "select set_config('mantle.ws', 'x', $1)",
      "select set_config('role'::text, 'none', true)",
      "select set_config(E'role', 'none', true)",
      "select set_config(lower('ROLE'), 'none', true)",
      `select pg_catalog."set_config"('role', 'none', true)`,
      "select set_config('search_path', 'pg_temp', true)",
      "select set_config('mantle.ws', 'x', false)",
      "do $$ begin perform set_config('role', 'none', true); end $$",
      'DO LANGUAGE plpgsql $x$ begin perform 1; end $x$',
      'select 1; do $$ begin perform 1; end $$',
      "update pg_settings set setting = 'none' where name = 'role'",
      "update pg_catalog.pg_settings set setting = 'x' where name = 'role'",
      'set local "role" none',
      'set "session_authorization" = default',
      'set local session authorization default',
      'reset "role"',
      'select 1; set role none',
      'select 1;\n  reset all',
    ]) {
      expect(verdict(q), q).toBe('refused');
    }
  });

  it('sends the settings the app sends', () => {
    for (const q of [
      "select set_config('mantle.create_ws', $1, true)",
      "select set_config('mantle.keep_updated_at', 'on', true)",
      "select set_config('lock_timeout', $1, true)",
      "select current_setting('enable_sort') as v, set_config('enable_sort', 'off', true)",
      "select set_config('enable_sort', $1, true)",
      'set local statement_timeout = 12345',
      "SET LOCAL lock_timeout = '3s'",
      'set local lock_timeout to default',
      'set local hnsw.ef_search = 40',
      "set local hnsw.iterative_scan = 'relaxed_order'",
      'set local "mantle"."keep_updated_at" = on',
      'set transaction isolation level repeatable read',
      '(select 1) union (select 2)',
      'table nodes',
      'values (1)',
      'merge into t using s on t.a = s.a when matched then do nothing',
      'show lock_timeout',
      "select date'2020-01-01', E'it\\'s', x'1f'",
      'select 1 as a$b',
      "insert into t (a) values ('x') on conflict do nothing",
      "insert into t (a) values ('x') on conflict (a) do update set a = excluded.a",
      'select 1 as "do"',
      "select 'set_config(''role'', ''none'', true)' as x",
      "select 'do $$ begin end $$; update pg_settings' as x",
      "select 1 -- set_config('role', 'none', true)",
      "select current_setting('role')",
      // A column named role in an UPDATE is no role change.
      'update "auth"."users" set "role" = $1 where "auth"."users"."id" = $2',
      "update auth.users set role = 'member' where id = $1",
    ]) {
      expect(verdict(q), q).toBe('sent');
    }
  });

  // The a3 audit's forms (MED-1), each with its fix.
  it('refuses a quoted setting name with no space before it (set"role", set local"role")', () => {
    for (const q of [
      'set local"role" none',
      'set local"role" to none',
      'set"role" to none',
      'set session"role" none',
      'set local"session_authorization" default',
      'reset"role"',
      'select 1; set local"role" none',
    ]) {
      expect(verdict(q), q).toBe('refused');
    }
  });

  it('refuses U& strings and identifiers anywhere', () => {
    for (const q of [
      "select set_config(U&'\\0072ole', 'none', true)",
      'set local U&"r\\006fle" to none',
      "select u&'x'",
      'select 1 as U&"a"',
    ]) {
      expect(verdict(q), q).toBe('refused');
    }
  });

  it('refuses every statement but a read, a row write, SET LOCAL of an allowed setting or SET TRANSACTION', () => {
    for (const q of [
      "create function pg_temp.f() returns void language sql as $$ select set_config('role', 'none', true) $$",
      'select 1; create function pg_temp.f() returns int language sql as $$ select 1 $$',
      'select pg_temp.f(); call pg_temp.p()',
      'call mantle_x()',
      'copy nodes to stdout',
      'lock table nodes',
      'explain analyze select 1',
      'prepare p as select 1',
      'execute p',
      'discard all',
      'listen x',
      "notify x, 'y'",
      "load 'x'",
      'alter role mantle_system_narrow bypassrls',
      'grant all on nodes to public',
      'security label on table nodes is null',
      'truncate nodes',
      'set local search_path = pg_temp, public',
      'set local session_replication_role = replica',
      "set local log_statement = 'none'",
      'set constraints all deferred',
      'select 1; table nodes; vacuum',
    ]) {
      expect(verdict(q), q).toBe('refused');
    }
  });

  it('ends a line comment at a carriage return too, as Postgres does', () => {
    for (const q of [
      'select 1 --x\r; set role postgres',
      'select 1 --x\r; reset all',
      'select 1 --x\r; create table t (a int)',
      '--x\rset role postgres',
      '--x\r; reset role',
      "select 1 --x\r; select set_config('role', 'none', true)",
    ]) {
      expect(verdict(q), JSON.stringify(q)).toBe('refused');
    }
    expect(verdict('select 1 --x\r\n, 2')).toBe('sent');
  });

  it('reads a quote after a letter that is not its own token as a plain string (no backslash escapes)', () => {
    for (const q of [
      "select date'\\'; reset role; select '1'",
      "select name'\\'; set local role none; select '1'",
      'select 1 as x$a$; reset role; select $a$$a$',
    ]) {
      expect(verdict(q), q).toBe('refused');
    }
    // An E'' string still reads its escapes: the quote it escapes is no end.
    expect(verdict("select E'\\'; reset role; select '1'")).toBe('sent');
    expect(verdict("select (E'\\'; reset role; select ')")).toBe('sent');
  });

  it('a tagged template: a placeholder never names a function or a setting; a fragment may start with any other word', () => {
    for (const q of [
      "select $1('role', 'none', true)",
      "select pg_catalog.$1('role', 'none', true)",
      'select $1 ($1, $1, true)',
      "set local $1 = 'none'",
      'set local $1 to none',
      '$1',
      '$1; select 1',
      'create function pg_temp.f() returns int language sql as $$ select 1 $$',
      'reset role',
      'select 1; and x = $1',
    ]) {
      expect(verdict(q, true), q).toBe('refused');
    }
    for (const q of [
      'and n.id = $1',
      'where id = any($1)',
      ', updated_at = now()',
      'insert into $1 (a, b) values ($1, $1)',
      'select * from nodes where id = $1',
      'id in $1',
    ]) {
      expect(verdict(q, true), q).toBe('sent');
    }
  });

  it("the gateway's own settings: only the gateway's SET names them (who acts, in whose scope)", async () => {
    const gatewayOwn = [
      "select set_config('mantle.ws', $1, true), set_config('mantle.mod_ws', $2, true), set_config('mantle.scope_login', $3, true), set_config('mantle.write_mode', $4, true)",
      "select set_config('mantle.ws', $1, true), set_config('mantle.mod_ws', $2, true), set_config('mantle.login_id', $3, true)",
    ];
    for (const q of [
      ...gatewayOwn,
      "select set_config('mantle.route', 'full', true)",
      "select set_config('mantle.actor', 'system:x', true)",
      "select set_config('mantle.actor_check', 'off', true)",
      "select set_config('MANTLE.ACTOR', 'system:x', true)",
      "select mantle_ws_private_workspace(set_config('mantle.scope_login', $1, true)::uuid)::text as ws",
      "set local mantle.route = 'full'",
      'set local "mantle"."actor_check" = off',
      "set local mantle.scope_login = ''",
    ]) {
      expect(verdict(q), q).toBe('refused');
    }
    const inGateway = await gatewaySettings(async () => gatewayOwn.map((q) => verdict(q)));
    expect(inGateway).toEqual(['sent', 'sent']);
    // Only while the gateway's own SET is being sent.
    expect(verdict(gatewayOwn[0]!)).toBe('refused');
  });
});
