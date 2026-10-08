/**
 * The one app tool level rule (client tier audit 2026-09-30, L1): a
 * client-level app's tools run at client level for every runner (owner,
 * member and client brokers alike); any other app keeps the runner's rules.
 * The author warnings follow the same rule. No database: the lookups are
 * stood in (the team and client rules themselves are proven on Postgres in
 * {member,client}-app-tools.viewer.db.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  app: null as null | {
    audience: string;
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

describe('appToolLevel: a client app runs client rules for everyone', () => {
  it.each([
    ['admin', 'admin', 'admin'],
    ['admin', 'team', 'admin'],
    ['admin', 'client', 'client'],
    ['admin', 'public', 'admin'],
    ['team', 'team', 'team'],
    ['team', 'client', 'client'],
    ['team', 'public', 'team'],
    ['client', 'client', 'client'],
    ['client', 'team', 'none'],
    ['client', 'public', 'none'],
  ] as const)('runner %s, app %s: %s', (runner, app, want) => {
    expect(appToolLevel(runner, app)).toBe(want);
  });

  it('reads an unknown stored level as admin: the runner keeps its rules, a client gets none', () => {
    expect(appToolLevel('team', 'weird')).toBe('team');
    expect(appToolLevel('client', undefined)).toBe('none');
  });

  // Team apps Phase 3, plan A.4: a member-built app never runs admin rules.
  it('the author ceiling: a member-built app runs at most team rules, an admin run included', () => {
    for (const app of ['admin', 'team', 'public']) {
      expect(appToolLevel('admin', app, 'team'), app).toBe('team');
      expect(appToolLevel('admin', app, 'admin'), app).toBe('admin');
      expect(appToolLevel('team', app, 'team'), app).toBe('team');
    }
    // Lower rules stay as they are.
    expect(appToolLevel('admin', 'client', 'team')).toBe('client');
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

describe('appToolWarnings follows the app level', () => {
  it('warns a client-level app about every tool the client rules refuse', async () => {
    h.app = { audience: 'client', manifest: { toolSlugs: ['page_get', 'contact_list'] } };
    const w = await appToolWarnings('brain', 'app');
    expect(w).toHaveLength(2);
    expect(w[0]).toContain("'page_get'");
    expect(w[1]).toContain("'contact_list'");
    expect(w.join(' ')).toMatch(/admins and members too/);
  });

  it('warns a team or public app about what members are refused', async () => {
    for (const audience of ['team', 'public']) {
      h.app = { audience, manifest: { toolSlugs: ['weather'] } };
      const w = await appToolWarnings('brain', 'app');
      expect(w, audience).toHaveLength(1);
      expect(w[0]).toMatch(/Members running this app/);
    }
  });

  it('says nothing for an admin-level app or a missing one', async () => {
    h.app = { audience: 'admin', manifest: { toolSlugs: ['contact_list'] } };
    expect(await appToolWarnings('brain', 'app')).toEqual([]);
    // A member-built app at admin level still warns: it runs team rules.
    h.app = { audience: 'admin', manifest: { toolSlugs: ['weather'] }, authorLevel: 'team' };
    expect((await appToolWarnings('brain', 'app')).length).toBe(1);
    h.app = { audience: 'admin', manifest: { toolSlugs: ['contact_list'] } };
    expect(await appToolWarnings('brain', 'app')).toEqual([]);
    h.app = null;
    expect(await appToolWarnings('brain', 'app')).toEqual([]);
  });
});
