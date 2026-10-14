/**
 * The queue-time item check reads what a call names by slug or by path (A5
 * step 6a, carried round-2 LOW-1 of step 5). The approved call runs later in
 * the approver's scope, so before a call is queued (turnCallRefusal, whose
 * gate context says `queue`) a Recall map named by its slug and a create's
 * target folder named by its path (the policy's `createsIn`) must resolve in
 * the queuing scope, or the call is refused in the item check's words and
 * never queued. Since fix round 1 (M1) a create that makes its own folders
 * (`makesFolders`) needs only the deepest folder of its path the scope
 * reads, and a scope that holds Admin is not asked for a map. A call that
 * runs (no `queue`) answers as before: the tool's own "not found".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  scope: { kind: 'assistant', loginId: 'l1', ws: ['w1'], modWs: [] } as Record<
    string,
    unknown
  > | null,
  holdsAdmin: false,
  folders: [] as string[],
  maps: { known: 'map-node' } as Record<string, string>,
  checked: [] as { ids: readonly string[]; need: string }[],
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
    currentGateScope: () => null,
    scopeHoldsAdmin: async () => h.holdsAdmin,
    itemWriteRefusalOf: async (ids: readonly string[], need: string) => {
      h.checked.push({ ids, need });
      return null;
    },
    // The folders the scope reads, of those asked.
    foldersReadOf: async (_owner: string, paths: readonly string[]) => {
      h.asked.push([...paths]);
      return new Set(paths.filter((p) => h.folders.includes(p)));
    },
  };
});
vi.mock('./builtins-recall-write', () => ({
  mapRef: async (_owner: string, ref: string) =>
    h.maps[ref] ? { id: h.maps[ref], version: 1, slug: ref } : null,
}));

import { createFolderRefusal, recallMap, toolItemWriteRefusalOf } from './item-write-gate';

beforeEach(() => {
  h.scope = { kind: 'assistant', loginId: 'l1', ws: ['w1'], modWs: [] };
  h.holdsAdmin = false;
  h.folders = ['files.team'];
  h.checked = [];
  h.asked = [];
});

describe('a Recall map named by its slug (recallMap)', () => {
  it('queued: a slug that names no map the scope reads is refused, not-in-scope', async () => {
    const refused = await toolItemWriteRefusalOf(recallMap('edit'), { map: 'secret' }, 'o', {
      queue: true,
    });
    expect(refused?.message).toBe(
      "Recall map 'secret' is not one in your workspaces, so this call is not queued for approval: name one of yours (recall_index lists them).",
    );
    expect(refused?.detail).toBe('no_read');
  });

  it('queued in a scope that holds Admin: a map not found yet is left to dispatch (a create queued before it makes it)', async () => {
    h.holdsAdmin = true;
    expect(
      await toolItemWriteRefusalOf(recallMap('edit'), { map: 'new-map' }, 'o', { queue: true }),
    ).toBeNull();
  });

  it('run: the same call is left to the tool (its own not found), as before', async () => {
    expect(await toolItemWriteRefusalOf(recallMap('edit'), { map: 'secret' }, 'o')).toBeNull();
    expect(await recallMap('edit')({ map: 'secret' }, 'o')).toEqual([]);
  });

  it('a map the scope reads is checked by its item, queued or not', async () => {
    for (const ctx of [{ queue: true }, {}]) {
      h.checked = [];
      expect(await toolItemWriteRefusalOf(recallMap('manage'), { map: 'known' }, 'o', ctx)).toBe(
        null,
      );
      expect(h.checked).toEqual([{ ids: ['map-node'], need: 'manage' }]);
    }
  });

  it('no map named: nothing to check', async () => {
    expect(await toolItemWriteRefusalOf(recallMap('edit'), {}, 'o', { queue: true })).toBeNull();
  });
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
