/**
 * The runtime role's pure parts (workspaces arch A9): the attributes that
 * make it a lock, the URL the app's pools use, and the mode report.
 * runtime-role.db.test.ts proves the lock on a real Postgres.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  OWNER_ROLE,
  RUNTIME_DENIED_FUNCTIONS,
  RUNTIME_ROLE,
  RUNTIME_SYSTEM_FUNCTIONS,
  SYSTEM_ROLE,
  wantedMemberships,
  dbRoleMode,
  dbRoleNote,
  runtimeDatabaseUrl,
  runtimeDeniedTables,
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
      'public.mantle_set_actor_check(text,integer)',
      'public.mantle_set_edit_check(text,integer)',
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
