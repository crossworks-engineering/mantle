/**
 * The viewer scope's rules (member logins Phase 0b). Pure: no database. The
 * row-level behaviour against a real Postgres is viewer.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  asSystem,
  assertNoViewer,
  currentScopeTx,
  currentSpaceScope,
  currentViewerLevel,
  itemLevelAbove,
  levelCovers,
  levelsMeet,
  lowerLevel,
  ViewerLevelConflictError,
  readsDrafts,
  runInTxScope,
  viewerDatabaseUrl,
  viewerLoginRoleName,
  viewerRoleName,
  viewerRolePassword,
  withViewer,
} from './viewer';
import {
  noteOwner,
  ownerNote,
  parseViewerLoginRole,
  viewerLoginDropStatements,
  viewerRolePlan,
  viewerRoleStatements,
} from './viewer-roles';

describe('personal-space scope (Phase 2)', () => {
  const space = { spaceId: 'space-a', loginId: 'login-a' };
  const tx = { fake: 'tx' };
  const inSpace = <T>(fn: () => Promise<T>) => runInTxScope({ level: 'team', space, tx }, fn);

  it('runs at team, carries its space and its transaction, and reads drafts', async () => {
    const seen = await inSpace(async () => ({
      level: currentViewerLevel(),
      space: currentSpaceScope(),
      tx: currentScopeTx(),
      drafts: readsDrafts(),
    }));
    expect(seen).toEqual({ level: 'team', space, tx, drafts: true });
    expect([currentSpaceScope(), currentScopeTx(), readsDrafts()]).toEqual([null, null, true]);
  });

  it('cannot queue work', async () => {
    await inSpace(async () => {
      expect(() => assertNoViewer('a job')).toThrow(/cannot queue work/);
    });
  });

  it("withViewer('admin') changes nothing: the space and its transaction stay", async () => {
    const seen = await inSpace(() =>
      withViewer('admin', async () => [currentSpaceScope(), currentScopeTx()]),
    );
    expect(seen).toEqual([space, tx]);
  });

  it('a lower withViewer leaves the space for the brain at that level (no drafts)', async () => {
    const seen = await inSpace(() =>
      withViewer('team', async () => [currentSpaceScope(), currentScopeTx(), readsDrafts()]),
    );
    expect(seen).toEqual([null, null, false]);
  });

  it('asSystem leaves the space for the admin pool', async () => {
    const seen = await inSpace(() =>
      asSystem(async () => [currentViewerLevel(), currentSpaceScope()]),
    );
    expect(seen).toEqual(['admin', null]);
  });

  it('a level scope never reads drafts', async () => {
    expect(await withViewer('team', async () => readsDrafts())).toBe(false);
  });
});

describe('withViewer', () => {
  it('runs at admin outside any scope', () => {
    expect(currentViewerLevel()).toBe('admin');
  });

  it('holds the level across awaits', async () => {
    const seen = await withViewer('team', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentViewerLevel();
    });
    expect(seen).toBe('team');
    expect(currentViewerLevel()).toBe('admin');
  });

  it('only ever goes down: a nested admin scope stays at the outer level', async () => {
    const seen = await withViewer('team', () =>
      withViewer('admin', async () => currentViewerLevel()),
    );
    expect(seen).toBe('team');
  });

  it('a nested lower scope wins', async () => {
    const seen = await withViewer('team', () =>
      withViewer('public', async () => currentViewerLevel()),
    );
    expect(seen).toBe('public');
  });

  it('keeps concurrent scopes apart', async () => {
    const [a, b] = await Promise.all([
      withViewer('team', async () => {
        await new Promise((r) => setTimeout(r, 5));
        return currentViewerLevel();
      }),
      withViewer('client', async () => currentViewerLevel()),
    ]);
    expect([a, b]).toEqual(['team', 'client']);
  });

  it('asSystem steps out of the scope for its own work only', async () => {
    const seen = await withViewer('team', async () => {
      const inside = await asSystem(async () => {
        await new Promise((r) => setTimeout(r, 1));
        return currentViewerLevel();
      });
      return [inside, currentViewerLevel()];
    });
    expect(seen).toEqual(['admin', 'team']);
  });

  it('refuses to queue work from inside a limited scope', async () => {
    expect(() => assertNoViewer('enqueueX')).not.toThrow();
    await withViewer('team', async () => {
      expect(() => assertNoViewer('enqueueX')).toThrow(/enqueueX .* 'team'/);
    });
  });

  it('lowerLevel: team and admin over the rest, client and public are siblings', () => {
    expect(lowerLevel('admin', 'team')).toBe('team');
    expect(lowerLevel('client', 'team')).toBe('client');
    expect(lowerLevel('team', 'public')).toBe('public');
    expect(lowerLevel('public', 'admin')).toBe('public');
    expect(lowerLevel('client', 'client')).toBe('client');
    expect(() => lowerLevel('client', 'public')).toThrow(ViewerLevelConflictError);
    expect(() => lowerLevel('public', 'client')).toThrow(ViewerLevelConflictError);
    expect(levelsMeet('client', 'public')).toBe(false);
    expect(levelsMeet('team', 'public')).toBe(true);
    // What each level reads (mantle_viewer_audiences, 0187).
    expect(levelCovers('client', 'public')).toBe(false);
    expect(levelCovers('public', 'client')).toBe(false);
    expect(levelCovers('team', 'client')).toBe(true);
    expect(levelCovers('team', 'admin')).toBe(false);
    // The item rank stays a chain (raising and lowering items).
    expect(itemLevelAbove('client', 'public')).toBe(true);
    expect(itemLevelAbove('public', 'client')).toBe(false);
  });

  it('a client scope refuses public work and a public scope client work (never widened)', async () => {
    await withViewer('client', async () => {
      await expect(withViewer('public', async () => currentViewerLevel())).rejects.toBeInstanceOf(
        ViewerLevelConflictError,
      );
      // admin and team requests keep the client scope.
      expect(await withViewer('team', async () => currentViewerLevel())).toBe('client');
      expect(await withViewer('admin', async () => currentViewerLevel())).toBe('client');
    });
    await withViewer('public', async () => {
      await expect(withViewer('client', async () => 1)).rejects.toMatchObject({
        code: 'viewer-level-conflict',
        current: 'public',
        requested: 'client',
      });
    });
    // A team scope still lowers to either.
    await withViewer('team', async () => {
      expect(await withViewer('public', async () => currentViewerLevel())).toBe('public');
      expect(await withViewer('client', async () => currentViewerLevel())).toBe('client');
    });
  });

  it("a client's space opened under a public scope is refused", async () => {
    await withViewer('public', async () => {
      expect(() => runInTxScope({ level: 'client', tx: { fake: 'tx' } }, async () => 1)).toThrow(
        ViewerLevelConflictError,
      );
    });
  });
});

describe('viewer role credentials', () => {
  it('derives a stable password per key and level, different per level and key', () => {
    const a = viewerRolePassword('key-1', 'team');
    expect(viewerRolePassword('key-1', 'team')).toBe(a);
    expect(viewerRolePassword('key-1', 'client')).not.toBe(a);
    expect(viewerRolePassword('key-2', 'team')).not.toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('refuses to derive without a master key', () => {
    expect(() => viewerRolePassword('', 'team')).toThrow(/MANTLE_MASTER_KEY/);
  });

  it('swaps only the user and password in the admin URL', () => {
    const url = viewerDatabaseUrl(
      'postgres://postgres:secret@db:5432/postgres?sslmode=disable',
      'team',
      'pw',
    );
    const u = new URL(url);
    expect(u.username).toBe('mantle_view_team');
    expect(u.password).toBe('pw');
    expect(u.host).toBe('db:5432');
    expect(u.pathname).toBe('/postgres');
    expect(u.search).toBe('?sslmode=disable');
  });

  it('never names the team visitor cookie', () => {
    expect(viewerRoleName('team')).toBe('mantle_view_team');
  });
});

describe('viewerRoleStatements', () => {
  it('creates a LOGIN role that can never bypass row level security', () => {
    const [stmt] = viewerRoleStatements('team', 'key-1', false);
    expect(stmt).toMatch(/^CREATE ROLE "mantle_view_team" WITH LOGIN /);
    for (const attr of ['NOSUPERUSER', 'NOBYPASSRLS', 'NOCREATEROLE', 'NOINHERIT']) {
      expect(stmt).toContain(attr);
    }
    expect(stmt).toContain(`PASSWORD '${viewerRolePassword('key-1', 'team')}'`);
  });

  it('alters an existing role (re-derives the password after a key change)', () => {
    const [stmt] = viewerRoleStatements('client', 'key-2', true);
    expect(stmt).toMatch(/^ALTER ROLE "mantle_view_client" WITH LOGIN /);
  });

  it('with no master key the role exists but cannot log in', () => {
    const [stmt] = viewerRoleStatements('public', null, false);
    expect(stmt).toContain('NOLOGIN');
    expect(stmt).toContain('PASSWORD NULL');
    expect(stmt).not.toMatch(/\bLOGIN\b/);
  });
});

describe('brains sharing one Postgres cluster (viewerRolePlan)', () => {
  const shared = [
    'mantle_view_team',
    'mantle_view_client',
    'mantle_view_public',
    'mantle_view_space',
  ];
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
    for (const role of shared) {
      expect(plan).toContain(
        `ALTER ROLE "${role}" WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 30 PASSWORD '${viewerRolePassword('key-a', role.replace('mantle_view_', '') as 'team')}'`,
      );
      expect(plan).toContain(`COMMENT ON ROLE "${role}" IS '${ownerNote('brain_a')}'`);
    }
  });

  it('the owner migrating again resets the passwords (a key change) and writes no note', () => {
    const plan = viewerRolePlan(cluster('brain_a', 'brain_a'), 'key-a2', false);
    expect(plan.filter((s) => s.startsWith('ALTER ROLE'))).toHaveLength(4);
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
    expect(plan).toContain(`COMMENT ON ROLE "mantle_view_space" IS '${ownerNote('brain_b')}'`);
  });

  it('per-database never alters a shared role, and logs in as its own role that may only SET it', () => {
    const plan = viewerRolePlan(cluster('brain_b', 'brain_a'), 'key-b', true);
    expect(plan.some((s) => shared.some((r) => s.startsWith(`ALTER ROLE "${r}" `)))).toBe(false);
    expect(plan.some((s) => s.startsWith('COMMENT'))).toBe(false);
    for (const role of shared) {
      const login = `${role}_brain_b`;
      expect(plan).toContain(
        `CREATE ROLE "${login}" WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 30 PASSWORD '${viewerRolePassword('key-b', role.replace('mantle_view_', '') as 'team')}'`,
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
      'GRANT CONNECT ON DATABASE "brain_b" TO "mantle_view_team_brain_b", "mantle_view_client_brain_b", "mantle_view_public_brain_b", "mantle_view_space_brain_b", CURRENT_USER',
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

  it('a login role name parses back to its level and database; the shared ones do not', () => {
    expect(parseViewerLoginRole('mantle_view_space_brain_b')).toEqual({
      level: 'space',
      database: 'brain_b',
    });
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
      'REVOKE ALL ON DATABASE "brain_b" FROM "mantle_view_team_brain_b"',
      'DROP ROLE IF EXISTS "mantle_view_team_brain_b"',
      'REVOKE ALL ON DATABASE "brain_b" FROM "mantle_view_space_brain_b"',
      'DROP ROLE IF EXISTS "mantle_view_space_brain_b"',
    ]);
    expect(viewerLoginDropStatements('brain_b', false, roles)).toEqual([
      'DROP ROLE IF EXISTS "mantle_view_team_brain_b"',
      'DROP ROLE IF EXISTS "mantle_view_space_brain_b"',
    ]);
    expect(() => viewerLoginDropStatements('Brain-B', false, roles)).toThrow(/\[a-z0-9_\]/);
  });

  it('per-database on an empty cluster creates the shared roles without a login', () => {
    const plan = viewerRolePlan(
      { database: 'brain_b', roles: new Map(), databases: new Set(['brain_b']) },
      'key-b',
      true,
    );
    expect(plan).toContain(
      'CREATE ROLE "mantle_view_team" WITH NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD NULL',
    );
  });

  it('per-database alters its own existing login role', () => {
    const plan = viewerRolePlan(
      cluster('brain_b', 'brain_a', undefined, { mantle_view_space_brain_b: null }),
      'key-b',
      true,
    );
    expect(
      plan.some((s) => s.startsWith('ALTER ROLE "mantle_view_space_brain_b" WITH LOGIN')),
    ).toBe(true);
  });

  it('the pool logs in as the per-database role only when asked', () => {
    const admin = 'postgres://postgres:pw@db:5432/brain_b?sslmode=disable';
    expect(new URL(viewerDatabaseUrl(admin, 'space', 'p')).username).toBe('mantle_view_space');
    const u = new URL(viewerDatabaseUrl(admin, 'space', 'p', true));
    expect([u.username, u.pathname, u.search]).toEqual([
      'mantle_view_space_brain_b',
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
