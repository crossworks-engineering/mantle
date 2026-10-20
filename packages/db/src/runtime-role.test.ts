/**
 * The runtime role's pure parts (workspaces arch A9): the attributes that
 * make it a lock, the URL the app's pools use, and the mode report.
 * runtime-role.db.test.ts proves the lock on a real Postgres.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCESS_MATRIX,
  CREDENTIAL_NAME,
  NARROW_CREDENTIAL_TABLES,
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

  it('the narrow system role: never logs in, bypasses the row rules, holds no owner power', () => {
    for (const pw of ['pw_1-x', null]) {
      const r = runtimeRoleStatements(new Set(), pw).find((x) =>
        x.includes(`ROLE "${NARROW_ROLE}" WITH`),
      )!;
      expect(r).toBe(
        `CREATE ROLE "${NARROW_ROLE}" WITH NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB ` +
          'NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD NULL',
      );
    }
    expect(
      runtimeRoleStatements(new Set([NARROW_ROLE]), null).find((x) =>
        x.includes(`"${NARROW_ROLE}" WITH`),
      ),
    ).toMatch(/^ALTER ROLE "mantle_system_narrow" WITH NOLOGIN /);
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
      'public.mantle_area_rule(uuid,text)',
      'public.mantle_brain_id()',
      'public.mantle_bridge_login(uuid)',
      'public.mantle_connector_rows(uuid,text,uuid[])',
      'public.mantle_connector_state(uuid,text)',
      'public.mantle_login_areas(uuid)',
      'public.mantle_mail_backfill_accounts(uuid)',
      'public.mantle_pending_card_route(uuid,uuid)',
      'public.mantle_ws_attach_assistants()',
      'public.mantle_ws_kind(uuid)',
      'public.mantle_ws_private_for(uuid,uuid)',
      'public.mantle_ws_set_moderator(uuid,uuid,uuid,boolean,text)',
    ]);
    for (const [fn, why] of Object.entries(NARROW_SYSTEM_FUNCTIONS)) {
      expect(fn, fn).toMatch(/^public\.mantle_[a-z0-9_]+\(/);
      expect(Object.keys(NARROW_DENIED_FUNCTIONS), fn).not.toContain(fn);
      expect(Object.keys(RUNTIME_DENIED_FUNCTIONS), fn).not.toContain(fn);
      expect(why.length, fn).toBeGreaterThan(10);
    }
    // The content and workspace writers among the definers (the a2
    // re-audit's 17 less the two measured: mantle_ws_attach_assistants, the
    // onboarding attach on the assistants area's exit, and
    // mantle_bridge_login, the users area's role change), each denied by name.
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

/** The narrow role's table counts: `all` only goes down. */
const NARROW_COUNTS = { all: 97, read: 36, none: 8 };
