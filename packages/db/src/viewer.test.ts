/**
 * The viewer scope's rules (member logins Phase 0b). Pure: no database. The
 * row-level behaviour against a real Postgres is viewer.db.test.ts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GAP_WRITER_ROLE } from './access-matrix';
import { OWNER_ROLE, RUNTIME_ROLE, SYSTEM_ROLE } from './runtime-role';
import {
  AS_SYSTEM_TURN_REASONS,
  asSystem,
  assertNoViewer,
  assertSystemDbCaller,
  SYSTEM_DB_MODULES,
  systemDbCallerOf,
  systemDbAccessChecked,
  currentScope,
  runInTurnScope,
  TurnScopeExitError,
  levelCovers,
  levelsMeet,
  lowerLevel,
  ViewerLevelConflictError,
  viewerDatabaseUrl,
  viewerLoginRoleName,
  viewerRoleName,
  viewerRolePassword,
} from './viewer';
import {
  managedRolePatterns,
  noteOwner,
  POOL_ROLES,
  RETIRED_POOL_ROLES,
  ROLE_CONNECTION_LIMIT,
  ownerNote,
  parseViewerLoginRole,
  viewerLoginDropStatements,
  viewerRolePlan,
  viewerRoleStatements,
} from './viewer-roles';

describe('scope basics (no level scope since W8c)', () => {
  const scopeOf = (w: string) =>
    Object.freeze({ kind: 'assistant' as const, loginId: null, ws: [w], modWs: [] });
  const W1 = '00000000-0000-4000-8000-0000000000b1';
  const W2 = '00000000-0000-4000-8000-0000000000b2';

  it('outside any scope the code is system work', () => {
    expect(currentScope()).toEqual({ kind: 'system' });
  });

  it('holds a scope across awaits and keeps concurrent scopes apart', async () => {
    const [a, b] = await Promise.all([
      runInTurnScope(scopeOf(W1), async () => {
        await new Promise((r) => setTimeout(r, 5));
        return currentScope();
      }),
      runInTurnScope(scopeOf(W2), async () => currentScope()),
    ]);
    expect([a, b]).toMatchObject([{ ws: [W1] }, { ws: [W2] }]);
    expect(currentScope()).toEqual({ kind: 'system' });
  });

  it('asSystem steps out of the scope for its own work only', async () => {
    const seen = await runInTurnScope(scopeOf(W1), async () => {
      const inside = await asSystem(async () => {
        await new Promise((r) => setTimeout(r, 1));
        return currentScope();
      }, 'connector-binding');
      return [inside, currentScope()];
    });
    expect(seen).toMatchObject([{ kind: 'system' }, { ws: [W1] }]);
  });

  it('refuses to queue work from inside a workspace scope', async () => {
    expect(() => assertNoViewer('enqueueX')).not.toThrow();
    await runInTurnScope(scopeOf(W1), async () => {
      expect(() => assertNoViewer('enqueueX')).toThrow(/enqueueX leaves this process/);
    });
  });

  it('lowerLevel: team and admin over the rest, client and public are siblings', () => {
    // Pure helpers for code that still names a level in a value; no read is
    // decided by them since W8c.
    expect(lowerLevel('admin', 'team')).toBe('team');
    expect(lowerLevel('client', 'team')).toBe('client');
    expect(lowerLevel('team', 'public')).toBe('public');
    expect(lowerLevel('public', 'admin')).toBe('public');
    expect(lowerLevel('client', 'client')).toBe('client');
    expect(() => lowerLevel('client', 'public')).toThrow(ViewerLevelConflictError);
    expect(() => lowerLevel('public', 'client')).toThrow(ViewerLevelConflictError);
    expect(levelsMeet('client', 'public')).toBe(false);
    expect(levelsMeet('team', 'public')).toBe(true);
    expect(levelCovers('client', 'public')).toBe(false);
    expect(levelCovers('public', 'client')).toBe(false);
    expect(levelCovers('team', 'client')).toBe(true);
    expect(levelCovers('team', 'admin')).toBe(false);
  });
});

describe('viewer role credentials', () => {
  it('derives a stable password per key, different per key', () => {
    const a = viewerRolePassword('key-1', 'user');
    expect(viewerRolePassword('key-1', 'user')).toBe(a);
    expect(viewerRolePassword('key-2', 'user')).not.toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('refuses to derive without a master key', () => {
    expect(() => viewerRolePassword('', 'user')).toThrow(/MANTLE_MASTER_KEY/);
  });

  it('swaps only the user and password in the admin URL', () => {
    const url = viewerDatabaseUrl(
      'postgres://postgres:secret@db:5432/postgres?sslmode=disable',
      'user',
      'pw',
    );
    const u = new URL(url);
    expect(u.username).toBe('mantle_view_user');
    expect(u.password).toBe('pw');
    expect(u.host).toBe('db:5432');
    expect(u.pathname).toBe('/postgres');
    expect(u.search).toBe('?sslmode=disable');
  });

  it('never names the team visitor cookie', () => {
    expect(viewerRoleName('team')).toBe('mantle_view_team');
  });

  it('the write role is mantle_write_user (0277 gate, plan 20.1), with its own password', () => {
    expect(viewerRoleName('write')).toBe('mantle_write_user');
    expect(viewerRolePassword('key-1', 'write')).not.toBe(viewerRolePassword('key-1', 'user'));
  });
});

describe('viewerRoleStatements', () => {
  it('creates a LOGIN role that can never bypass row level security', () => {
    for (const level of POOL_ROLES) {
      const [stmt] = viewerRoleStatements(level, 'key-1', false);
      expect(stmt).toMatch(new RegExp(`^CREATE ROLE "${viewerRoleName(level)}" WITH LOGIN `));
      for (const attr of ['NOSUPERUSER', 'NOBYPASSRLS', 'NOCREATEROLE', 'NOINHERIT']) {
        expect(stmt).toContain(attr);
      }
      expect(stmt).toContain(`CONNECTION LIMIT ${ROLE_CONNECTION_LIMIT[level]}`);
      expect(stmt).toContain(`PASSWORD '${viewerRolePassword('key-1', level)}'`);
    }
    expect(POOL_ROLES).toEqual(['user', 'write']);
    // The write role's cap holds the box's worst case (docs/actors.md).
    expect(ROLE_CONNECTION_LIMIT).toEqual({ user: 30, write: 20 });
  });

  it('alters an existing role (re-derives the password after a key change)', () => {
    const [stmt] = viewerRoleStatements('user', 'key-2', true);
    expect(stmt).toMatch(/^ALTER ROLE "mantle_view_user" WITH LOGIN /);
  });

  it('with no master key the role exists but cannot log in', () => {
    const [stmt] = viewerRoleStatements('user', null, false);
    expect(stmt).toContain('NOLOGIN');
    expect(stmt).toContain('PASSWORD NULL');
    expect(stmt).not.toMatch(/\bLOGIN\b/);
  });
});

describe('brains sharing one Postgres cluster (viewerRolePlan)', () => {
  // The level roles (retired in W8c) still exist on every upgraded cluster.
  const retired = ['mantle_view_team', 'mantle_view_client', 'mantle_view_public'];
  const levels = POOL_ROLES;
  const live = levels.map((l) => viewerRoleName(l));
  const shared = [...retired, ...live];
  const NOLOGIN =
    'WITH NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD NULL';
  const cluster = (
    database: string,
    owner: string | null,
    databases: string[] = ['brain_a', 'brain_b'],
    extra: Record<string, string | null> = {},
  ) => ({
    database,
    roles: new Map<string, string | null>([
      ...shared.map(
        (r) => [r, owner === null ? null : ownerNote(owner)] as [string, string | null],
      ),
      ...Object.entries(extra),
    ]),
    databases: new Set(databases),
  });

  it('the owner note round-trips, and a foreign comment names no owner', () => {
    expect(noteOwner(ownerNote('brain_a'))).toBe('brain_a');
    expect(noteOwner('someone else wrote this')).toBeNull();
    expect(noteOwner(null)).toBeNull();
  });

  it('a box upgrading (roles with no note) resets the passwords as before and claims them', () => {
    const plan = viewerRolePlan(cluster('brain_a', null), 'key-a', false);
    for (const level of levels) {
      const role = viewerRoleName(level);
      expect(plan).toContain(
        `ALTER ROLE "${role}" WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT ${ROLE_CONNECTION_LIMIT[level]} PASSWORD '${viewerRolePassword('key-a', level)}'`,
      );
      expect(plan).toContain(`COMMENT ON ROLE "${role}" IS '${ownerNote('brain_a')}'`);
    }
    // The level roles are made NOLOGIN, never claimed.
    for (const role of retired) {
      expect(plan).toContain(`ALTER ROLE "${role}" ${NOLOGIN}`);
      expect(plan.some((s) => s.startsWith(`COMMENT ON ROLE "${role}"`))).toBe(false);
    }
  });

  it('a box from before A2b2a (no write role yet) creates it with a login and claims it', () => {
    const before = cluster('brain_a', 'brain_a');
    before.roles.delete('mantle_write_user');
    const plan = viewerRolePlan(before, 'key-a', false);
    expect(plan).toContain(
      `CREATE ROLE "mantle_write_user" WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 20 PASSWORD '${viewerRolePassword('key-a', 'write')}'`,
    );
    expect(plan).toContain(`COMMENT ON ROLE "mantle_write_user" IS '${ownerNote('brain_a')}'`);
    // The workspace role is only re-derived; its note is already right.
    expect(plan.some((s) => s.startsWith('COMMENT ON ROLE "mantle_view_user"'))).toBe(false);
  });

  it('the owner migrating again resets the passwords (a key change) and writes no note', () => {
    const plan = viewerRolePlan(cluster('brain_a', 'brain_a'), 'key-a2', false);
    expect(plan.filter((s) => /^ALTER ROLE .* WITH LOGIN /.test(s))).toHaveLength(live.length);
    expect(plan.some((s) => s.startsWith('COMMENT'))).toBe(false);
  });

  it('a second brain on the cluster is refused before any change (the incident)', () => {
    expect(() => viewerRolePlan(cluster('brain_b', 'brain_a'), 'key-b', false)).toThrow(
      /belong to the brain in database "brain_a".*MANTLE_VIEWER_ROLES_PER_DATABASE=1/s,
    );
    // With no key it would have taken the logins away: refused too.
    expect(() => viewerRolePlan(cluster('brain_b', 'brain_a'), null, false)).toThrow(/brain_a/);
  });

  it('an owner database that is gone (a restore, a rename) hands the roles over', () => {
    const plan = viewerRolePlan(cluster('brain_b', 'old_brain'), 'key-b', false);
    expect(plan).toContain(`COMMENT ON ROLE "mantle_view_user" IS '${ownerNote('brain_b')}'`);
  });

  it('per-database never alters a shared role, and logs in as its own role that may only SET it', () => {
    const plan = viewerRolePlan(cluster('brain_b', 'brain_a'), 'key-b', true);
    expect(plan.some((s) => shared.some((r) => s.startsWith(`ALTER ROLE "${r}" `)))).toBe(false);
    expect(plan.some((s) => s.startsWith('COMMENT'))).toBe(false);
    for (const level of levels) {
      const role = viewerRoleName(level);
      const login = `${role}_brain_b`;
      expect(plan).toContain(
        `CREATE ROLE "${login}" WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT ${ROLE_CONNECTION_LIMIT[level]} PASSWORD '${viewerRolePassword('key-b', level)}'`,
      );
      expect(plan).toContain(
        `GRANT "${role}" TO "${login}" WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`,
      );
      expect(plan).toContain(`ALTER ROLE "${login}" IN DATABASE "brain_b" SET role = '${role}'`);
    }
  });

  it('per-database closes its database to every login but its own and the app role', () => {
    const plan = viewerRolePlan(cluster('brain_b', 'brain_a'), 'key-b', true);
    const revoke = plan.indexOf('REVOKE CONNECT ON DATABASE "brain_b" FROM PUBLIC');
    const grant = plan.indexOf(
      'GRANT CONNECT ON DATABASE "brain_b" TO "mantle_view_user_brain_b", "mantle_write_user_brain_b", CURRENT_USER',
    );
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
    // Never to the shared roles: the owner brain's logins stay out too.
    expect(plan.filter((s) => s.startsWith('GRANT CONNECT'))).toHaveLength(1);
    // Shared mode (every box) changes no database privilege.
    const box = viewerRolePlan(cluster('brain_a', 'brain_a'), 'key-a', false);
    expect(box.some((s) => /CONNECT ON DATABASE/.test(s))).toBe(false);
  });

  it('both modes drop the per-database logins of a database that is gone, and only those', () => {
    const extra = {
      mantle_view_space_gone_brain: null,
      mantle_view_team_gone_brain: null,
      mantle_view_space_brain_b: null,
    };
    for (const perDatabase of [true, false]) {
      const db = perDatabase ? 'brain_b' : 'brain_a';
      const plan = viewerRolePlan(cluster(db, 'brain_a', undefined, extra), 'key', perDatabase);
      const drops = plan.filter((s) => s.startsWith('DROP ROLE'));
      expect(drops.sort()).toEqual([
        'DROP ROLE IF EXISTS "mantle_view_space_gone_brain"',
        'DROP ROLE IF EXISTS "mantle_view_team_gone_brain"',
      ]);
    }
    // A box (no per-database logins) drops nothing.
    expect(
      viewerRolePlan(cluster('brain_a', 'brain_a'), 'key-a', false).some((s) =>
        s.startsWith('DROP'),
      ),
    ).toBe(false);
  });

  it('the catalog patterns match every managed role and its logins, and nothing else', () => {
    // LIKE with only `\_` (a literal _) and `%` in the patterns.
    const like = (p: string) => new RegExp(`^${p.replace(/\\_/g, '_').replace(/%/g, '.*')}$`);
    const hit = (name: string) => managedRolePatterns().some((p) => like(p).test(name));
    for (const n of ['mantle_view_user', 'mantle_write_user', 'mantle_write_user_brain_b']) {
      expect(hit(n)).toBe(true);
    }
    expect(hit('mantle_view_space_brain_b')).toBe(true);
    expect(hit('mantle_writer')).toBe(false);
    expect(hit('mantle_test_reader_1')).toBe(false);
  });

  it("db-restore.sh makes every managed role before a restore (a dump's rules name them)", () => {
    const script = readFileSync(
      fileURLToPath(new URL('../../../scripts/db-restore.sh', import.meta.url)),
      'utf8',
    );
    const list = /FOREACH r IN ARRAY ARRAY\[([^\]]*)\]/.exec(script)?.[1] ?? '';
    const named = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    // The viewer roles, the gap writer (A2b2b: its row rules too) and the
    // runtime roles (A9: the dump's grants and default privileges).
    expect(named.sort()).toEqual(
      [
        ...[...POOL_ROLES, ...RETIRED_POOL_ROLES].map((r) => viewerRoleName(r)),
        GAP_WRITER_ROLE,
        OWNER_ROLE,
        SYSTEM_ROLE,
        RUNTIME_ROLE,
      ].sort(),
    );
  });

  it('a login role name parses back to its level and database; the shared ones do not', () => {
    expect(parseViewerLoginRole('mantle_view_space_brain_b')).toEqual({
      level: 'space',
      database: 'brain_b',
    });
    expect(parseViewerLoginRole('mantle_write_user_brain_b')).toEqual({
      level: 'write',
      database: 'brain_b',
    });
    expect(parseViewerLoginRole('mantle_write_user')).toBeNull();
    expect(parseViewerLoginRole('mantle_view_space')).toBeNull();
    expect(parseViewerLoginRole('mantle_view_client_')).toBeNull();
    expect(parseViewerLoginRole('mantle_test_reader_1')).toBeNull();
  });

  it('teardown revokes the CONNECT grant before it drops a login, and never a shared role', () => {
    const roles = new Set([
      'mantle_view_space',
      'mantle_view_space_brain_b',
      'mantle_view_team_brain_b',
    ]);
    expect(viewerLoginDropStatements('brain_b', true, roles)).toEqual([
      'REVOKE ALL ON DATABASE "brain_b" FROM "mantle_view_space_brain_b"',
      'DROP ROLE IF EXISTS "mantle_view_space_brain_b"',
      'REVOKE ALL ON DATABASE "brain_b" FROM "mantle_view_team_brain_b"',
      'DROP ROLE IF EXISTS "mantle_view_team_brain_b"',
    ]);
    expect(viewerLoginDropStatements('brain_b', false, roles)).toEqual([
      'DROP ROLE IF EXISTS "mantle_view_space_brain_b"',
      'DROP ROLE IF EXISTS "mantle_view_team_brain_b"',
    ]);
    expect(() => viewerLoginDropStatements('Brain-B', false, roles)).toThrow(/\[a-z0-9_\]/);
  });

  it('per-database on an empty cluster creates the shared roles without a login', () => {
    const plan = viewerRolePlan(
      { database: 'brain_b', roles: new Map(), databases: new Set(['brain_b']) },
      'key-b',
      true,
    );
    for (const role of ['mantle_view_user', 'mantle_write_user', 'mantle_view_team']) {
      expect(plan).toContain(`CREATE ROLE "${role}" ${NOLOGIN}`);
    }
  });

  it('per-database alters its own existing login role', () => {
    const plan = viewerRolePlan(
      cluster('brain_b', 'brain_a', undefined, { mantle_view_user_brain_b: null }),
      'key-b',
      true,
    );
    expect(plan.some((s) => s.startsWith('ALTER ROLE "mantle_view_user_brain_b" WITH LOGIN'))).toBe(
      true,
    );
  });

  it('the personal-space role is retired (W6b): no login, no password; made NOLOGIN where missing', () => {
    // Shared mode: the shared role, where it exists.
    const box = viewerRolePlan(
      cluster('brain_a', 'brain_a', undefined, { mantle_view_space: null }),
      'key-a',
      false,
    );
    expect(box).toContain(`ALTER ROLE "mantle_view_space" ${NOLOGIN}`);
    expect(box.some((s) => /"mantle_view_space" WITH LOGIN/.test(s))).toBe(false);
    // Per-database: its own login, where it exists, retired; a login is
    // never made; the shared role exists already here.
    const own = viewerRolePlan(
      cluster('brain_b', 'brain_a', undefined, {
        mantle_view_space: null,
        mantle_view_space_brain_b: null,
      }),
      'key-b',
      true,
    );
    expect(own).toContain(`ALTER ROLE "mantle_view_space_brain_b" ${NOLOGIN}`);
    expect(
      own.some((s) => s.includes('mantle_view_space') && /WITH LOGIN|CREATE ROLE/.test(s)),
    ).toBe(false);
    // A fresh cluster (fix round 1): the shared role made NOLOGIN, so the
    // migrations that grant to it run; never a LOGIN.
    const fresh = viewerRolePlan(cluster('brain_a', null), 'key-a', false);
    expect(fresh.filter((s) => s.includes('mantle_view_space'))).toEqual([
      `CREATE ROLE "mantle_view_space" ${NOLOGIN}`,
    ]);
    const freshOwn = viewerRolePlan(cluster('brain_b', null), 'key-b', true);
    expect(freshOwn.filter((s) => s.includes('mantle_view_space'))).toEqual([
      `CREATE ROLE "mantle_view_space" ${NOLOGIN}`,
    ]);
  });

  it('the level roles are retired too (W8c): never a LOGIN in either mode', () => {
    const extra = { mantle_view_team_brain_b: null, mantle_view_client_brain_b: null };
    for (const perDatabase of [false, true]) {
      const plan = viewerRolePlan(
        cluster(perDatabase ? 'brain_b' : 'brain_a', 'brain_a', undefined, extra),
        'key',
        perDatabase,
      );
      for (const role of retired) {
        expect(plan.some((s) => s.includes(`"${role}`) && /WITH LOGIN/.test(s))).toBe(false);
      }
    }
    // Per-database: a level login that exists is retired, never dropped
    // while its database exists.
    const own = viewerRolePlan(cluster('brain_b', 'brain_a', undefined, extra), 'key', true);
    expect(own).toContain(`ALTER ROLE "mantle_view_team_brain_b" ${NOLOGIN}`);
    expect(own).toContain(`ALTER ROLE "mantle_view_client_brain_b" ${NOLOGIN}`);
    expect(own.some((s) => s.startsWith('DROP'))).toBe(false);
  });

  it('the pool logs in as the per-database role only when asked', () => {
    const admin = 'postgres://postgres:pw@db:5432/brain_b?sslmode=disable';
    expect(new URL(viewerDatabaseUrl(admin, 'user', 'p')).username).toBe('mantle_view_user');
    const u = new URL(viewerDatabaseUrl(admin, 'user', 'p', true));
    expect([u.username, u.pathname, u.search]).toEqual([
      'mantle_view_user_brain_b',
      '/brain_b',
      '?sslmode=disable',
    ]);
  });

  it('a database name that would need mangling fails loudly', () => {
    expect(() => viewerLoginRoleName('team', 'Brain-B')).toThrow(/\[a-z0-9_\]/);
    expect(() => viewerLoginRoleName('team', '')).toThrow();
    expect(() => viewerLoginRoleName('team', 'x'.repeat(41))).toThrow();
  });
});

describe('asSystem inside a turn scope needs a named reason (W4b fix round 1, M4)', () => {
  const scope = {
    kind: 'assistant' as const,
    loginId: null,
    ws: ['00000000-0000-4000-8000-0000000000a1'],
    modWs: [],
  };
  const inTurn = <T>(fn: () => Promise<T>) => runInTurnScope(scope, fn);
  const env = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = env;
    vi.restoreAllMocks();
  });

  it('outside a turn: any named reason runs, as before', async () => {
    await expect(asSystem(async () => currentScope(), 'login-notice')).resolves.toEqual({
      kind: 'system',
    });
  });

  it('a listed reason leaves the scope for the system pool and is logged once', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const seen = await inTurn(() =>
      asSystem(async () => currentScope(), 'connector-binding').then(async (first) => {
        await asSystem(async () => 1, 'connector-binding');
        return first;
      }),
    );
    expect(seen).toEqual({ kind: 'system' });
    const lines = info.mock.calls.filter((c) => String(c[0]).includes('connector-binding'));
    expect(lines.length).toBeLessThanOrEqual(1);
  });

  it('no reason, or one not on the list, throws in tests and development', async () => {
    let ran = false;
    await expect(
      inTurn(() =>
        asSystem(async () => {
          ran = true;
        }, undefined as never),
      ),
    ).rejects.toBeInstanceOf(TurnScopeExitError);
    await expect(inTurn(() => asSystem(async () => 1, 'just-because' as never))).rejects.toThrow(
      /allowlisted reason/,
    );
    process.env.NODE_ENV = 'development';
    await expect(inTurn(() => asSystem(async () => 1, undefined as never))).rejects.toBeInstanceOf(
      TurnScopeExitError,
    );
    // A reason for work outside turns is not a way out of one.
    await expect(inTurn(() => asSystem(async () => 1, 'login-notice'))).rejects.toBeInstanceOf(
      TurnScopeExitError,
    );
    expect(ran).toBe(false);
  });

  it('in production an unnamed exit is logged (once) and allowed for now', async () => {
    process.env.NODE_ENV = 'production';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      inTurn(() => asSystem(async () => currentScope(), undefined as never)),
    ).resolves.toEqual({
      kind: 'system',
    });
    await inTurn(() => asSystem(async () => 2, undefined as never));
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toMatch(/allowlisted reason/);
  });

  it('the list stays small', () => {
    // 11 since W6a: 'rule-in-query' for the any-login libraries in a
    // request scope. 13 since W6b fix round 3: 'kind-root' named three
    // unrelated lookups, so the file name check ('name-taken') and the
    // export link check ('export-link') each carry their own reason, and
    // the log says which door was used. Each is yes or no structure. 18
    // since W7a: the Admin assistant and the Admin MCP surface run in a
    // scope, and leave it for an Admin-area tool after its area check
    // ('admin-area'), a provider key's id ('provider-key'), contact sharing
    // dates ('contact-sharing'), login names on rows already read
    // ('login-names') and the owner's preferences ('owner-preferences'). 19: the search vocabulary's table-wide
    // statistics ('lexeme-stats'), hidden from a role under row security. 20: the ranked text match of a big
    // scope's search as ids only ('keyword-candidates'). 21 (W7b fix round 1): a deleted app's
    // snapshots for a caller who moderates its home ('app-trash'). 22 since
    // W7c fix round 2: the anchor's own Telegram history in its replay
    // ('owner-telegram'; since W7d 'login-telegram', each login's own
    // Telegram chats), granted to no role.
    // 21 since the W7 integration fix: 'member-request' went with the
    // member request tools (W7b), and no call site names it. 22 since W7
    // integration fix 2: a turn's own open heartbeats ('heartbeat-context').
    // Still 22 with W7d and W7e joined: W7d renamed 'owner-telegram' to
    // 'login-telegram' and W7e reuses 'owner-preferences' for a member's
    // home, so neither adds a reason. 23 since arch A2a: every asSystem
    // names its reason, and the audit row of a connector call on a login's
    // MCP ('audit-log') was the one call made in a turn with none (it was
    // logged and allowed in production, refused and so never written in
    // tests and development). 24 in its fix round: the client-sourced mark
    // an app's table export writes ('client-sourced-mark') had borrowed
    // 'client-sourced-check', a reason for reads. 25 since arch A5 step
    // 6c: an approved pending call leaves the approving path's scope only
    // to enter the one it was asked in ('pending-approval'). 24 since task
    // 698e6faf: a tool's provider key is read by resolveProviderKey
    // (@mantle/api-keys, a system pool module), so no call leaves a scope
    // for a key's id ('provider-key').
    expect(AS_SYSTEM_TURN_REASONS.length).toBeLessThanOrEqual(24);
    expect(AS_SYSTEM_TURN_REASONS).toHaveLength(24);
    expect(AS_SYSTEM_TURN_REASONS).not.toContain('provider-key');
    expect(AS_SYSTEM_TURN_REASONS).toContain('heartbeat-context');
    expect(AS_SYSTEM_TURN_REASONS).not.toContain('member-request');
    expect(AS_SYSTEM_TURN_REASONS).not.toContain('owner-telegram');
  });

  it('each W7a exit names its own reason', () => {
    for (const r of [
      'admin-area',
      'contact-sharing',
      'login-names',
      'owner-preferences',
      'lexeme-stats',
      'keyword-candidates',
      'app-trash',
      'login-telegram',
    ]) {
      expect(AS_SYSTEM_TURN_REASONS).toContain(r);
    }
  });

  it('each W6b structure lookup names its own reason (W6b fix round 3)', () => {
    for (const r of ['kind-root', 'name-taken', 'export-link']) {
      expect(AS_SYSTEM_TURN_REASONS).toContain(r);
    }
  });
});

describe('systemDb inside a turn scope: allowlisted modules only (W4b fix round 2)', () => {
  const scope = {
    kind: 'assistant' as const,
    loginId: null,
    ws: ['00000000-0000-4000-8000-0000000000a2'],
    modWs: [],
  };
  const inTurn = <T>(fn: () => Promise<T>) => runInTurnScope(scope, fn);
  const env = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = env;
    vi.restoreAllMocks();
  });
  /** A stack as the systemDb proxy sees it, called from `file`. */
  const stackFrom = (file: string) =>
    [
      'Error',
      '    at assertSystemDbCaller (/repo/packages/db/src/viewer.ts:600:20)',
      '    at Object.get (/repo/packages/db/src/client.ts:740:30)',
      `    at loadThing (${file}:12:7)`,
      '    at async run (/repo/packages/runtime/src/agent/tool-loop.ts:1:1)',
    ].join('\n');
  const content = '/repo/packages/content/src/nodes.ts';

  it('names the calling file past the proxy frames', () => {
    expect(systemDbCallerOf(stackFrom(content))).toBe(content);
    expect(systemDbCallerOf(stackFrom(`file://${content}`))).toBe(content);
    expect(systemDbCallerOf('Error\n    at <anonymous>')).toBeNull();
    // drizzle reads `this.session` on the proxy inside its own methods: the
    // caller is the project file below it.
    const viaDrizzle = stackFrom(content).replace(
      '    at loadThing',
      '    at PgDatabase.transaction (/repo/node_modules/drizzle-orm/pg-core/db.js:9:9)\n    at loadThing',
    );
    expect(systemDbCallerOf(viaDrizzle)).toBe(content);
  });

  it("skips drizzle's internal reads on the proxy, checks every method (W5a audit W3)", () => {
    // drizzle reads these on systemDb while a query the caller asked for
    // runs: the caller was checked when it touched the method.
    for (const prop of ['session', 'dialect', 'authToken']) {
      expect(systemDbAccessChecked(prop), prop).toBe(false);
    }
    // The raw pool and drizzle's schema handle stay checked (fix round 2,
    // L-2): systemDb.$client is never a way past the guard.
    for (const prop of [
      '$client',
      '_',
      'query',
      'execute',
      'select',
      'insert',
      'update',
      'delete',
      'transaction',
    ]) {
      expect(systemDbAccessChecked(prop), prop).toBe(true);
    }
    expect(systemDbAccessChecked(Symbol('x'))).toBe(true);
  });

  it('outside a turn: any caller, as before', () => {
    expect(() => assertSystemDbCaller(stackFrom(content))).not.toThrow();
  });

  it('in a turn: the infrastructure modules pass, anything else throws', async () => {
    process.env.NODE_ENV = 'test';
    await inTurn(async () => {
      for (const ok of [
        '/repo/packages/tools/src/tool-results.ts',
        '/repo/packages/tracing/src/store.ts',
        '/repo/packages/db/src/llm-guard.ts',
        '/repo/server/web/lib/turn-gates.turn-scope.db.test.ts',
      ]) {
        expect(() => assertSystemDbCaller(stackFrom(ok))).not.toThrow();
      }
      expect(() => assertSystemDbCaller(stackFrom(content))).toThrow(TurnScopeExitError);
      expect(() => assertSystemDbCaller(stackFrom(content))).toThrow(/used from .*nodes\.ts/);
      expect(() => assertSystemDbCaller('Error')).toThrow(/an unknown file/);
    });
  });

  it('in production: logged once per calling file and allowed for now', async () => {
    process.env.NODE_ENV = 'production';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const other = '/repo/packages/content/src/pages.ts';
    await inTurn(async () => {
      expect(() => assertSystemDbCaller(stackFrom(content))).not.toThrow();
      assertSystemDbCaller(stackFrom(content));
      assertSystemDbCaller(stackFrom(other));
    });
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0]![0])).toMatch(/SYSTEM_DB_MODULES/);
  });

  it('the module list equals the eslint import allowlist', () => {
    const file = readFileSync(
      fileURLToPath(new URL('../../../eslint-rules/system-db-allowlist.mjs', import.meta.url)),
      'utf8',
    );
    const block = /SYSTEM_DB_ALLOWLIST = \[([\s\S]*?)\];/.exec(file)?.[1] ?? '';
    const listed = [...block.matchAll(/^\s*'([^']+)',/gm)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(5);
    expect([...SYSTEM_DB_MODULES].sort()).toEqual([...listed].sort());
  });
});

describe('the request scope (workspaces W6a)', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const W1 = '22222222-2222-4222-8222-222222222222';
  const W2 = '33333333-3333-4333-8333-333333333333';
  const scopeOf = (ws: string[], modWs: string[] = []) =>
    Object.freeze({ kind: 'user' as const, loginId: A, ws, modWs });

  it('holds for the rest of the request once the guard enters it', async () => {
    const v = await import('./viewer');
    await v.runInRequestSlot(async () => {
      expect(v.currentScope()).toEqual({ kind: 'system' });
      expect(v.enterRequestScope(scopeOf([W1, W2], [W1]), { writes: false, drafts: true })).toBe(
        true,
      );
      await Promise.resolve();
      expect(v.currentScope()).toMatchObject({ kind: 'user', loginId: A, ws: [W1, W2] });
      expect(v.inTurnScope()).toBe(true);
      expect(v.readsDrafts()).toBe(true);
      expect(v.currentRequestOutcome()).toEqual({ kind: 'user', loginId: A, writes: false });
      // The same scope again is a no-op; another one is refused.
      expect(v.enterRequestScope(scopeOf([W1, W2], [W1]), { writes: false, drafts: true })).toBe(
        true,
      );
      expect(() => v.enterRequestScope(scopeOf([W1]), { writes: false, drafts: true })).toThrow();
    });
  });

  it('is not entered outside a request slot, and a member never reads drafts', async () => {
    const v = await import('./viewer');
    expect(v.enterRequestScope(scopeOf([W1]), { writes: false, drafts: false })).toBe(false);
    await v.runInRequestSlot(async () => {
      v.enterRequestScope(scopeOf([W1]), { writes: true, drafts: false });
      expect(v.readsDrafts()).toBe(false);
      expect(v.currentRequestMode()).toEqual({ writes: true, drafts: false });
    });
  });

  it('asSystem masks it by name, and a narrower scope may be entered inside', async () => {
    const v = await import('./viewer');
    await v.runInRequestSlot(async () => {
      v.enterRequestScope(scopeOf([W1, W2], [W1]), { writes: false, drafts: false });
      await expect(v.asSystem(async () => v.currentScope(), 'rule-in-query')).resolves.toEqual({
        kind: 'system',
      });
      await expect(v.asSystem(async () => 1, undefined as never)).rejects.toThrow(
        /allowlisted reason/,
      );
      const inner = await v.runInViewerScope(scopeOf([W2]), async () => v.currentScope());
      expect(inner).toMatchObject({ ws: [W2] });
      await expect(
        v.runInViewerScope(scopeOf(['44444444-4444-4444-8444-444444444444']), async () => 1),
      ).rejects.toThrow(/another workspace scope/);
      // Back in the request scope after both.
      expect(v.currentScope()).toMatchObject({ ws: [W1, W2] });
    });
  });

  it('records what the guard did when it let a request through on the system pool', async () => {
    const v = await import('./viewer');
    await v.runInRequestSlot(async () => {
      v.noteRequestSystem('area');
      expect(v.currentRequestOutcome()).toEqual({ kind: 'system', why: 'area' });
    });
    await v.runInRequestSlot(async () => {
      v.noteRequestOwnRule(A);
      expect(v.currentRequestOutcome()).toEqual({ kind: 'own-rule', loginId: A });
      expect(v.currentScope()).toEqual({ kind: 'system' });
    });
  });

  it('narrowsWorkspaceScope: subsets of the same login only', async () => {
    const v = await import('./viewer');
    const outer = scopeOf([W1, W2], [W1]);
    expect(v.narrowsWorkspaceScope(outer, scopeOf([W1], [W1]))).toBe(true);
    expect(v.narrowsWorkspaceScope(outer, scopeOf([W2], [W2]))).toBe(false);
    expect(v.narrowsWorkspaceScope(outer, { kind: 'user', loginId: W1, ws: [W1], modWs: [] })).toBe(
      false,
    );
    // An assistant turn inside the login's scope answers that login (W7a
    // fix round 1, M1): another login, or none, would take other areas.
    expect(
      v.narrowsWorkspaceScope(outer, { kind: 'assistant', loginId: A, ws: [W2], modWs: [] }),
    ).toBe(true);
    expect(
      v.narrowsWorkspaceScope(outer, { kind: 'assistant', loginId: null, ws: [W2], modWs: [] }),
    ).toBe(false);
    expect(
      v.narrowsWorkspaceScope(outer, { kind: 'assistant', loginId: W1, ws: [W2], modWs: [] }),
    ).toBe(false);
  });
});
