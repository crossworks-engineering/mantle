/**
 * The app history tools (apps snapshots, Phase 2): app_snapshot_create,
 * app_snapshot_list, app_snapshot_restore, app_snapshot_delete.
 *
 * The store (app-snapshots.ts) is stubbed and pinned on Postgres in
 * app-snapshots.db.test.ts. What the tools own: the owner-only refusal, the
 * argument checks, the confirmation gates on restore and delete, the actor a
 * row names, and the errors that teach the next move (a version holds no
 * data, a draft in the way, a budget past its cap).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/content/app-snapshots', () => {
  class AppSnapshotBudgetError extends Error {}
  class AppSnapshotRefusedError extends Error {}
  return {
    AppSnapshotBudgetError,
    AppSnapshotRefusedError,
    createAppSnapshot: vi.fn(),
    listAppSnapshots: vi.fn(),
    restoreAppSnapshot: vi.fn(),
    deleteAppSnapshot: vi.fn(),
  };
});

vi.mock('@mantle/content/app-trash', () => {
  class AppTrashRefusedError extends Error {}
  return {
    AppTrashRefusedError,
    listDeletedApps: vi.fn(),
    restoreDeletedApp: vi.fn(),
  };
});

vi.mock('@mantle/content/app-package', () => ({ duplicateApp: vi.fn() }));
vi.mock('@mantle/content', async (orig) => ({
  ...(await orig<typeof import('@mantle/content')>()),
  listAppAccess: vi.fn(),
}));

import { duplicateApp } from '@mantle/content/app-package';
import { AppDbMissingError } from '@mantle/content/app-broker';
import {
  AppTrashRefusedError,
  listDeletedApps,
  restoreDeletedApp,
} from '@mantle/content/app-trash';
import {
  AppSnapshotRefusedError,
  createAppSnapshot,
  deleteAppSnapshot,
  listAppSnapshots,
  restoreAppSnapshot,
} from '@mantle/content/app-snapshots';
import { AppRestoreDraftError, listAppAccess } from '@mantle/content';
import { APP_TOOLS } from './builtins-apps';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const tool = (slug: string) => APP_TOOLS.find((t) => t.slug === slug)!;
const create = tool('app_snapshot_create');
const list = tool('app_snapshot_list');
const restore = tool('app_snapshot_restore');
const del = tool('app_snapshot_delete');

const chat: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'web' } };
const mcp: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'owner', via: 'mcp' } };
const member: ToolHandlerContext = {
  ownerId: 'o1',
  surface: { kind: 'team', loginId: 'm1' },
};
const APP = '11111111-2222-4333-8444-555555555555';
const SNAP = '99999999-2222-4333-8444-555555555555';

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;
const errorOf = (res: Result) => {
  if (res.ok) throw new Error(`expected a failure, got ${JSON.stringify(res.output)}`);
  return res.error;
};
const outputOf = (res: Result) => {
  if (!res.ok) throw new Error(`expected success, got ${res.error}`);
  return res.output as Record<string, unknown>;
};

beforeEach(() => vi.clearAllMocks());

describe('the history tools: who may run them', () => {
  it('restore and delete are confirm-gated; all four are owner-only', () => {
    expect(restore.requiresConfirm).toBe(true);
    expect(del.requiresConfirm).toBe(true);
    for (const t of [create, list, restore, del]) expect(t.ownerOnly, t.slug).toBe(true);
    expect(list.readOnly).toBe(true);
  });

  it('a member surface is refused before the store is touched', async () => {
    expect(
      errorOf(await restore.handler({ id: APP, snapshot_id: SNAP, mode: 'data' }, member)),
    ).toMatch(/owner/);
    expect(restoreAppSnapshot).not.toHaveBeenCalled();
  });
});

describe('app_snapshot_create', () => {
  it('names the MCP client or the agent as the actor', async () => {
    vi.mocked(createAppSnapshot).mockResolvedValue({ seq: 3, hasData: true } as never);
    await create.handler({ id: APP, note: 'before import' }, mcp);
    expect(createAppSnapshot).toHaveBeenLastCalledWith('o1', APP, {
      note: 'before import',
      actor: 'mcp',
    });
    await create.handler({ id: APP }, chat);
    expect(createAppSnapshot).toHaveBeenLastCalledWith('o1', APP, { note: null, actor: 'agent' });
  });

  it('reports a missing app', async () => {
    vi.mocked(createAppSnapshot).mockResolvedValue(null);
    expect(errorOf(await create.handler({ id: APP }, chat))).toMatch(/not found/);
  });
});

describe('app_snapshot_list', () => {
  it('passes the limit through', async () => {
    vi.mocked(listAppSnapshots).mockResolvedValue([]);
    expect(outputOf(await list.handler({ id: APP, limit: 7 }, chat))).toEqual({
      id: APP,
      entries: [],
    });
    expect(listAppSnapshots).toHaveBeenCalledWith('o1', APP, { limit: 7 });
  });
});

describe('app_snapshot_restore', () => {
  it('checks its arguments before the store', async () => {
    expect(errorOf(await restore.handler({ id: APP, mode: 'data' }, chat))).toMatch(
      /snapshot_id is required/,
    );
    expect(
      errorOf(await restore.handler({ id: APP, snapshot_id: SNAP, mode: 'all' }, chat)),
    ).toMatch(/mode must be/);
    expect(restoreAppSnapshot).not.toHaveBeenCalled();
  });

  it('restores, and hands back the undo snapshot and where the code went', async () => {
    vi.mocked(restoreAppSnapshot).mockResolvedValue({
      mode: 'code',
      restored: { seq: 4 },
      undo: { id: 'undo-1' },
      code: 'draft',
    } as never);
    const out = outputOf(
      await restore.handler(
        { id: APP, snapshot_id: SNAP, mode: 'code', discard_draft: true },
        chat,
      ),
    );
    expect(restoreAppSnapshot).toHaveBeenCalledWith('o1', APP, SNAP, {
      mode: 'code',
      discardDraft: true,
      actor: 'agent',
    });
    expect(out).toMatchObject({ restored: 4, code: 'draft', undo_snapshot_id: 'undo-1' });
    expect(out.hint).toMatch(/app_publish/);
  });

  it('passes the refusals through as they are worded', async () => {
    vi.mocked(restoreAppSnapshot).mockRejectedValueOnce(
      new AppSnapshotRefusedError('v2 holds no data'),
    );
    expect(errorOf(await restore.handler({ id: APP, snapshot_id: SNAP, mode: 'data' }, chat))).toBe(
      'v2 holds no data',
    );
    vi.mocked(restoreAppSnapshot).mockRejectedValueOnce(new AppRestoreDraftError());
    expect(
      errorOf(await restore.handler({ id: APP, snapshot_id: SNAP, mode: 'code' }, chat)),
    ).toMatch(/discard_draft/);
    vi.mocked(restoreAppSnapshot).mockResolvedValueOnce(null);
    expect(
      errorOf(await restore.handler({ id: APP, snapshot_id: SNAP, mode: 'code' }, chat)),
    ).toMatch(/app_snapshot_list/);
  });
});

describe('app_snapshot_delete', () => {
  it('deletes a snapshot; a version is refused with the reason', async () => {
    vi.mocked(deleteAppSnapshot).mockResolvedValueOnce(true);
    expect(outputOf(await del.handler({ id: APP, snapshot_id: SNAP }, chat))).toEqual({
      id: APP,
      deleted: SNAP,
    });
    vi.mocked(deleteAppSnapshot).mockRejectedValueOnce(
      new AppSnapshotRefusedError('v1 is a version and stays'),
    );
    expect(errorOf(await del.handler({ id: APP, snapshot_id: SNAP }, chat))).toMatch(/stays/);
    vi.mocked(deleteAppSnapshot).mockResolvedValueOnce(false);
    expect(errorOf(await del.handler({ id: APP, snapshot_id: SNAP }, chat))).toMatch(
      /app_snapshot_list/,
    );
  });
});

describe('the trash tools (Phase 3)', () => {
  const deletedList = tool('app_deleted_list');
  const undelete = tool('app_undelete');

  it('lists the deleted apps', async () => {
    vi.mocked(listDeletedApps).mockResolvedValue([{ id: APP, title: 'Prices' }] as never);
    expect(outputOf(await deletedList.handler({}, chat))).toEqual({
      apps: [{ id: APP, title: 'Prices' }],
    });
  });

  it('brings one back, and says why not when it cannot', async () => {
    vi.mocked(restoreDeletedApp).mockResolvedValueOnce({ id: APP, title: 'Prices' });
    expect(outputOf(await undelete.handler({ id: APP }, mcp))).toMatchObject({
      id: APP,
      name: 'Prices',
    });
    expect(restoreDeletedApp).toHaveBeenCalledWith('o1', APP, { actor: 'mcp' });
    vi.mocked(restoreDeletedApp).mockResolvedValueOnce(null);
    expect(errorOf(await undelete.handler({ id: APP }, chat))).toMatch(/app_deleted_list/);
    vi.mocked(restoreDeletedApp).mockRejectedValueOnce(new AppTrashRefusedError('not deleted'));
    expect(errorOf(await undelete.handler({ id: APP }, chat))).toBe('not deleted');
    expect(errorOf(await undelete.handler({ id: APP }, member))).toMatch(/owner/);
  });
});

describe('the duplicate tool (Phase 3)', () => {
  const duplicate = tool('app_duplicate');

  it('copies with the data by default, names the copy when asked, and is owner-only', async () => {
    vi.mocked(duplicateApp).mockResolvedValueOnce({
      id: SNAP,
      title: 'Prices (copy)',
      hasData: true,
    });
    expect(outputOf(await duplicate.handler({ id: APP }, mcp))).toMatchObject({
      id: SNAP,
      name: 'Prices (copy)',
      has_data: true,
    });
    expect(duplicateApp).toHaveBeenCalledWith('o1', APP, { withData: true, actor: 'mcp' });
    vi.mocked(duplicateApp).mockResolvedValueOnce({ id: SNAP, title: 'Try', hasData: false });
    await duplicate.handler({ id: APP, name: 'Try', with_data: false }, chat);
    expect(duplicateApp).toHaveBeenLastCalledWith('o1', APP, {
      title: 'Try',
      withData: false,
      actor: 'agent',
    });
    expect(duplicate.ownerOnly).toBe(true);
    expect(errorOf(await duplicate.handler({ id: APP }, member))).toMatch(/owner/);
  });

  it('says how to copy an app whose database file is lost', async () => {
    vi.mocked(duplicateApp).mockRejectedValueOnce(new AppDbMissingError(APP));
    expect(errorOf(await duplicate.handler({ id: APP }, chat))).toMatch(/with_data false/);
    vi.mocked(duplicateApp).mockResolvedValueOnce(null);
    expect(errorOf(await duplicate.handler({ id: APP }, chat))).toMatch(/not found/);
  });
});

describe('the error log tool (Phase 3, G4)', () => {
  const errors = tool('app_errors');

  it('lists the error rows, newest first, with who ran the app', async () => {
    vi.mocked(listAppAccess).mockResolvedValueOnce([
      {
        id: 'r1',
        contactId: null,
        contactName: 'Ann',
        actorId: 'm1',
        kind: 'error',
        detail: { source: 'db', via: 'member', message: 'no such table: itms', sql: 'SELECT 1' },
        createdAt: '2026-10-02T10:00:00.000Z',
      },
    ]);
    expect(outputOf(await errors.handler({ id: APP, since_hours: 24 }, chat))).toEqual({
      id: APP,
      count: 1,
      errors: [
        {
          at: '2026-10-02T10:00:00.000Z',
          source: 'db',
          via: 'member',
          message: 'no such table: itms',
          sql: 'SELECT 1',
          who: 'Ann',
        },
      ],
    });
    const [, , limit, opts] = vi.mocked(listAppAccess).mock.calls[0]!;
    expect(limit).toBe(50);
    expect(opts).toMatchObject({ kind: 'error', since: expect.any(Date) });
    expect(errors.readOnly).toBe(true);
    expect(errorOf(await errors.handler({ id: APP }, member))).toMatch(/owner/);
  });
});
