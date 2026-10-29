/**
 * The queue-time check of what a call names by path (A5 step 6a, carried
 * round-2 LOW-1 of step 5): before a call is queued (turnCallRefusal, whose
 * gate context says `queue`) a create's target folder named by its path
 * (the policy's `createsIn`) must resolve in the queuing scope, or the call
 * is refused in the item check's words and never queued. Since fix round 1
 * (M1) a create that makes its own folders (`makesFolders`) needs only the
 * deepest folder of its path the scope reads. A Recall map named by its slug
 * was asked here too until the pre-check removal: an approved call runs in
 * the scope it was asked in since A5 step 6c, where the database refuses it,
 * so such a call queues now and its approval answers the tool's own "not
 * found".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  scope: { kind: 'assistant', loginId: 'l1', ws: ['w1'], modWs: [] } as Record<
    string,
    unknown
  > | null,
  holdsAdmin: false,
  folders: [] as string[],
  asked: [] as string[][],
}));

vi.mock('@mantle/db/viewer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/db/viewer')>()),
  currentWorkspaceScope: () => h.scope,
}));
vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  return {
    ...real,
    scopeHoldsAdmin: async () => h.holdsAdmin,
    // The folders the scope reads, of those asked.
    foldersReadOf: async (_owner: string, paths: readonly string[]) => {
      h.asked.push([...paths]);
      return new Set(paths.filter((p) => h.folders.includes(p)));
    },
  };
});

import { createFolderRefusal } from './item-write-gate';

beforeEach(() => {
  h.scope = { kind: 'assistant', loginId: 'l1', ws: ['w1'], modWs: [] };
  h.holdsAdmin = false;
  h.folders = ['files.team'];
  h.asked = [];
});

describe("a create's target folder named by its path (createsIn)", () => {
  it('a path the scope does not read is refused, in words that name no folder to find', async () => {
    const refused = await createFolderRefusal('parent_path', { parent_path: 'files.admin' }, 'o');
    expect(refused).toBe(
      'Folder files.admin is not one in your workspaces, so this call is not queued for approval: name one of yours (folder_list / tree_list lists them).',
    );
  });

  it('a path the scope reads is not refused', async () => {
    expect(
      await createFolderRefusal('parent_path', { parent_path: ' files.team ' }, 'o'),
    ).toBeNull();
  });

  it('a create that makes its folders: a new subfolder of a folder the scope reads queues', async () => {
    expect(
      await createFolderRefusal('parent_path', { parent_path: 'files.team.new.deeper' }, 'o', true),
    ).toBeNull();
    // Cut to the handler's depth (three folders below files), every folder
    // of the path asked, the root never.
    expect(h.asked).toEqual([['files.team', 'files.team.new', 'files.team.new.deeper']]);
    h.asked = [];
    await createFolderRefusal('parent_path', { parent_path: 'files.team.a.b.c.d' }, 'o', true);
    expect(h.asked).toEqual([['files.team', 'files.team.a', 'files.team.a.b']]);
  });

  it('a create that makes its folders: no folder of the path the scope reads is refused', async () => {
    expect(
      await createFolderRefusal('parent_path', { parent_path: 'files.admin.sub' }, 'o', true),
    ).toBe(
      'No folder on the path files.admin.sub is one in your workspaces, so this call is not queued for approval: put it in a folder of yours (folder_list / tree_list lists them).',
    );
  });

  it('a create that does not make its folders needs the folder itself', async () => {
    expect(
      await createFolderRefusal('parent_path', { parent_path: 'files.team.new' }, 'o'),
    ).toMatch(/^Folder files\.team\.new is not one in your workspaces/);
  });

  it("a kind's root, a scope that holds Admin, no scope and no path are not asked", async () => {
    expect(await createFolderRefusal('parent_path', { parent_path: 'files' }, 'o')).toBeNull();
    expect(await createFolderRefusal('parent_path', {}, 'o')).toBeNull();
    expect(await createFolderRefusal(undefined, { parent_path: 'files.admin' }, 'o')).toBeNull();
    h.holdsAdmin = true;
    expect(
      await createFolderRefusal('parent_path', { parent_path: 'files.admin' }, 'o', true),
    ).toBeNull();
    h.holdsAdmin = false;
    h.scope = null;
    expect(
      await createFolderRefusal('parent_path', { parent_path: 'files.admin' }, 'o'),
    ).toBeNull();
    expect(h.asked).toEqual([]);
  });
});
