/**
 * The viewer scope's rules (member logins Phase 0b). Pure: no database. The
 * row-level behaviour against a real Postgres is viewer.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  asSystem,
  currentViewerLevel,
  lowerLevel,
  viewerDatabaseUrl,
  viewerRoleName,
  viewerRolePassword,
  withViewer,
} from './viewer';
import { viewerRoleStatements } from './viewer-roles';

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
