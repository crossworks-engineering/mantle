/**
 * `appLauncher` (./app-folders.ts) without a database: what it does around
 * its two reads. The reads themselves, in the real scopes, are proven on
 * Postgres in ./app-folders.viewer.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** Whether the caller is system work (else inside a workspace scope). */
  system: true,
  space: null as unknown,
  logins: [] as unknown[],
  folderReads: 0,
  folderError: null as Error | null,
  topLevel: false,
  rows: [] as Array<{ id: string; path: string; title: string; data: null }>,
}));

vi.mock('@mantle/db', () => ({
  isSystemScope: () => h.system,
  currentSpaceScope: () => h.space,
  withViewer: async (actsFor: unknown, fn: () => Promise<unknown>) => {
    h.logins.push(actsFor);
    return fn();
  },
  db: {
    execute: async () => {
      h.folderReads += 1;
      if (h.folderError) throw h.folderError;
      return h.rows;
    },
  },
}));
vi.mock('./member-apps', () => ({
  listMemberAppsPlaced: async () =>
    h.topLevel
      ? { apps: [{ id: 'c1', title: 'Orders' }], places: [{ id: 'c1', path: 'apps' }] }
      : { apps: [{ id: 'a1', title: 'Polls' }], places: [{ id: 'a1', path: 'apps.tools' }] },
}));

const { appLauncher } = await import('./app-folders');

const LOGIN = '00000000-0000-4000-8000-0000000000a1';

beforeEach(() => {
  h.system = true;
  h.space = null;
  h.logins.length = 0;
  h.folderReads = 0;
  h.folderError = null;
  h.topLevel = false;
  h.rows = [{ id: 'f1', path: 'apps.tools', title: 'Tools', data: null }];
});

describe('appLauncher', () => {
  it('reads the apps as the reader it is given, and the folders from their places', async () => {
    const team = await appLauncher('anchor', 'team', LOGIN);
    expect(h.logins).toEqual([{ login: LOGIN }]);
    expect(team.apps.map((a) => a.id)).toEqual(['a1']);
    expect(team.folders).toEqual([
      { id: 'f1', name: 'Tools', icon: null, color: null, parentId: null, appIds: ['a1'] },
    ]);
  });

  it('reads no folder row when every app is at the top level', async () => {
    h.topLevel = true;
    const top = await appLauncher('anchor', 'team', LOGIN);
    expect(h.logins).toEqual([{ login: LOGIN }]);
    expect(top.apps.map((a) => a.id)).toEqual(['c1']);
    expect(top.folders).toEqual([]);
    expect(h.folderReads).toBe(0);
  });

  it('still lists the apps when the folder read fails, with no folders, and logs it', async () => {
    h.folderError = new Error('boom');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const team = await appLauncher('anchor', 'team', LOGIN);
      expect(team.apps.map((a) => a.id)).toEqual(['a1']);
      expect(team.folders).toEqual([]);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('[app-folders]'), 'boom');
    } finally {
      logged.mockRestore();
    }
  });

  it('refuses a viewer scope or a space scope: it scopes its own reads', async () => {
    h.system = false;
    await expect(appLauncher('anchor', 'team', LOGIN)).rejects.toThrow(/admin pool/);
    h.system = true;
    h.space = { spaceId: 's' };
    await expect(appLauncher('anchor', 'team', LOGIN)).rejects.toThrow(/admin pool/);
    expect(h.logins).toEqual([]);
    expect(h.folderReads).toBe(0);
  });
});
