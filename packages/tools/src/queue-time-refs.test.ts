/**
 * The queue-time item check reads what a call names by slug or by path (A5
 * step 6a, carried round-2 LOW-1 of step 5). The approved call runs later in
 * the approver's scope, so before a call is queued (turnCallRefusal, whose
 * gate context says `queue`) a Recall map named by its slug and a create's
 * target folder named by its path (the policy's `createsIn`) must resolve in
 * the queuing scope, or the call is refused in the item check's words and
 * never queued. A call that runs (no `queue`) answers as before: the
 * tool's own "not found".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  scope: { kind: 'assistant', loginId: 'l1', ws: ['w1'], modWs: [] } as Record<
    string,
    unknown
  > | null,
  holdsAdmin: false,
  folders: [] as string[],
  maps: { known: 'map-node' } as Record<string, string>,
  checked: [] as { ids: readonly string[]; need: string }[],
}));

vi.mock('@mantle/db/viewer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/db/viewer')>()),
  currentWorkspaceScope: () => h.scope,
}));
vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  const dialect = new (await import('drizzle-orm/pg-core')).PgDialect();
  let path = '';
  const chain = {
    from: () => chain,
    where: (cond: SQL) => {
      // The path the query asks for: its last parameter.
      const params = dialect.sqlToQuery(cond).params;
      path = String(params[params.length - 1] ?? '');
      return chain;
    },
    limit: async () => (h.folders.includes(path) ? [{ id: 'f1' }] : []),
  };
  return {
    ...real,
    currentGateScope: () => null,
    scopeHoldsAdmin: async () => h.holdsAdmin,
    itemWriteRefusalOf: async (ids: readonly string[], need: string) => {
      h.checked.push({ ids, need });
      return null;
    },
    db: { select: () => chain },
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
});

describe('a Recall map named by its slug (recallMap)', () => {
  it('queued: a slug that names no map the scope reads is refused, not-in-scope', async () => {
    const refused = await toolItemWriteRefusalOf(recallMap('edit'), { map: 'secret' }, 'o', {
      queue: true,
    });
    expect(refused?.message).toMatch(/^Recall map 'secret' is not in your workspaces/);
    expect(refused?.detail).toBe('no_read');
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
  it('a path the scope does not read is refused, not-in-scope', async () => {
    const refused = await createFolderRefusal('parent_path', { parent_path: 'files.admin' }, 'o');
    expect(refused).toMatch(/^Folder files\.admin is not in your workspaces/);
  });

  it('a path the scope reads is not refused', async () => {
    expect(
      await createFolderRefusal('parent_path', { parent_path: ' files.team ' }, 'o'),
    ).toBeNull();
  });

  it("a kind's root, a scope that holds Admin, no scope and no path are not asked", async () => {
    expect(await createFolderRefusal('parent_path', { parent_path: 'files' }, 'o')).toBeNull();
    expect(await createFolderRefusal('parent_path', {}, 'o')).toBeNull();
    expect(await createFolderRefusal(undefined, { parent_path: 'files.admin' }, 'o')).toBeNull();
    h.holdsAdmin = true;
    expect(
      await createFolderRefusal('parent_path', { parent_path: 'files.admin' }, 'o'),
    ).toBeNull();
    h.holdsAdmin = false;
    h.scope = null;
    expect(
      await createFolderRefusal('parent_path', { parent_path: 'files.admin' }, 'o'),
    ).toBeNull();
  });
});
