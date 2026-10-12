/**
 * The one app tool rule (client tier audit 2026-09-30, L1; workspaces W5b2,
 * plan R2): an app a workspace other than Admin holds runs the team rules
 * for every runner; an app Admin alone holds keeps the runner's rules.
 * Clients run no apps since workspaces W5c. The author warnings follow the
 * same rule. No database: the lookups are stood in (the team rules
 * themselves are proven on Postgres in member-app-tools.viewer.db.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  app: null as null | {
    toolRules: 'admin' | 'team';
    manifest: { toolSlugs?: string[] };
    authorLevel?: 'admin' | 'team';
  },
}));

vi.mock('./resolve', () => ({
  // 'missing' is no tool; 'weather' is an outside (http) tool without
  // External access; every other slug is its own built-in.
  resolveTool: vi.fn(async (_owner: string, slug: string) =>
    slug === 'missing'
      ? null
      : slug === 'weather'
        ? {
            slug,
            enabled: true,
            requiresConfirm: false,
            handler: { kind: 'http', url: 'https://x.test' },
            externalAccess: null,
          }
        : {
            slug,
            enabled: true,
            requiresConfirm: false,
            handler: { kind: 'builtin', ref: slug },
            externalAccess: null,
          },
  ),
  resolveTools: vi.fn(),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAppRuntime: vi.fn(async () => (h.app ? { authorLevel: 'admin', ...h.app } : null)),
}));

import { resolveTool } from './resolve';
import {
  appToolLevel,
  appToolScope,
  appToolVerdict,
  appToolWarnings,
  APP_NO_TOOLS,
} from './app-tool-level';

beforeEach(() => {
  h.app = null;
  vi.mocked(resolveTool).mockClear();
});

describe('appToolLevel: the holders set the rules (R2)', () => {
  it.each([
    ['admin', 'admin', 'admin'],
    ['admin', 'team', 'team'],
    ['team', 'admin', 'team'],
    ['team', 'team', 'team'],
  ] as const)('runner %s, held %s: %s', (runner, held, want) => {
    expect(appToolLevel(runner, held)).toBe(want);
  });

  it('an unknown holding runs no tools', () => {
    expect(appToolLevel('admin', undefined)).toBe('none');
    expect(appToolLevel('team', null)).toBe('none');
  });

  // Team apps Phase 3, plan A.4: a member-built app never runs admin rules.
  it('the author ceiling: a member-built app runs at most team rules, an admin run included', () => {
    for (const held of ['admin', 'team'] as const) {
      expect(appToolLevel('admin', held, 'team'), held).toBe('team');
      expect(appToolLevel('team', held, 'team'), held).toBe('team');
    }
    expect(appToolLevel('admin', 'admin', 'admin')).toBe('admin');
  });
});

describe('appToolVerdict', () => {
  it('at none refuses every tool, declared or not', async () => {
    const v = await appToolVerdict('none', 'brain', ['calculate'], 'calculate');
    expect(v).toEqual({ ok: false, status: 403, reason: APP_NO_TOOLS });
    expect(resolveTool).not.toHaveBeenCalled();
  });

  it('at admin keeps the owner rule: declared and existing, any handler', async () => {
    expect(await appToolVerdict('admin', 'brain', [], 'contact_list')).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await appToolVerdict('admin', 'brain', ['missing'], 'missing')).toMatchObject({
      ok: false,
      status: 404,
    });
    const v = await appToolVerdict('admin', 'brain', ['contact_list'], 'contact_list');
    expect(v).toMatchObject({ ok: true, tool: { slug: 'contact_list' } });
  });

  it('at team uses the member rules (an http tool is refused)', async () => {
    const v = await appToolVerdict('team', 'brain', ['weather'], 'weather');
    expect(v).toMatchObject({ ok: false, status: 403 });
    if (!v.ok) expect(v.reason).toMatch(/team app/);
  });
});

describe('appToolScope', () => {
  const who = { loginId: 'l1', name: 'Pat' };
  const app = { id: 'a1' };
  const actsFor = { login: 'l1', app };
  it('runs admin on the owner web surface, team on its role', () => {
    expect(appToolScope('admin', who, app)).toEqual({
      viewer: 'admin',
      actsFor,
      surface: { kind: 'web', loginId: 'l1' },
    });
    expect(appToolScope('team', who, app)).toEqual({
      viewer: 'team',
      actsFor,
      surface: { kind: 'team', loginId: 'l1', contactName: 'Pat', privateReads: false },
    });
  });

  it('acts for the runner THROUGH the app, never the runner alone (R2, H1)', () => {
    expect(appToolScope('team', who, { team: true }).actsFor).toEqual({
      login: 'l1',
      app: { team: true },
    });
  });

  it('never scopes a call at none', () => {
    expect(() => appToolScope('none', who, app)).toThrow(APP_NO_TOOLS);
  });
});

describe('appToolWarnings follows the holders', () => {
  it('warns an app another workspace holds about what the team rules refuse', async () => {
    h.app = { toolRules: 'team', manifest: { toolSlugs: ['weather'] } };
    const w = await appToolWarnings('brain', 'app');
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("'weather'");
    expect(w[0]).toMatch(/admins too/);
  });

  it('says nothing for an app Admin alone holds, or a missing one', async () => {
    h.app = { toolRules: 'admin', manifest: { toolSlugs: ['contact_list', 'weather'] } };
    expect(await appToolWarnings('brain', 'app')).toEqual([]);
    // A member-built app Admin holds still warns: it runs team rules.
    h.app = { toolRules: 'admin', manifest: { toolSlugs: ['weather'] }, authorLevel: 'team' };
    expect((await appToolWarnings('brain', 'app')).length).toBe(1);
    h.app = null;
    expect(await appToolWarnings('brain', 'app')).toEqual([]);
  });
});
