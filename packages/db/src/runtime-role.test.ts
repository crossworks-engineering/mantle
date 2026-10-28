/**
 * The runtime role's pure parts (workspaces arch A9): the attributes that
 * make it a lock, the URL the app's pools use, and the mode report.
 * runtime-role.db.test.ts proves the lock on a real Postgres.
 */
import { readFileSync } from 'node:fs';
import * as schema from './schema';
import { tablesOf } from './test-support/narrow-write-scan';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCESS_MATRIX,
  CREDENTIAL_NAME,
  NARROW_CREDENTIAL_TABLES,
  NARROW_MOVES_LEFT,
  NARROW_REINSERT_HELD,
  NARROW_NEVER_INSERT,
  NARROW_NEVER_UPDATE,
  NARROW_NEVER_UPDATE_TABLE,
  NARROW_ONE_WAY_HELD,
  NARROW_WRITES,
  narrowMayWrite,
  narrowFor,
  type TableAccess,
} from './access-matrix';
import {
  NARROW_DENIED_FUNCTIONS,
  NARROW_SYSTEM_FUNCTIONS,
  NARROW_ROLE,
  OWNER_ROLE,
  RUNTIME_DENIED_FUNCTIONS,
  RUNTIME_ROLE,
  RUNTIME_SYSTEM_FUNCTIONS,
  SYSTEM_ROLE,
  wantedMemberships,
  dbRoleMode,
  dbRoleNote,
  runtimeDatabaseUrl,
  narrowReadOnlyTables,
  narrowWriteTables,
  runtimeDeniedTables,
  runtimeReadOnlyTables,
  runtimeRolePassword,
  runtimeRoleStatements,
  narrowRolePassword,
  NARROW_CONNECTION_LIMIT,
  NARROW_LOGIN_FIX,
  narrowLoginNote,
  revokeOrder,
  systemDatabaseUrl,
  type HeldMembership,
} from './runtime-role';

const saved = { ...process.env };
afterEach(() => {
  for (const k of [
    'DATABASE_URL',
    'MANTLE_MASTER_KEY',
    'MANTLE_DB_RUNTIME_ROLE',
    'MANTLE_VIEWER_ROLES_PER_DATABASE',
  ]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('the runtime role statements', () => {
  const stmts = runtimeRoleStatements(new Set(), 'pw_1-x');
  const role = (name: string) => stmts.find((s) => s.includes(`ROLE "${name}" WITH`))!;

  it('the runtime role logs in, bypasses the row rules, and holds no owner power', () => {
    const r = role(RUNTIME_ROLE);
    expect(r).toMatch(/^CREATE ROLE "mantle_runtime" WITH LOGIN /);
    for (const attr of [
      'NOSUPERUSER',
      'BYPASSRLS',
      'NOCREATEDB',
      'NOCREATEROLE',
      'NOINHERIT',
      'NOREPLICATION',
    ]) {
      expect(r).toContain(attr);
    }
    expect(r).toContain(`PASSWORD 'pw_1-x'`);
  });

  it('the owner and mantle_system never log in; only the owner bypasses the row rules', () => {
    for (const name of [OWNER_ROLE, SYSTEM_ROLE]) {
      const r = role(name);
      expect(r).toContain('NOLOGIN');
      expect(r).toContain('NOSUPERUSER');
      expect(r).toContain('NOINHERIT');
      expect(r).toContain('PASSWORD NULL');
    }
    // A foreign key's cascade runs as the owner, as it ran as the superuser.
    expect(role(OWNER_ROLE)).toMatch(/ BYPASSRLS /);
    expect(role(SYSTEM_ROLE)).toContain('NOBYPASSRLS');
  });

  it('no password: the runtime role exists without a login; an existing role is altered', () => {
    const none = runtimeRoleStatements(new Set([RUNTIME_ROLE]), null);
    expect(none.find((s) => s.includes(`"${RUNTIME_ROLE}" WITH`))).toMatch(
      /^ALTER ROLE "mantle_runtime" WITH NOLOGIN .*PASSWORD NULL$/,
    );
  });

  it('the memberships: no INHERIT anywhere; the write role only through mantle_system', () => {
    // A member of the owner without its rights: mantle_owner_role() (0290,
    // MEMBER) says yes, and the marker is out of reach.
    expect(stmts).toContain(
      `GRANT "${OWNER_ROLE}" TO "${RUNTIME_ROLE}" WITH INHERIT FALSE, SET FALSE, ADMIN FALSE`,
    );
    expect(stmts).toContain(
      `GRANT "${SYSTEM_ROLE}" TO "${RUNTIME_ROLE}" WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`,
    );
    expect(stmts).toContain(
      `GRANT "mantle_write_user" TO "${SYSTEM_ROLE}" WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`,
    );
    const grants = stmts.filter((s) => s.startsWith('GRANT'));
    expect(grants).toHaveLength(wantedMemberships().length);
    expect(grants.some((s) => /INHERIT TRUE|ADMIN TRUE/.test(s))).toBe(false);
    expect(stmts.some((s) => /GRANT "mantle_write_user" TO "mantle_runtime"/.test(s))).toBe(false);
    // The owner holds no membership: it owns the marker itself.
    expect(wantedMemberships().some((m) => m.member === OWNER_ROLE)).toBe(false);
  });

  it("the narrow role's boot line: a role that cannot log in names the fix; a stored setting is named in either mode", () => {
    expect(NARROW_CONNECTION_LIMIT).toBe(36);
    expect(narrowLoginNote({ login: true, settings: 0 }, true)).toBeNull();
    expect(narrowLoginNote({ login: false, settings: 0 }, false)).toBeNull();
    expect(narrowLoginNote(null, false)).toBeNull();
    for (const row of [{ login: false, settings: 0 }, null]) {
      expect(narrowLoginNote(row, true)).toBe(
        `[db] the narrow route logs in as ${NARROW_ROLE}, but it ${
          row ? 'cannot log in' : 'does not exist'
        }: every narrow statement fails until you ${NARROW_LOGIN_FIX}`,
      );
    }
    expect(NARROW_LOGIN_FIX).toMatch(/^run migrate as a superuser /);
    for (const on of [true, false]) {
      expect(narrowLoginNote({ login: true, settings: 2 }, on)).toMatch(
        /^\[db\] mantle_system_narrow has 2 stored setting row\(s\) .*the next migrate takes them all back$/,
      );
    }
    expect(narrowLoginNote({ login: false, settings: 1 }, true)!.split('\n')).toHaveLength(2);
  });

  it('the narrow system role: logs in only with its own password, bypasses the row rules, holds no owner power', () => {
    // Its login follows its own password (given at migrate with a master
    // key, outside per-database mode), never the runtime role's.
    for (const pw of ['pw_1-x', null]) {
      const r = runtimeRoleStatements(new Set(), pw).find((x) =>
        x.includes(`ROLE "${NARROW_ROLE}" WITH`),
      )!;
      expect(r).toBe(
        `CREATE ROLE "${NARROW_ROLE}" WITH NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB ` +
          `NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT ${NARROW_CONNECTION_LIMIT} PASSWORD NULL`,
      );
    }
    const on = runtimeRoleStatements(new Set([NARROW_ROLE]), null, 'npw_2-y');
    expect(on.find((x) => x.includes(`"${NARROW_ROLE}" WITH`))).toBe(
      `ALTER ROLE "${NARROW_ROLE}" WITH LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB ` +
        `NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT ${NARROW_CONNECTION_LIMIT} PASSWORD 'npw_2-y'`,
    );
    // The narrow password never reaches the runtime role, nor the reverse.
    expect(on.find((x) => x.includes(`"${RUNTIME_ROLE}" WITH`))).toMatch(
      / WITH NOLOGIN .*PASSWORD NULL$/,
    );
    expect(
      runtimeRoleStatements(new Set([NARROW_ROLE]), null).find((x) =>
        x.includes(`"${NARROW_ROLE}" WITH`),
      ),
    ).toMatch(/^ALTER ROLE "mantle_system_narrow" WITH NOLOGIN /);
    expect(() => runtimeRoleStatements(new Set(), null, "x'y")).toThrow(/base64url/);
    // Two labels of one key: the passwords differ.
    expect(narrowRolePassword('k')).not.toBe(runtimeRolePassword('k'));
    expect(narrowRolePassword('k')).toBe(narrowRolePassword('k'));
    // The runtime role may SET ROLE to it, never inherit it; it is a member
    // of nothing, and nothing else is a member of it.
    expect(stmts).toContain(
      `GRANT "${NARROW_ROLE}" TO "${RUNTIME_ROLE}" WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`,
    );
    expect(wantedMemberships().filter((m) => m.member === NARROW_ROLE)).toEqual([]);
    expect(wantedMemberships().filter((m) => m.role === NARROW_ROLE)).toEqual([
      { member: RUNTIME_ROLE, role: NARROW_ROLE, inherit: false, set: true },
    ]);
  });

  it('refuses a password that would need quoting', () => {
    expect(() => runtimeRoleStatements(new Set(), "x'y")).toThrow(/base64url/);
  });
});

describe('the URL the app pools use', () => {
  const admin = 'postgres://postgres:secret@db.internal:5432/brain?sslmode=disable';

  it('is DATABASE_URL while the switch is off', () => {
    process.env.DATABASE_URL = admin;
    delete process.env.MANTLE_DB_RUNTIME_ROLE;
    expect(systemDatabaseUrl()).toBe(admin);
  });

  it('is the runtime role on the same server and database when it is on', () => {
    process.env.DATABASE_URL = admin;
    process.env.MANTLE_DB_RUNTIME_ROLE = '1';
    process.env.MANTLE_MASTER_KEY = 'k';
    const u = new URL(systemDatabaseUrl());
    expect(u.username).toBe(RUNTIME_ROLE);
    expect(u.password).toBe(runtimeRolePassword('k'));
    expect(u.host).toBe('db.internal:5432');
    expect(u.pathname).toBe('/brain');
    expect(u.searchParams.get('sslmode')).toBe('disable');
    expect(runtimeDatabaseUrl(admin, 'p')).toContain('mantle_runtime:p@');
  });

  it('fails loudly, never falls back, without a key or with per-database roles', () => {
    process.env.DATABASE_URL = admin;
    process.env.MANTLE_DB_RUNTIME_ROLE = '1';
    delete process.env.MANTLE_MASTER_KEY;
    expect(() => systemDatabaseUrl()).toThrow(/MANTLE_MASTER_KEY/);
    process.env.MANTLE_MASTER_KEY = 'k';
    process.env.MANTLE_VIEWER_ROLES_PER_DATABASE = '1';
    expect(() => systemDatabaseUrl()).toThrow(/one brain per Postgres cluster/);
  });

  it('the password is derived, stable and base64url, and not a viewer role password', () => {
    expect(runtimeRolePassword('k')).toBe(runtimeRolePassword('k'));
    expect(runtimeRolePassword('k')).not.toBe(runtimeRolePassword('k2'));
    expect(runtimeRolePassword('k')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('the mode report', () => {
  it('names the three modes', () => {
    const row = { user: RUNTIME_ROLE, superuser: false, bypassrls: true, owns: 0 };
    expect(dbRoleMode(row)).toBe('runtime');
    expect(dbRoleNote(row, true)).toBeNull();
    const su = { user: 'postgres', superuser: true, bypassrls: true, owns: 150 };
    expect(dbRoleMode(su)).toBe('superuser');
    expect(dbRoleNote(su, false)).toMatch(/MANTLE_DB_RUNTIME_ROLE=1/);
    // Plan v3.2 S4a: off is said loudly; on as the superuser is not.
    expect(dbRoleNote(su, false)).toMatch(
      /^\[db\] SECURITY: MANTLE_DB_RUNTIME_ROLE is unset or 0\. /,
    );
    expect(dbRoleNote(su, true)).not.toMatch(/SECURITY/);
    expect(dbRoleNote({ ...row, owns: 3 }, false)).toMatch(/^\[db\] SECURITY: /);
    expect(dbRoleMode({ ...row, owns: 3 })).toBe('other');
    expect(dbRoleMode({ ...row, user: 'someone' })).toBe('other');
  });
});

describe('what the runtime role may not touch', () => {
  it('the system functions are a reviewed list, apart from the denied ones', () => {
    for (const [fn, why] of Object.entries(RUNTIME_SYSTEM_FUNCTIONS)) {
      expect(fn).toMatch(/^public\.mantle_[a-z_]+\(/);
      expect(why.length, fn).toBeGreaterThan(10);
      expect(Object.keys(RUNTIME_DENIED_FUNCTIONS)).not.toContain(fn);
    }
    // The workspaces switch is the migrator's (executeAsMigrator).
    expect(Object.keys(RUNTIME_SYSTEM_FUNCTIONS).some((f) => /mantle_ws_migrate/.test(f))).toBe(
      false,
    );
  });

  it('the heads key and the switches of the checks are on the lists', () => {
    expect(runtimeDeniedTables()).toContain('public.mantle_heads_key');
    for (const fn of [
      'public.mantle_set_actor_check(text,integer,text)',
      'public.mantle_set_edit_check(text,integer,text)',
      'public.mantle_switch_triggers(text[],boolean,integer)',
      'public.mantle_heads_bypass(text)',
      'public.mantle_set_actor(text,text,text)',
    ]) {
      expect(Object.keys(RUNTIME_DENIED_FUNCTIONS)).toContain(fn);
    }
  });
});

describe('the order memberships are taken back in', () => {
  const m = (member: string, role: string, grantor: string, admin = false): HeldMembership => ({
    member,
    role,
    grantor,
    inherit: false,
    set: false,
    admin,
  });

  it('takes a grant passed on through ADMIN OPTION before the one it rests on', () => {
    // postgres -> ops_a (ADMIN) -> ops_b (ADMIN) -> ops_c, and a plain one.
    const a = m('ops_a', SYSTEM_ROLE, 'postgres', true);
    const b = m('ops_b', SYSTEM_ROLE, 'ops_a', true);
    const c = m('ops_c', SYSTEM_ROLE, 'ops_b');
    const plain = m('ops_d', OWNER_ROLE, 'postgres');
    const held = [a, plain, b, c];
    expect(revokeOrder(held, held)).toEqual([c, b, a, plain]);
  });

  it('counts a chain through a membership that is kept, and never loops', () => {
    // ops_a's ADMIN grant is not to be revoked here, but ops_b's rests on it.
    const a = m('ops_a', SYSTEM_ROLE, 'postgres', true);
    const b = m('ops_b', SYSTEM_ROLE, 'ops_a');
    const other = m('ops_b', OWNER_ROLE, 'ops_a'); // ops_a holds no ADMIN in mantle_owner
    expect(revokeOrder([other, b], [a, b, other])).toEqual([b, other]);
    const x = m('x', SYSTEM_ROLE, 'y', true);
    const y = m('y', SYSTEM_ROLE, 'x', true);
    expect(revokeOrder([x, y], [x, y])).toHaveLength(2);
  });
});

describe('the narrow system role rights', () => {
  it('derives from the runtime role and the writer: content read only, system and admin all', () => {
    for (const t of ACCESS_MATRIX) {
      const want =
        t.runtime === 'none'
          ? 'none'
          : t.runtime === 'read'
            ? 'read'
            : t.writer === 'content'
              ? 'read'
              : 'all';
      // A hand value (the measured credential and rights tables) only
      // narrows the derived one.
      if (t.narrow !== undefined) {
        expect(t.table in NARROW_CREDENTIAL_TABLES, t.table).toBe(true);
        continue;
      }
      expect(narrowFor(t), t.table).toBe(want);
    }
  });

  it('lists every credential and rights table with its narrow value and why; a new one cannot default to all', () => {
    const byName = new Map(ACCESS_MATRIX.map((t) => [t.table, t]));
    for (const [table, want] of Object.entries(NARROW_CREDENTIAL_TABLES)) {
      const t = byName.get(table);
      expect(t, table).toBeDefined();
      expect(narrowFor(t!), table).toBe(want.narrow);
      expect(want.why.length, table).toBeGreaterThan(20);
    }
    // A matrix table whose name reads as a credential is listed: a new
    // credential table fails here until its narrow value is reviewed.
    const unlisted = ACCESS_MATRIX.map((t) => t.table).filter(
      (n) => CREDENTIAL_NAME.test(n.replace(/^public\./, '')) && !(n in NARROW_CREDENTIAL_TABLES),
    );
    expect(unlisted).toEqual([]);
    // The a1 audit's list, every one of them.
    for (const n of [
      'auth.users',
      'secrets',
      'api_keys',
      'access_keys',
      'pdf_passwords',
      'email_accounts',
      'telegram_accounts',
      'calendar_accounts',
      'ms_accounts',
      'microsoft_config',
      'tailscale_config',
      'oauth_clients',
      'oauth_auth_codes',
      'oauth_access_tokens',
      'mobile_tokens',
      'pairing_codes',
      'member_invites',
      'mantle_peers',
      'peer_shares',
      'push_subscriptions',
      'contact_share_codes',
      'archive_mcp_login_tokens',
      'archive_client_signin_codes',
      'spaces',
      'space_item_homes',
      'private_workspaces',
      'former_user_workspaces',
      'channels',
      'agents',
    ]) {
      expect(n.includes('.') ? n : `public.${n}`, n).toSatisfy(
        (x: string) => x in NARROW_CREDENTIAL_TABLES,
      );
    }
  });

  it('a hand value may only narrow, never widen past the derived value', () => {
    const t = (x: Partial<TableAccess>): TableAccess => ({
      table: 'public.x',
      writer: 'system',
      ...x,
    });
    expect(narrowFor(t({ narrow: 'read' }))).toBe('read');
    expect(narrowFor(t({ narrow: 'none' }))).toBe('none');
    expect(() => narrowFor(t({ writer: 'content', narrow: 'all' }))).toThrow(/wider/);
    expect(narrowFor(t({ writer: 'content', narrow: 'read' }))).toBe('read');
    expect(narrowFor(t({ writer: 'content', narrow: 'none' }))).toBe('none');
    expect(narrowFor(t({ runtime: 'read', narrow: 'none' }))).toBe('none');
    expect(() => narrowFor(t({ runtime: 'read', narrow: 'all' }))).toThrow(/wider/);
    expect(() => narrowFor(t({ runtime: 'none', narrow: 'read' }))).toThrow(/wider/);
  });

  it('pins the sets: no content table written, no runtime-closed table opened', () => {
    const writes = new Set(narrowWriteTables());
    const reads = new Set(narrowReadOnlyTables());
    for (const t of ACCESS_MATRIX) {
      if (t.writer === 'content') expect(writes.has(t.table), t.table).toBe(false);
    }
    for (const t of runtimeDeniedTables()) {
      expect(writes.has(t) || reads.has(t), t).toBe(false);
    }
    for (const t of runtimeReadOnlyTables()) expect(writes.has(t), t).toBe(false);
    // The counts: a new table lands in one of them by the derivation; a
    // change here is a reviewed line.
    expect({
      all: writes.size,
      read: reads.size,
      none: ACCESS_MATRIX.length - writes.size - reads.size,
    }).toEqual(NARROW_COUNTS);
  });

  it('its EXECUTE list is a measured allowlist, never a content or workspace writer', () => {
    // The allowlist (plan v3.2 S7a part a3): what narrow statements call, by
    // name, measured with the switch on. Only goes down, or a reviewed line.
    expect(Object.keys(NARROW_SYSTEM_FUNCTIONS).sort()).toEqual([
      // The users area's access log names and a contact's sharing, and the
      // integrity audit's check, skip and shared reads (the area reads a
      // trace of every decided function's callers found).
      'public.mantle_access_log_names(uuid,uuid[])',
      // An assistant's level counts (GET /api/agents on the
      // assistants area's narrow exit), a read of counts only.
      'public.mantle_agent_experience(uuid,uuid[])',
      'public.mantle_area_rule(uuid,text)',
      'public.mantle_brain_id()',
      'public.mantle_check_box_mode(text)',
      'public.mantle_check_lowered()',
      // Round 14: a connector held beyond Admin (its sync, move and key
      // rotate on the Admin area's narrow exit), a structure read.
      'public.mantle_connector_beyond_admin(uuid,text)',
      'public.mantle_connector_rows(uuid,text,uuid[])',
      'public.mantle_connector_state(uuid,text)',
      'public.mantle_contact_sharing(uuid,uuid[])',
      'public.mantle_login_areas(uuid)',
      // S8b round 4: the users area's change reads its target's role from
      // Admin membership (loadLoginTarget), and the peers area asks whether
      // a peer's bound login is an Admin user (peer-access): read definers.
      'public.mantle_login_is_admin(uuid)',
      'public.mantle_login_role(uuid)',
      'public.mantle_mail_backfill_accounts(uuid)',
      // 0327: the hold on a login's grants asks whether an MCP client
      // carries a live grant of the owner or an Admin user.
      'public.mantle_narrow_client_held(uuid)',
      // 0327: the hold on auth.users (a trigger as the narrow role) asks
      // whether a login is the owner or an Admin user, a read definer.
      'public.mantle_narrow_login_held(uuid)',
      // 0321: the assistant_messages guard's read definer.
      'public.mantle_narrow_message_ok(uuid,uuid,uuid,uuid)',
      'public.mantle_pending_card_route(uuid,uuid)',
      'public.mantle_ws_any_shared(uuid[])',
      'public.mantle_ws_kind(uuid)',
      'public.mantle_ws_private_for(uuid,uuid)',
      'public.mantle_ws_skip_reason()',
    ]);
    for (const [fn, why] of Object.entries(NARROW_SYSTEM_FUNCTIONS)) {
      expect(fn, fn).toMatch(/^public\.mantle_[a-z0-9_]+\(/);
      expect(Object.keys(NARROW_DENIED_FUNCTIONS), fn).not.toContain(fn);
      expect(Object.keys(RUNTIME_DENIED_FUNCTIONS), fn).not.toContain(fn);
      expect(why.length, fn).toBeGreaterThan(10);
    }
    // The content and workspace writers among the definers (the a2
    // re-audit's 17; the onboarding attach left the narrow list in round
    // 13c: it needs the login, so it runs at the spot acting-login), each
    // denied by name (the login bridge is gone since 0334).
    const writers = [
      'mantle_ws_add_user',
      'mantle_ws_remove_user',
      'mantle_ws_create',
      'mantle_ws_archive',
      'mantle_ws_resource_add',
      'mantle_ws_resource_remove',
      'mantle_ws_resource_set_write',
      'mantle_ws_set_assistant',
      'mantle_ws_set_contact',
      'mantle_ws_set_landing',
      'mantle_ws_update_about',
      'mantle_workspace_event',
      'mantle_lock_heads',
      'mantle_share_close_admin',
      'mantle_share_contact_write_set',
    ];
    expect(writers).toHaveLength(15);
    for (const body of writers) {
      expect(
        Object.keys(NARROW_DENIED_FUNCTIONS).some((f) => f.startsWith(`public.${body}(`)),
        body,
      ).toBe(true);
    }
  });

  it('its denied list is reasoned', () => {
    // Each one the runtime role may run (from this list or a viewer role's
    // grant): runtime-role.db.test.ts checks it on the live catalog.
    for (const [fn, why] of Object.entries(NARROW_DENIED_FUNCTIONS)) {
      expect(fn, fn).toMatch(/^public\.mantle_[a-z0-9_]+\(/);
      expect(Object.keys(RUNTIME_DENIED_FUNCTIONS), fn).not.toContain(fn);
      expect(why.length, fn).toBeGreaterThan(10);
    }
    // The four bodies with no Admin check are never the narrow role's.
    for (const body of [
      'mantle_contact_sharing_rows',
      'mantle_contact_shares_revoke_rows',
      'mantle_share_with_contacts_rows',
      'mantle_entity_merge_rows',
    ]) {
      expect(
        Object.keys(NARROW_DENIED_FUNCTIONS).some((f) => f.startsWith(`public.${body}(`)),
        body,
      ).toBe(true);
    }
  });
});

describe("the narrow pool's startup parameters (pools.ts narrowStartup)", () => {
  it("pinned at the app's values; TimeZone, DateStyle, IntervalStyle, zone abbreviations and string literals the system pool's; transaction_timeout from 17", async () => {
    const { narrowStartup, NARROW_STARTUP_FIXED } = await import('./gateway/pools');
    const pg16 = {
      server_version: '16.4',
      TimeZone: 'Etc/UTC',
      DateStyle: 'ISO, MDY',
      IntervalStyle: 'postgres',
      timezone_abbreviations: 'Default',
      standard_conforming_strings: 'on',
    };
    expect(narrowStartup(pg16)).toEqual({
      search_path: '"$user", public',
      default_transaction_read_only: 'off',
      default_transaction_isolation: 'read committed',
      row_security: 'on',
      statement_timeout: '0',
      lock_timeout: '0',
      idle_in_transaction_session_timeout: '0',
      idle_session_timeout: '0',
      exit_on_error: 'off',
      synchronous_commit: 'on',
      bytea_output: 'hex',
      extra_float_digits: '1',
      array_nulls: 'on',
      transform_null_equals: 'off',
      xmloption: 'content',
      gin_fuzzy_search_limit: '0',
      TimeZone: 'Etc/UTC',
      DateStyle: 'ISO, MDY',
      IntervalStyle: 'postgres',
      timezone_abbreviations: 'Default',
      standard_conforming_strings: 'on',
    });
    // Postgres 17 and later: transaction_timeout too (16 would refuse the
    // login on an unknown startup parameter).
    expect(narrowStartup({ ...pg16, server_version: '18.1 (Debian 18.1-1.pgdg13+2)' })).toEqual({
      ...narrowStartup(pg16),
      transaction_timeout: '0',
    });
    // Nothing read: the fixed ones only (the route never connects so: it
    // reads the system pool's first and fails closed when it cannot).
    expect(narrowStartup({})).toEqual({ ...NARROW_STARTUP_FIXED });
  });

  it("the pool reads them at each connect, from the system pool's session-start values (systemStartup), never its reported parameters", async () => {
    const { newNarrowPool } = await import('./gateway/pools');
    const { systemStartup, systemStartupOf } = await import('./gateway/narrow-route');
    const reported: Record<string, string> = { server_version: '18.1', TimeZone: 'Asia/Tokyo' };
    let rows: { name: string; reset_val: string }[] = [];
    let reads = 0;
    let fail: Error | null = new Error('connection refused');
    const system = {
      parameters: reported,
      options: { parsers: {}, serializers: {} },
      unsafe: () => {
        reads += 1;
        return fail ? Promise.reject(fail) : Promise.resolve(rows);
      },
    };
    const pool = newNarrowPool('postgres://narrow:pw@127.0.0.1:1/db', system as never);
    const startup = () =>
      Object.fromEntries(
        Object.entries(Object.assign({}, pool.options.connection)).filter(([, v]) => v),
      );
    // Nothing read yet: no system value (a session SET the pool reported,
    // here TimeZone, never reaches it).
    expect(startup()).not.toHaveProperty('TimeZone');
    // A read that fails fails the narrow statement (fail closed), and the
    // next one reads again.
    await expect(systemStartup(system as never)).rejects.toMatchObject({
      name: 'NarrowStartupError',
    });
    expect(systemStartupOf(system)).toBeUndefined();
    // A read that misses a setting fails closed too.
    fail = null;
    rows = [{ name: 'TimeZone', reset_val: 'UTC' }];
    await expect(systemStartup(system as never)).rejects.toMatchObject({
      name: 'NarrowStartupError',
    });
    rows = [
      { name: 'TimeZone', reset_val: 'America/New_York' },
      { name: 'DateStyle', reset_val: 'ISO, MDY' },
      { name: 'IntervalStyle', reset_val: 'postgres' },
      { name: 'timezone_abbreviations', reset_val: 'Default' },
      { name: 'standard_conforming_strings', reset_val: 'on' },
      { name: 'server_version', reset_val: '18.1' },
    ];
    await systemStartup(system as never);
    expect(reads).toBe(3);
    expect(startup()).toMatchObject({
      TimeZone: 'America/New_York',
      transaction_timeout: '0',
      statement_timeout: '0',
      exit_on_error: 'off',
    });
    // Read once: no round trip after (null), whatever the pool reports.
    reported.TimeZone = 'Pacific/Chatham';
    expect(systemStartup(system as never)).toBeNull();
    expect(reads).toBe(3);
    expect(startup()).toMatchObject({ TimeZone: 'America/New_York' });
  });
});

/** The narrow role's table counts: `all` only goes down. */
// member_turn_ledger to read (0326: its definers write it).
// presents and present_revisions read (0332: a Present canvas is content,
// written by its editors' scope, never by narrow work).
// canvas_data read (0338: its two definers write it; the runtime role reads it).
// The messenger's seven tables all (0335: system-written by the content
// module; the workspace role reads six under the participant rule).
const NARROW_COUNTS = { all: 103, read: 40, none: 8 };

describe('the narrow write allowlist (plan v3.2 S7b part b2 round 8: the class fix)', () => {
  const byName = new Map(ACCESS_MATRIX.map((t) => [t.table, t]));
  /** Every write NARROW_WRITES grants that the rules refuse, as
   *  NARROW_MOVES_LEFT names them (table.column, or table:insert). */
  const refused = (): string[] => {
    const out: string[] = [];
    for (const [table, w] of Object.entries(NARROW_WRITES)) {
      if (w.insert && NARROW_NEVER_INSERT.includes(table)) out.push(`${table}:insert`);
      const never = new Set([...NARROW_NEVER_UPDATE, ...(NARROW_NEVER_UPDATE_TABLE[table] ?? [])]);
      for (const c of w.update) {
        if (never.has(c) && !NARROW_ONE_WAY_HELD.includes(`${table}.${c}`))
          out.push(`${table}.${c}`);
      }
    }
    return out.sort();
  };

  it('grants writes only on tables the narrow role may write at all (narrowFor all)', () => {
    for (const table of Object.keys(NARROW_WRITES)) {
      const t = byName.get(table);
      expect(t, table).toBeDefined();
      expect(narrowFor(t!), table).toBe('all');
      expect(NARROW_WRITES[table]!.why.length, table).toBeGreaterThan(20);
    }
  });

  it('names no maker, rights, destination or execution column and no such insert but the moves left, each with its spot', () => {
    expect(refused()).toEqual(Object.keys(NARROW_MOVES_LEFT).sort());
    for (const why of Object.values(NARROW_MOVES_LEFT)) expect(why).toMatch(/^[a-z-]+(:|$)/);
  });

  it('a table it may INSERT into and DELETE from carries no maker, login, destination or sealed column, or is held with why (round 12: the delete-then-reinsert class)', () => {
    const tables = new Map(
      [...tablesOf(schema as Record<string, unknown>).values()].map((t) => [t.name, t]),
    );
    const flagged: string[] = [];
    for (const [table, w] of Object.entries(NARROW_WRITES)) {
      if (!w.insert || !w.delete) continue;
      const info = tables.get(table);
      expect(info, table).toBeDefined();
      const never = new Set([...NARROW_NEVER_UPDATE, ...(NARROW_NEVER_UPDATE_TABLE[table] ?? [])]);
      const cols = Object.values(info!.columns).filter((c) => never.has(c) && c !== 'id');
      if (cols.length > 0) flagged.push(table);
    }
    expect(flagged.sort()).toEqual(Object.keys(NARROW_REINSERT_HELD).sort());
    for (const why of Object.values(NARROW_REINSERT_HELD)) expect(why.length).toBeGreaterThan(40);
    // The ones the full re-audit forged: a key, a sandbox and a mail
    // account take no narrow INSERT now.
    for (const t of ['public.api_keys', 'public.sandboxes', 'public.email_accounts'])
      expect(narrowMayWrite(t, 'insert'), t).toBe(false);
  });

  it('the moves left only shrink (30 measured; 1 after the spots of round 8; 0 after push-device in round 9)', () => {
    expect(Object.keys(NARROW_MOVES_LEFT).length).toBe(0);
  });

  it('a table not on the allowlist is read only; runs and run items take no narrow insert', () => {
    expect(narrowMayWrite('public.push_instance', 'insert')).toBe(false);
    expect(narrowMayWrite('public.brain_identity', 'update', ['brain_id'])).toBe(false);
    expect(narrowMayWrite('public.conversation_taints', 'delete')).toBe(false);
    expect(narrowMayWrite('public.runs', 'insert')).toBe(false);
    expect(narrowMayWrite('public.run_items', 'insert')).toBe(false);
    expect(narrowMayWrite('public.runs', 'update', ['status'])).toBe(false);
    expect(narrowMayWrite('public.run_items', 'update', ['state'])).toBe(false);
    expect(narrowMayWrite('public.skills', 'update', ['instructions'])).toBe(false);
    expect(narrowMayWrite('public.tools', 'update', ['handler'])).toBe(false);
    expect(narrowMayWrite('public.pending_tool_calls', 'update', ['args'])).toBe(false);
    expect(narrowMayWrite('public.pending_tool_calls', 'update', ['tool_slug'])).toBe(false);
    expect(narrowMayWrite('public.pending_tool_calls', 'update', ['status', 'result'])).toBe(true);
    expect(narrowMayWrite('public.audit_log', 'insert')).toBe(true);
    expect(narrowMayWrite('public.audit_log', 'delete')).toBe(false);
    expect(narrowMayWrite('public.audit_log', 'update', ['detail'])).toBe(false);
  });
});

describe('the system schemas pattern and the default ACL revoke (round 14, DB LOW-3)', () => {
  it("sends 'pg\\_%' (an escaped underscore), so pgboss is not a system schema", async () => {
    const { SYSTEM_SCHEMA_LIKE } = await import('./runtime-role');
    expect(SYSTEM_SCHEMA_LIKE).toBe('pg' + String.fromCharCode(92) + '_%');
    // LIKE with `\_` as a literal underscore, as Postgres reads it.
    const like = (s: string) => /^pg_/.test(s);
    expect(like('pg_catalog')).toBe(true);
    expect(like('pgboss')).toBe(false);
  });

  it('the source sends the pattern as a parameter, never a literal in the SQL text', () => {
    const src = readFileSync(new URL('./runtime-role.ts', import.meta.url), 'utf8');
    expect(src).toContain('n.nspname not like ${SYSTEM_SCHEMA_LIKE}');
    expect(src).not.toMatch(/not like 'pg/);
  });

  it('revokes each entry with its owner, schema, kind and grantee', async () => {
    const { defaultAclRevoke } = await import('./runtime-role');
    expect(
      defaultAclRevoke({ owner: 'postgres', schema: 'public', objtype: 'r', grantee: 'PUBLIC' }),
    ).toBe(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM PUBLIC',
    );
    expect(
      defaultAclRevoke({
        owner: 'postgres',
        schema: null,
        objtype: 'S',
        grantee: 'mantle_system_narrow',
      }),
    ).toBe(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" REVOKE ALL ON SEQUENCES FROM "mantle_system_narrow"',
    );
    expect(defaultAclRevoke({ owner: 'a', schema: 'x', objtype: 'n', grantee: 'PUBLIC' })).toBe(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "a" REVOKE ALL ON SCHEMAS FROM PUBLIC',
    );
  });
});
