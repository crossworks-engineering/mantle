/**
 * file_history_list / file_history_restore / file_history_delete: a file's
 * kept versions (docs/files.md, "File history"). The store is stubbed; the
 * tools' own branching is real: a caller who does not moderate the file is
 * told who may (and nothing is restored or deleted), a file it does not read
 * is not found, an unknown version names the list tool, and an allowed call
 * passes the ids through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/files', () => ({
  FILE_VERSION_RIGHT_MESSAGE: 'for a Moderator',
  deleteFileVersion: vi.fn(),
  listFileVersions: vi.fn(),
  mayModerateFile: vi.fn(),
  restoreFileVersion: vi.fn(),
}));

import { deleteFileVersion, mayModerateFile, restoreFileVersion } from '@mantle/files';
import { FILE_HISTORY_TOOLS } from './files/history';
import type { ToolHandlerContext } from './types';

const restore = FILE_HISTORY_TOOLS.find((t) => t.slug === 'file_history_restore')!;
const del = FILE_HISTORY_TOOLS.find((t) => t.slug === 'file_history_delete')!;
const ctx: ToolHandlerContext = { ownerId: 'o1' };
const FILE = '11111111-1111-4111-8111-111111111111';
const VERSION = '22222222-2222-4222-8222-222222222222';

beforeEach(() => vi.clearAllMocks());

describe('file_history_restore', () => {
  it('a caller who does not moderate the file is told who may; nothing is restored', async () => {
    vi.mocked(mayModerateFile).mockResolvedValue(false);
    const res = await restore.handler({ file_id: FILE, version_id: VERSION }, ctx);
    expect(res).toEqual({ ok: false, error: 'for a Moderator' });
    expect(restoreFileVersion).not.toHaveBeenCalled();
  });

  it('a file the caller does not read is not found', async () => {
    vi.mocked(mayModerateFile).mockResolvedValue(null);
    const res = await restore.handler({ file_id: FILE, version_id: VERSION }, ctx);
    expect(res.ok).toBe(false);
    expect(restoreFileVersion).not.toHaveBeenCalled();
  });

  it('a Moderator restores; an unknown version names the list tool', async () => {
    vi.mocked(mayModerateFile).mockResolvedValue(true);
    vi.mocked(restoreFileVersion).mockResolvedValueOnce({
      file: { sha256: 'abc', sizeBytes: 3 },
      restored: { seq: 1 },
    } as never);
    const ok = await restore.handler({ file_id: FILE, version_id: VERSION }, ctx);
    expect(ok.ok).toBe(true);
    expect(restoreFileVersion).toHaveBeenCalledWith('o1', FILE, VERSION);
    vi.mocked(restoreFileVersion).mockResolvedValueOnce(null);
    const none = await restore.handler({ file_id: FILE, version_id: VERSION }, ctx);
    expect(none.ok ? '' : none.error).toContain('file_history_list');
  });
});

describe('file_history_delete', () => {
  it('a caller who does not moderate the file is told who may; nothing is deleted', async () => {
    vi.mocked(mayModerateFile).mockResolvedValue(false);
    const res = await del.handler({ file_id: FILE, version_id: VERSION }, ctx);
    expect(res).toEqual({ ok: false, error: 'for a Moderator' });
    expect(deleteFileVersion).not.toHaveBeenCalled();
  });

  it('a Moderator deletes; a version not on the file names the list tool', async () => {
    vi.mocked(mayModerateFile).mockResolvedValue(true);
    vi.mocked(deleteFileVersion).mockResolvedValueOnce(true);
    const ok = await del.handler({ file_id: FILE, version_id: VERSION }, ctx);
    expect(ok).toEqual({ ok: true, output: { file_id: FILE, deleted: VERSION } });
    vi.mocked(deleteFileVersion).mockResolvedValueOnce(false);
    const none = await del.handler({ file_id: FILE, version_id: VERSION }, ctx);
    expect(none.ok ? '' : none.error).toContain('file_history_list');
  });
});
