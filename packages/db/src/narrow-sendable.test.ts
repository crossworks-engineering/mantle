/**
 * What the narrow system route refuses by text (gateway/narrow-route.ts
 * narrowSendable), no database: a role change whatever builds its name, a
 * DO block, pg_settings, a session setting, and any set_config but a
 * transaction-local one of a literal mantle.* setting (or a named local
 * setting). The same probes run on Postgres in narrow-route.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { NarrowRouteRefusedError, narrowSendable } from './gateway/narrow-route';

const verdict = (q: string): string => {
  try {
    narrowSendable(q);
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
    ]) {
      expect(verdict(q), q).toBe('refused');
    }
  });

  it('sends the settings the app sends', () => {
    for (const q of [
      "select set_config('mantle.ws', $1, true)",
      "select set_config('mantle.ws', $1, true), set_config('mantle.mod_ws', $2, true), set_config('mantle.login_id', $3, true)",
      "select mantle_ws_private_workspace(set_config('mantle.scope_login', $1, true)::uuid)::text as ws",
      "select set_config('lock_timeout', $1, true)",
      "select current_setting('enable_sort') as v, set_config('enable_sort', 'off', true)",
      "select set_config('enable_sort', $1, true)",
      'set local statement_timeout = 12345',
      "insert into t (a) values ('x') on conflict do nothing",
      "insert into t (a) values ('x') on conflict (a) do update set a = excluded.a",
      'select 1 as "do"',
      "select 'set_config(''role'', ''none'', true)' as x",
      "select 'do $$ begin end $$; update pg_settings' as x",
      "select 1 -- set_config('role', 'none', true)",
      "select current_setting('role')",
    ]) {
      expect(verdict(q), q).toBe('sent');
    }
  });
});
