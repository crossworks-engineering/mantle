/**
 * The one app tool level rule (client tier audit 2026-09-30, L1): an app's
 * tools run at the LOWER of the runner's level and the app's level, for the
 * owner, member and client brokers alike, and the author warnings follow the
 * same rule. No database: the refusals pinned here all happen before any
 * lookup (the team and client rules themselves are proven on Postgres in
 * {member,client}-app-tools.viewer.db.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  app: null as null | { audience: string; manifest: { toolSlugs?: string[] } },
}));

vi.mock('./resolve', () => ({
  resolveTool: vi.fn(async (_owner: string, slug: string) =>
    slug === 'missing'
      ? null
      : { slug, enabled: true, requiresConfirm: false, handler: { kind: 'http' } },
  ),
  resolveTools: vi.fn(),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApp: vi.fn(async () => h.app),
}));

import { resolveTool } from './resolve';
import {
  appToolLevel,
  appToolScope,
  appToolVerdict,
  appToolWarnings,
  PUBLIC_APP_NO_TOOLS,
} from './app-tool-level';

beforeEach(() => {
  h.app = null;
  vi.mocked(resolveTool).mockClear();
});

describe('appToolLevel: the lower of the runner and the app', () => {
  it.each([
    ['admin', 'admin', 'admin'],
    ['admin', 'team', 'team'],
    ['admin', 'client', 'client'],
    ['admin', 'public', 'none'],
    ['team', 'team', 'team'],
    ['team', 'client', 'client'],
    ['team', 'public', 'none'],
    ['team', 'admin', 'team'],
    ['client', 'client', 'client'],
    ['client', 'team', 'client'],
    ['client', 'public', 'none'],
  ] as const)('runner %s, app %s: %s', (runner, app, want) => {
    expect(appToolLevel(runner, app)).toBe(want);
  });

  it('reads an unknown stored level as admin (fail closed to the runner)', () => {
    expect(appToolLevel('team', 'weird')).toBe('team');
    expect(appToolLevel('client', undefined)).toBe('client');
  });
});

describe('appToolVerdict', () => {
  it('at client level refuses the brain-wide and team reads before any lookup', async () => {
    for (const slug of ['page_get', 'contact_list', 'table_rows_list', 'search_chunks']) {
      const v = await appToolVerdict('client', 'brain', [slug], slug);
      expect(v, slug).toMatchObject({ ok: false, status: 403 });
      if (!v.ok) expect(v.reason).toMatch(/client apps/);
    }
    expect(resolveTool).not.toHaveBeenCalled();
  });

  it('at none refuses every tool, declared or not', async () => {
    const v = await appToolVerdict('none', 'brain', ['calculate'], 'calculate');
    expect(v).toEqual({ ok: false, status: 403, reason: PUBLIC_APP_NO_TOOLS });
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
    expect(() => appToolScope('none', who)).toThrow(/public level/);
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

  it('warns a public app about every declared tool', async () => {
    h.app = { audience: 'public', manifest: { toolSlugs: ['calculate'] } };
    const w = await appToolWarnings('brain', 'app');
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("'calculate'");
  });

  it('says nothing for an admin-level app or a missing one', async () => {
    h.app = { audience: 'admin', manifest: { toolSlugs: ['contact_list'] } };
    expect(await appToolWarnings('brain', 'app')).toEqual([]);
    h.app = null;
    expect(await appToolWarnings('brain', 'app')).toEqual([]);
  });
});
