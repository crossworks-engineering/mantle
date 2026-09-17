/**
 * Behavioural tests for the folder_* write tools: folder_rename,
 * folder_describe, folder_set_indexing, folder_move, folder_copy, and the
 * operator-only folder_create.
 *
 * What is worth pinning, and why:
 *
 *  - Owner scoping on every store call. A folder tool operates on a whole
 *    subtree, so a missing `ownerId` is not one leaked file but a tree.
 *  - Blank-argument guards fire BEFORE the store is reached. folder_create
 *    in particular calls `ensureFilesRootBranch` (a write) before the create;
 *    the guard must sit in front of both, or a `{}` call still creates the
 *    files root as a side effect of failing.
 *  - The store's refusals (files root, own-subtree move, 200-file copy cap,
 *    name clash) reach the caller verbatim. Those messages carry the fix.
 *  - folder_set_indexing trims the node down to id/path/title in its output.
 *    The full node row carries `data` with every flag on the folder; echoing
 *    it would leak internals into the model's context for no gain.
 *  - folder_create applies the indexing flag AFTER the create, on the id the
 *    create returned, and only when asked. Getting that order wrong means a
 *    flag on a folder that does not exist yet, or a sweep over nothing.
 *
 * The store edges are stubbed; the tools' own branching is real. The arrays
 * differ per slug: rename/describe are in FILE_TOOLS, move/copy/indexing in
 * FILE_MANAGE_TOOLS, create in FILE_OPERATOR_TOOLS.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  return {
    ...actual,
    createFolder: vi.fn(),
    ensureFilesRootBranch: vi.fn(),
    renameFolderById: vi.fn(),
    updateFolderDescription: vi.fn(),
    setIndexingMode: vi.fn(),
    moveFolderById: vi.fn(),
    copyFolderById: vi.fn(),
  };
});

import {
  copyFolderById,
  createFolder,
  ensureFilesRootBranch,
  moveFolderById,
  renameFolderById,
  setIndexingMode,
  updateFolderDescription,
} from '@mantle/files';
import { FILE_MANAGE_TOOLS, FILE_OPERATOR_TOOLS, FILE_TOOLS } from './builtins-files';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

function pick(arr: readonly BuiltinToolDef[], slug: string): BuiltinToolDef {
  const def = arr.find((t) => t.slug === slug);
  if (!def) throw new Error(`no tool '${slug}' in the given array`);
  return def;
}

const folderCreate = pick(FILE_OPERATOR_TOOLS, 'folder_create');
const folderRename = pick(FILE_TOOLS, 'folder_rename');
const folderDescribe = pick(FILE_TOOLS, 'folder_describe');
const folderSetIndexing = pick(FILE_MANAGE_TOOLS, 'folder_set_indexing');
const folderMove = pick(FILE_MANAGE_TOOLS, 'folder_move');
const folderCopy = pick(FILE_MANAGE_TOOLS, 'folder_copy');

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const FOLDER_ID = '99999999-2222-4333-8444-555555555555';

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): unknown {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output;
}

/** A FolderRow as the store returns it. */
const folder = {
  id: FOLDER_ID,
  path: 'files.work.reports',
  slug: 'reports',
  title: 'reports',
  description: 'Quarterly reports',
};

/** The raw node setIndexingMode hands back, with the internals the tool
 *  should NOT echo. */
const node = {
  id: FOLDER_ID,
  path: 'files.work.reports',
  title: 'reports',
  type: 'branch',
  ownerId: 'o1',
  data: { indexing: 'metadata', secretFlag: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createFolder).mockResolvedValue(folder as never);
  vi.mocked(ensureFilesRootBranch).mockResolvedValue({ id: 'root' } as never);
  vi.mocked(renameFolderById).mockResolvedValue(folder as never);
  vi.mocked(updateFolderDescription).mockResolvedValue(folder as never);
  vi.mocked(setIndexingMode).mockResolvedValue({ node, requeued: 0 } as never);
  vi.mocked(moveFolderById).mockResolvedValue({ folder, requeued: 0 } as never);
  vi.mocked(copyFolderById).mockResolvedValue({
    folder,
    copiedFiles: 3,
    copiedFolders: 1,
  } as never);
});

describe('folder_create (operator surface)', () => {
  it('refuses a blank parent_path or slug WITHOUT any write, not even the root ensure', async () => {
    expect(errorOf(await folderCreate.handler({ parent_path: '', slug: 'x' }, ctx))).toMatch(
      /parent_path \+ slug required/,
    );
    expect(errorOf(await folderCreate.handler({ parent_path: 'files', slug: '' }, ctx))).toMatch(
      /parent_path \+ slug required/,
    );
    expect(ensureFilesRootBranch).not.toHaveBeenCalled();
    expect(createFolder).not.toHaveBeenCalled();
  });

  it('refuses an indexing value outside full/metadata before any write', async () => {
    const res = await folderCreate.handler(
      { parent_path: 'files', slug: 'gallery', indexing: 'inherit' },
      ctx,
    );
    expect(errorOf(res)).toMatch(/indexing must be 'full' or 'metadata'/);
    expect(ensureFilesRootBranch).not.toHaveBeenCalled();
    expect(createFolder).not.toHaveBeenCalled();
  });

  it('ensures the owner’s files root, then creates under the owner', async () => {
    const res = await folderCreate.handler(
      { parent_path: 'files.work', slug: 'reports', description: 'Quarterly reports' },
      ctx,
    );
    expect(ensureFilesRootBranch).toHaveBeenCalledWith('o1');
    expect(createFolder).toHaveBeenCalledWith({
      ownerId: 'o1',
      parentPath: 'files.work',
      slug: 'reports',
      description: 'Quarterly reports',
    });
    // No indexing asked for: no flag write, and the row goes back as-is.
    expect(setIndexingMode).not.toHaveBeenCalled();
    expect(outputOf(res)).toBe(folder);
  });

  it('collapses an empty description to absent rather than writing ""', async () => {
    await folderCreate.handler(
      { parent_path: 'files.work', slug: 'reports', description: '' },
      ctx,
    );
    expect(createFolder).toHaveBeenCalledWith(expect.objectContaining({ description: undefined }));
  });

  it("applies indexing: 'metadata' on the id the create returned, after the create", async () => {
    const res = await folderCreate.handler(
      { parent_path: 'files', slug: 'gallery', indexing: 'metadata' },
      ctx,
    );
    expect(setIndexingMode).toHaveBeenCalledWith({
      ownerId: 'o1',
      nodeId: FOLDER_ID,
      mode: 'metadata',
    });
    expect(vi.mocked(createFolder).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(setIndexingMode).mock.invocationCallOrder[0]!,
    );
    expect(outputOf(res)).toEqual({ ...folder, indexing: 'metadata' });
  });

  it('prefixes a store refusal (bad slug, parent outside files) with the tool name', async () => {
    vi.mocked(createFolder).mockRejectedValue(
      new Error("createFolder: parent 'notes' is outside the files root"),
    );
    const res = await folderCreate.handler({ parent_path: 'notes', slug: 'x' }, ctx);
    expect(errorOf(res)).toMatch(/^folder_create failed: .*outside the files root/);
    expect(setIndexingMode).not.toHaveBeenCalled();
  });
});

describe('folder_rename', () => {
  it('refuses a blank folder_id or new_name WITHOUT calling the store', async () => {
    expect(errorOf(await folderRename.handler({ folder_id: '', new_name: 'x' }, ctx))).toMatch(
      /folder_id \+ new_name required/,
    );
    expect(
      errorOf(await folderRename.handler({ folder_id: FOLDER_ID, new_name: '' }, ctx)),
    ).toMatch(/folder_id \+ new_name required/);
    expect(renameFolderById).not.toHaveBeenCalled();
  });

  it('renames under the owner, passing the display name for the store to slugify', async () => {
    const setOutput = vi.fn();
    const stepCtx: ToolHandlerContext = {
      ownerId: 'o1',
      step: { setOutput, setMeta: vi.fn(), addTokens: vi.fn(), addCost: vi.fn() },
    };
    const res = await folderRename.handler(
      { folder_id: FOLDER_ID, new_name: 'Lister Contracts' },
      stepCtx,
    );
    // Slugifying is the store's job (one code path with createFolder); the
    // tool must hand over the raw name, not pre-mangle it.
    expect(renameFolderById).toHaveBeenCalledWith({
      ownerId: 'o1',
      folderId: FOLDER_ID,
      newSlug: 'Lister Contracts',
    });
    expect(outputOf(res)).toBe(folder);
    expect(setOutput).toHaveBeenCalledWith({ folderId: FOLDER_ID, path: folder.path });
  });

  it('turns a null from the store into a not-found that names the lookup tools', async () => {
    vi.mocked(renameFolderById).mockResolvedValue(null);
    const err = errorOf(await folderRename.handler({ folder_id: FOLDER_ID, new_name: 'x' }, ctx));
    expect(err).toMatch(/folder not found/);
    expect(err).toMatch(/folder_list/);
  });

  it('passes the files-root refusal through verbatim', async () => {
    vi.mocked(renameFolderById).mockRejectedValue(
      new Error('renameFolderById: cannot rename the files root'),
    );
    expect(
      errorOf(await folderRename.handler({ folder_id: FOLDER_ID, new_name: 'x' }, ctx)),
    ).toMatch(/cannot rename the files root/);
  });
});

describe('folder_describe', () => {
  it('refuses a blank folder_id WITHOUT calling the store', async () => {
    expect(errorOf(await folderDescribe.handler({ folder_id: '', description: 'x' }, ctx))).toMatch(
      /folder_id required/,
    );
    expect(updateFolderDescription).not.toHaveBeenCalled();
  });

  it('replaces the description under the owner', async () => {
    const res = await folderDescribe.handler(
      { folder_id: FOLDER_ID, description: 'Signed contracts' },
      ctx,
    );
    expect(updateFolderDescription).toHaveBeenCalledWith({
      ownerId: 'o1',
      folderId: FOLDER_ID,
      description: 'Signed contracts',
    });
    expect(outputOf(res)).toBe(folder);
  });

  it('lets an empty description through: it is a clear, not a missing argument', async () => {
    // Only folder_id is guarded. "Replaces any existing description" has to
    // include replacing it with nothing, or there is no way to clear one.
    await folderDescribe.handler({ folder_id: FOLDER_ID, description: '' }, ctx);
    expect(updateFolderDescription).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'o1', description: '' }),
    );
  });

  it('turns a null from the store into a not-found that names the lookup tools', async () => {
    vi.mocked(updateFolderDescription).mockResolvedValue(null);
    const err = errorOf(
      await folderDescribe.handler({ folder_id: FOLDER_ID, description: 'x' }, ctx),
    );
    expect(err).toMatch(/folder not found/);
    expect(err).toMatch(/folder_list/);
  });
});

describe('folder_set_indexing', () => {
  it('refuses a blank folder_id WITHOUT calling the store', async () => {
    expect(
      errorOf(await folderSetIndexing.handler({ folder_id: '', mode: 'metadata' }, ctx)),
    ).toMatch(/folder_id required/);
    expect(setIndexingMode).not.toHaveBeenCalled();
  });

  it('sets the mode under the owner and echoes only id/path/title of the node', async () => {
    vi.mocked(setIndexingMode).mockResolvedValue({ node, requeued: 4 } as never);
    const res = await folderSetIndexing.handler({ folder_id: FOLDER_ID, mode: 'metadata' }, ctx);
    expect(setIndexingMode).toHaveBeenCalledWith({
      ownerId: 'o1',
      nodeId: FOLDER_ID,
      mode: 'metadata',
    });
    const out = outputOf(res) as {
      folder: Record<string, unknown>;
      mode: string;
      requeued: number;
      note: string;
    };
    // The trimmed shape: the raw node's `data` and `ownerId` stay out of the
    // model's context.
    expect(out.folder).toEqual({ id: FOLDER_ID, path: node.path, title: node.title });
    expect(out.mode).toBe('metadata');
    expect(out.requeued).toBe(4);
    expect(out.note).toMatch(/4 file\(s\) queued for re-indexing/);
  });

  it('says no files needed re-indexing when the sweep queued nothing', async () => {
    const out = outputOf(
      await folderSetIndexing.handler({ folder_id: FOLDER_ID, mode: 'inherit' }, ctx),
    ) as { note: string };
    expect(out.note).toMatch(/no files needed re-indexing/);
  });

  it('passes a store refusal through', async () => {
    vi.mocked(setIndexingMode).mockRejectedValue(
      new Error(`setIndexingMode: node ${FOLDER_ID} not found`),
    );
    expect(
      errorOf(await folderSetIndexing.handler({ folder_id: FOLDER_ID, mode: 'full' }, ctx)),
    ).toMatch(/not found/);
  });
});

describe('folder_move', () => {
  it('refuses a blank folder_id or dest_parent_path WITHOUT calling the store', async () => {
    expect(
      errorOf(await folderMove.handler({ folder_id: '', dest_parent_path: 'files.a' }, ctx)),
    ).toMatch(/folder_id and dest_parent_path required/);
    expect(
      errorOf(await folderMove.handler({ folder_id: FOLDER_ID, dest_parent_path: '' }, ctx)),
    ).toMatch(/folder_id and dest_parent_path required/);
    expect(moveFolderById).not.toHaveBeenCalled();
  });

  it('moves under the owner and reports the folder plus the re-index count', async () => {
    const moved = { ...folder, path: 'files.archive.reports' };
    vi.mocked(moveFolderById).mockResolvedValue({ folder: moved, requeued: 2 } as never);
    const res = await folderMove.handler(
      { folder_id: FOLDER_ID, dest_parent_path: 'files.archive' },
      ctx,
    );
    expect(moveFolderById).toHaveBeenCalledWith({
      ownerId: 'o1',
      folderId: FOLDER_ID,
      destParentPath: 'files.archive',
    });
    // The description promises "the result reports how many" were re-indexed.
    expect(outputOf(res)).toEqual({ folder: moved, requeued: 2 });
  });

  it('passes the own-subtree refusal through verbatim', async () => {
    vi.mocked(moveFolderById).mockRejectedValue(
      new Error('moveFolderById: cannot move a folder into its own subtree'),
    );
    const err = errorOf(
      await folderMove.handler(
        { folder_id: FOLDER_ID, dest_parent_path: 'files.work.reports.q1' },
        ctx,
      ),
    );
    expect(err).toMatch(/own subtree/);
  });
});

describe('folder_copy', () => {
  it('refuses a blank folder_id or dest_parent_path WITHOUT calling the store', async () => {
    expect(
      errorOf(await folderCopy.handler({ folder_id: '', dest_parent_path: 'files.a' }, ctx)),
    ).toMatch(/folder_id and dest_parent_path required/);
    expect(
      errorOf(await folderCopy.handler({ folder_id: FOLDER_ID, dest_parent_path: '' }, ctx)),
    ).toMatch(/folder_id and dest_parent_path required/);
    expect(copyFolderById).not.toHaveBeenCalled();
  });

  it('copies under the owner and returns the counts', async () => {
    const res = await folderCopy.handler(
      { folder_id: FOLDER_ID, dest_parent_path: 'files.backups' },
      ctx,
    );
    expect(copyFolderById).toHaveBeenCalledWith({
      ownerId: 'o1',
      folderId: FOLDER_ID,
      destParentPath: 'files.backups',
    });
    expect(outputOf(res)).toEqual({ folder, copiedFiles: 3, copiedFolders: 1 });
  });

  it('passes the 200-file cap refusal through so the caller learns the workaround', async () => {
    vi.mocked(copyFolderById).mockRejectedValue(
      new Error(
        'copyFolderById: 341 files exceeds the 200-file copy cap; copy subfolders individually',
      ),
    );
    const err = errorOf(
      await folderCopy.handler({ folder_id: FOLDER_ID, dest_parent_path: 'files.backups' }, ctx),
    );
    expect(err).toMatch(/200-file copy cap/);
  });
});
