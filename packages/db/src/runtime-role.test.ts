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
  SYSTEM_ROLE,
  dbRoleMode,
  dbRoleNote,
  runtimeDatabaseUrl,
  runtimeDeniedTables,
  runtimeRolePassword,
  runtimeRoleStatements,
  systemDatabaseUrl,
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
      'NOREPLICATION',
    ]) {
      expect(r).toContain(attr);
    }
    expect(r).toContain(`PASSWORD 'pw_1-x'`);
  });

  it('the owner and the marker never log in and bypass nothing', () => {
    for (const name of [OWNER_ROLE, SYSTEM_ROLE]) {
      const r = role(name);
      expect(r).toContain('NOLOGIN');
      expect(r).toContain('NOSUPERUSER');
      expect(r).toContain('NOBYPASSRLS');
      expect(r).toContain('PASSWORD NULL');
    }
  });

  it('no password: the runtime role exists without a login; an existing role is altered', () => {
    const none = runtimeRoleStatements(new Set([RUNTIME_ROLE]), null);
    expect(none.find((s) => s.includes(`"${RUNTIME_ROLE}" WITH`))).toMatch(
      /^ALTER ROLE "mantle_runtime" WITH NOLOGIN .*PASSWORD NULL$/,
    );
  });

  it('the memberships: the runtime role may become the write role only through the marker', () => {
    expect(stmts).toContain(
      `GRANT "${SYSTEM_ROLE}" TO "${RUNTIME_ROLE}" WITH INHERIT TRUE, SET TRUE, ADMIN FALSE`,
    );
    expect(stmts).toContain(
      `GRANT "mantle_write_user" TO "${SYSTEM_ROLE}" WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`,
    );
    expect(stmts.some((s) => /GRANT "mantle_owner" TO/.test(s))).toBe(false);
    expect(stmts.some((s) => /GRANT "mantle_write_user" TO "mantle_runtime"/.test(s))).toBe(false);
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
