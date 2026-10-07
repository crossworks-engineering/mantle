/**
 * `appLauncher` (./app-folders.ts) without a database: what it does around
 * its two reads. The reads themselves, as the real roles, are proven on
 * Postgres in ./app-folders.viewer.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  level: 'admin' as string,
  space: null as unknown,
  viewers: [] as string[],
  folderReads: 0,
  folderError: null as Error | null,
  rows: [] as Array<{ id: string; path: string; title: string; data: null }>,
}));

vi.mock('@mantle/db', () => ({
  currentViewerLevel: () => h.level,
  currentSpaceScope: () => h.space,
  withViewer: async (level: string, fn: () => Promise<unknown>) => {
    h.viewers.push(level);
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
  listMemberAppsPlaced: async () => ({
    apps: [{ id: 'a1', title: 'Polls' }],
    places: [{ id: 'a1', path: 'apps.tools' }],
  }),
}));
vi.mock('./client-apps', () => ({
  listClientAppsPlaced: async () => ({
    apps: [{ id: 'c1', title: 'Orders' }],
    places: [{ id: 'c1', path: 'apps' }],
  }),
}));

const { appLauncher } = await import('./app-folders');

beforeEach(() => {
  h.level = 'admin';
  h.space = null;
  h.viewers.length = 0;
  h.folderReads = 0;
  h.folderError = null;
  h.rows = [{ id: 'f1', path: 'apps.tools', title: 'Tools', data: null }];
});

describe('appLauncher', () => {
  it('reads the apps as the reader it is given, and the folders from their places', async () => {
    const team = await appLauncher('anchor', 'team');
    expect(h.viewers).toEqual(['team']);
    expect(team.apps.map((a) => a.id)).toEqual(['a1']);
    expect(team.folders).toEqual([
      { id: 'f1', name: 'Tools', icon: null, color: null, parentId: null, appIds: ['a1'] },
    ]);
  });

  it('reads no folder row when every app is at the top level', async () => {
    const client = await appLauncher('anchor', 'client');
    expect(h.viewers).toEqual(['client']);
    expect(client.apps.map((a) => a.id)).toEqual(['c1']);
    expect(client.folders).toEqual([]);
    expect(h.folderReads).toBe(0);
  });

  it('still lists the apps when the folder read fails, with no folders, and logs it', async () => {
    h.folderError = new Error('boom');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const team = await appLauncher('anchor', 'team');
      expect(team.apps.map((a) => a.id)).toEqual(['a1']);
      expect(team.folders).toEqual([]);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('[app-folders]'), 'boom');
    } finally {
      logged.mockRestore();
    }
  });

  it('refuses a viewer scope or a space scope: it scopes its own reads', async () => {
    h.level = 'team';
    await expect(appLauncher('anchor', 'team')).rejects.toThrow(/admin pool/);
    h.level = 'admin';
    h.space = { spaceId: 's' };
    await expect(appLauncher('anchor', 'client')).rejects.toThrow(/admin pool/);
    expect(h.viewers).toEqual([]);
    expect(h.folderReads).toBe(0);
  });
});
