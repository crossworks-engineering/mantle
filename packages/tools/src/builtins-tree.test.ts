/**
 * The folder tools for the row-only tree kinds (builtins-tree.ts). The tree
 * module is stubbed (its rules are pinned by tree-kinds.db.test.ts); what is
 * pinned here is the tools' own logic: the owner-only gate, the kind check,
 * how a top-level parent is read, and how refusals come back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/content/tree', () => {
  class TreeError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  class TreeVisibilityError extends Error {
    constructor(readonly diff: { changes: unknown[]; total: number }) {
      super('visibility');
    }
  }
  return {
    TreeError,
    TreeVisibilityError,
    createTreeFolder: vi.fn(),
    deleteTreeFolder: vi.fn(),
    listTreeFolders: vi.fn(),
    moveTreeItems: vi.fn(),
    notifyTreeChanged: vi.fn(),
    updateTreeFolder: vi.fn(),
  };
});

import {
  TreeError,
  TreeVisibilityError,
  createTreeFolder,
  deleteTreeFolder,
  moveTreeItems,
  notifyTreeChanged,
  updateTreeFolder,
} from '@mantle/content/tree';
import { TREE_OPERATOR_TOOLS, TREE_TOOLS } from './builtins-tree';
import type { ToolHandlerContext } from './types';

const tool = (slug: string) =>
  [...TREE_TOOLS, ...TREE_OPERATOR_TOOLS].find((t) => t.slug === slug)!;
const owner: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'owner', via: 'mcp' } };
const member: ToolHandlerContext = {
  ownerId: 'o1',
  surface: { kind: 'team', loginId: 'm1' },
};
const FOLDER = '00000000-0000-4000-8000-000000000001';

type Result = Awaited<ReturnType<ReturnType<typeof tool>['handler']>>;
function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

beforeEach(() => vi.clearAllMocks());

describe('tree folder tools', () => {
  it('refuse a member turn and an unknown kind before touching anything', async () => {
    expect(errorOf(await tool('tree_folders').handler({ kind: 'notes' }, member))).toMatch(
      /owner/i,
    );
    expect(
      errorOf(await tool('tree_folder_create').handler({ kind: 'files', name: 'x' }, owner)),
    ).toMatch(/kind must be one of notes/);
    expect(createTreeFolder).not.toHaveBeenCalled();
  });

  it('read a missing or null parent as the top level', async () => {
    vi.mocked(createTreeFolder).mockResolvedValue({ id: 'f', path: 'notes.a' } as never);
    const res = await tool('tree_folder_create').handler({ kind: 'notes', name: 'A' }, owner);
    expect(res.ok).toBe(true);
    expect(createTreeFolder).toHaveBeenCalledWith('o1', 'notes', { parentId: null, name: 'A' });
    expect(notifyTreeChanged).toHaveBeenCalledWith('o1', 'notes');
  });

  it('passes an icon and a colour into the create, and refuses a bad one first', async () => {
    vi.mocked(createTreeFolder).mockResolvedValue({ id: 'f', path: 'notes.a' } as never);
    const res = await tool('tree_folder_create').handler(
      { kind: 'notes', name: 'A', icon: 'lucide:briefcase', color: 'cyan' },
      owner,
    );
    expect(res.ok).toBe(true);
    expect(createTreeFolder).toHaveBeenCalledWith('o1', 'notes', {
      parentId: null,
      name: 'A',
      icon: 'lucide:briefcase',
      color: 'cyan',
    });
    vi.clearAllMocks();
    expect(
      errorOf(
        await tool('tree_folder_create').handler(
          { kind: 'notes', name: 'A', color: 'magenta' },
          owner,
        ),
      ),
    ).toMatch(/color must be one of/);
    expect(
      errorOf(
        await tool('tree_folder_create').handler(
          { kind: 'notes', name: 'A', icon: 'briefcase' },
          owner,
        ),
      ),
    ).toMatch(/emoji or lucide/);
    expect(createTreeFolder).not.toHaveBeenCalled();
  });

  it('moves a folder only when asked, and to the top level on null', async () => {
    expect(
      errorOf(
        await tool('tree_folder_update').handler({ kind: 'tasks', folder_id: FOLDER }, owner),
      ),
    ).toMatch(/name.*parent_id/);
    vi.mocked(updateTreeFolder).mockResolvedValue({ id: FOLDER, path: 'tasks.x' } as never);
    await tool('tree_folder_update').handler(
      { kind: 'tasks', folder_id: FOLDER, parent_id: null },
      owner,
    );
    expect(updateTreeFolder).toHaveBeenCalledWith(
      'o1',
      'tasks',
      FOLDER,
      { parentId: null },
      { confirm: false },
    );
  });

  it('names what a share change would do, and waits for confirm', async () => {
    vi.mocked(moveTreeItems).mockRejectedValueOnce(
      new TreeVisibilityError({
        changes: [{ id: 'n1', title: 'Plan', from: 'admin', to: 'team' }],
        total: 1,
      }),
    );
    const err = errorOf(
      await tool('tree_item_move').handler(
        { kind: 'notes', item_ids: ['n1'], folder_id: FOLDER },
        owner,
      ),
    );
    expect(err).toMatch(/'Plan' admin → team/);
    expect(err).toMatch(/confirm: true only once they agree/);
    await tool('tree_item_move').handler(
      { kind: 'notes', item_ids: ['n1'], folder_id: FOLDER, confirm: true },
      owner,
    );
    expect(moveTreeItems).toHaveBeenLastCalledWith('o1', 'notes', ['n1'], FOLDER, {
      confirm: true,
    });
  });

  it('says what to do when no item moved', async () => {
    vi.mocked(moveTreeItems).mockResolvedValue({
      moved: 0,
      failed: [{ id: 'x', error: 'not found' }],
    });
    const err = errorOf(
      await tool('tree_item_move').handler(
        { kind: 'events', item_ids: ['x'], folder_id: null },
        owner,
      ),
    );
    expect(err).toMatch(/each id must be a event/);
    expect(notifyTreeChanged).not.toHaveBeenCalled();
  });
});

describe('tree_folder_delete', () => {
  it('lifts a folder, and passes a refusal on as the error', async () => {
    vi.mocked(deleteTreeFolder).mockResolvedValueOnce(undefined);
    const ok = await tool('tree_folder_delete').handler(
      { kind: 'notes', folder_id: FOLDER },
      owner,
    );
    expect(ok.ok).toBe(true);
    expect(deleteTreeFolder).toHaveBeenCalledWith('o1', 'notes', FOLDER, { confirm: false });
    vi.mocked(deleteTreeFolder).mockRejectedValueOnce(
      new TreeError('invalid', 'this folder is made by Mantle; it cannot be deleted'),
    );
    expect(
      errorOf(
        await tool('tree_folder_delete').handler({ kind: 'notes', folder_id: FOLDER }, owner),
      ),
    ).toMatch(/made by Mantle/);
  });
});
