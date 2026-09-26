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
  lowerLevel,
  readsDrafts,
  runInTxScope,
  viewerDatabaseUrl,
  viewerRoleName,
  viewerRolePassword,
  withViewer,
} from './viewer';
import { viewerRoleStatements } from './viewer-roles';

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

  it('lowerLevel orders public < client < team < admin', () => {
    expect(lowerLevel('admin', 'team')).toBe('team');
    expect(lowerLevel('client', 'team')).toBe('client');
    expect(lowerLevel('public', 'admin')).toBe('public');
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
