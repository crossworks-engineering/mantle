/**
 * The one app tool rule (client tier audit 2026-09-30, L1; workspaces W5b2,
 * plan R2): an app a workspace other than Admin holds runs the team rules
 * for every runner; an app Admin alone holds keeps the runner's rules; the
 * client rules run only for the client portal's own apps. The author
 * warnings follow the same rule. No database: the lookups are
 * stood in (the team and client rules themselves are proven on Postgres in
 * {member,client}-app-tools.viewer.db.test.ts).
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
    ['admin', 'client', 'none'],
    ['team', 'admin', 'team'],
    ['team', 'team', 'team'],
    ['team', 'client', 'none'],
    ['client', 'client', 'client'],
    ['client', 'team', 'none'],
    ['client', 'admin', 'none'],
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
    // Lower rules stay as they are.
    expect(appToolLevel('client', 'client', 'team')).toBe('client');
    expect(appToolLevel('client', 'team', 'team')).toBe('none');
  });
});

describe('appToolVerdict', () => {
  it('at client level refuses the brain-wide and team reads (built-ins off the client list)', async () => {
    for (const slug of ['page_get', 'contact_list', 'table_rows_list', 'search_chunks']) {
      const v = await appToolVerdict('client', 'brain', [slug], slug);
      expect(v, slug).toMatchObject({ ok: false, status: 403 });
      if (!v.ok) expect(v.reason).toMatch(/client apps/);
    }
    // A built-in's slug is refused before any lookup.
    expect(resolveTool).not.toHaveBeenCalled();
  });

  it('at client level refuses an outside tool without External access', async () => {
    const v = await appToolVerdict('client', 'brain', ['weather'], 'weather');
    expect(v).toMatchObject({ ok: false, status: 403 });
    if (!v.ok) expect(v.reason).toMatch(/External access/);
  });

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
  it('runs admin on the owner web surface, team and client on their roles', () => {
    expect(appToolScope('admin', who)).toEqual({ viewer: 'admin', surface: { kind: 'web' } });
    expect(appToolScope('team', who)).toEqual({
      viewer: 'team',
      surface: { kind: 'team', loginId: 'l1', contactName: 'Pat', privateReads: false },
    });
    expect(appToolScope('client', who)).toEqual({
      viewer: 'client',
      surface: { kind: 'client', loginId: 'l1', contactName: 'Pat' },
    });
  });

  it('never scopes a call at none', () => {
    expect(() => appToolScope('none', who)).toThrow(APP_NO_TOOLS);
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
