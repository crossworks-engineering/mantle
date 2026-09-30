/**
 * The Files screen's move, copy and new-file routes ask before a shared
 * folder changes who can see what they write (folder audit S3, UI-07): a
 * visibility refusal from the guard answers 409 with the list and the Files
 * operation never runs; `confirm` (and `seen`) reach the guard. The guards'
 * own rules are pinned by packages/content/src/tree/files-guard.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '11111111-1111-4111-8111-111111111111';
const FILE = '22222222-2222-4222-8222-222222222222';
const FOLDER = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({ refuse: false }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({ id: OWNER })),
  getOwnerForAsset: vi.fn(async () => ({ id: OWNER })),
}));

vi.mock('@mantle/content/tree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content/tree')>();
  const refusal = () =>
    new actual.TreeVisibilityError({
      changes: [{ id: FILE, title: 'payroll.xlsx', from: 'admin', to: 'client' }],
      total: 1,
    });
  const guard = vi.fn(async (..._args: unknown[]) => {
    if (h.refuse) throw refusal();
    return { changes: [], total: 0 };
  });
  return { ...actual, guardFileTo: guard, guardFolderTo: guard, guardNewFileIn: guard };
});

vi.mock('@mantle/files', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  moveFileById: vi.fn(async () => ({ id: FILE })),
  copyFileById: vi.fn(async () => ({ id: FILE })),
  moveFolderById: vi.fn(async () => ({ folder: { id: FOLDER }, requeued: 0 })),
  copyFolderById: vi.fn(async () => ({ copiedFiles: 0, copiedFolders: 0 })),
}));

vi.mock('@/lib/files', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureFilesRootBranch: vi.fn(async () => {}),
  upsertFile: vi.fn(async () => ({ id: FILE, filename: 'a.md', mimeType: 'text/markdown' })),
}));

import { guardFileTo, guardFolderTo, guardNewFileIn } from '@mantle/content/tree';
import { copyFileById, moveFileById, moveFolderById } from '@mantle/files';
import { upsertFile } from '@/lib/files';

const json = (method: string, body: unknown) =>
  new Request('http://x/api/files', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const ctxOf = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.refuse = false;
});

describe('Files routes and the visibility confirm', () => {
  it('a file move into a shared folder answers 409 with the list and moves nothing', async () => {
    h.refuse = true;
    const { PATCH } = await import('./files/[id]/route');
    const res = await PATCH(json('PATCH', { move: 'files.portal' }), ctxOf(FILE));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'visibility', total: 1 });
    expect(moveFileById).not.toHaveBeenCalled();
  });

  it('confirm and seen reach the guard, and the move goes ahead', async () => {
    const { PATCH } = await import('./files/[id]/route');
    const res = await PATCH(
      json('PATCH', { move: 'files.portal', confirm: true, seen: 1 }),
      ctxOf(FILE),
    );
    expect(res.status).toBe(200);
    expect(guardFileTo).toHaveBeenCalledWith(OWNER, FILE, 'files.portal', {
      confirm: true,
      seen: 1,
    });
    expect(moveFileById).toHaveBeenCalled();
  });

  it('a file copy and a folder move ask the same way', async () => {
    h.refuse = true;
    const file = await import('./files/[id]/route');
    expect((await file.POST(json('POST', { copy_to: 'files.portal' }), ctxOf(FILE))).status).toBe(
      409,
    );
    expect(copyFileById).not.toHaveBeenCalled();
    const folder = await import('./folders/[id]/route');
    expect(
      (await folder.PATCH(json('PATCH', { move: 'files.portal' }), ctxOf(FOLDER))).status,
    ).toBe(409);
    expect(guardFolderTo).toHaveBeenCalled();
    expect(moveFolderById).not.toHaveBeenCalled();
  });

  it('a new text file in a shared folder asks first, and is written once confirmed', async () => {
    h.refuse = true;
    const { POST } = await import('./files/route');
    const body = { parentPath: 'files.portal', filename: 'a.md', content: 'x' };
    expect((await POST(json('POST', body))).status).toBe(409);
    expect(upsertFile).not.toHaveBeenCalled();
    h.refuse = false;
    expect((await POST(json('POST', { ...body, confirm: true }))).status).toBe(200);
    expect(guardNewFileIn).toHaveBeenLastCalledWith(OWNER, 'files.portal', 'a.md', {
      confirm: true,
    });
    expect(upsertFile).toHaveBeenCalled();
  });
});
