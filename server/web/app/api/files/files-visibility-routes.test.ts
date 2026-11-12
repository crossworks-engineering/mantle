/**
 * The Files screen's move routes ask before a shared folder changes who can
 * see what they move (folder audit S3, UI-07): a visibility refusal from the
 * guard answers 409 with the list and the Files operation never runs;
 * `confirm` (and `seen`) reach the guard. A NEW file (an upload, a text
 * file, a copy) asks nothing: it takes its folder's sharing (owner's word,
 * 2026-11-12), so it is written even while the move guard would refuse, and
 * a `confirm` from an older client is accepted and ignored. The guards' own
 * rules are pinned by packages/content/src/tree/files-guard.db.test.ts.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessKeyGrant } from '@/lib/access-keys';
import { runWithRequestContext } from '@/server/request-context';

const OWNER = '11111111-1111-4111-8111-111111111111';
const FILE = '22222222-2222-4222-8222-222222222222';
const FOLDER = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({ refuse: false }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({ id: OWNER })),
  // The reader a converted handler calls (A4 step 3b): the same stand-in.
  ownerCaller: vi.fn(() => ({ id: OWNER })),
  getOwnerForAsset: vi.fn(async () => ({ id: OWNER })),
}));

vi.mock('@mantle/content/tree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content/tree')>();
  const refusal = () =>
    new actual.TreeVisibilityError({
      changes: [
        {
          id: FILE,
          title: 'payroll.xlsx',
          alsoVisibleTo: [{ wsId: FOLDER, name: 'Clients' }],
          removedFrom: [],
        },
      ],
      total: 1,
    });
  const guard = vi.fn(async (..._args: unknown[]) => {
    if (h.refuse) throw refusal();
    return { changes: [], total: 0 };
  });
  return { ...actual, guardFileTo: guard, guardFolderTo: guard };
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
  // A file or folder write reads the item in the caller's scope first
  // (pre-check removal part 2): stood in as one it reads.
  fileById: vi.fn(async () => ({ id: FILE, filename: 'a.md', parentPath: 'files' })),
  folderById: vi.fn(async () => ({ id: FOLDER })),
  upsertFile: vi.fn(async () => ({ id: FILE, filename: 'a.md', mimeType: 'text/markdown' })),
}));

import { guardFileTo, guardFolderTo } from '@mantle/content/tree';
import { copyFileById, moveFileById, moveFolderById } from '@mantle/files';
import { upsertFile } from '@/lib/files';

const json = (method: string, body: unknown) =>
  new Request('http://x/api/files', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const ctxOf = (id: string) => ({ params: Promise.resolve({ id }) });

/** A handler's answer as the app gives it: a thrown error answered by
 *  app.onError (answerAppError; A10 part 2, fold 2: the routes throw, the
 *  one table answers TreeVisibilityError 409 with the list). */
async function answered(res: Promise<Response>): Promise<Response> {
  try {
    return await res;
  } catch (err) {
    const { answerAppError } = await import('@/server/app-error');
    return answerAppError(
      err as Error,
      {
        req: { url: 'http://brain.example/api/files', method: 'POST' },
      } as never,
    );
  }
}

// A multipart upload spools under the files root: a temporary one.
let root = '';
let prevRoot: string | undefined;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mantle-files-visibility-'));
  prevRoot = process.env.MANTLE_FILES_ROOT;
  process.env.MANTLE_FILES_ROOT = root;
});
afterAll(async () => {
  if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
  else process.env.MANTLE_FILES_ROOT = prevRoot;
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  h.refuse = false;
});

describe('Files routes and the visibility confirm', () => {
  it('a file move into a shared folder answers 409 with the list and moves nothing', async () => {
    h.refuse = true;
    const { PATCH } = await import('./files/[id]/route');
    const res = await answered(PATCH(json('PATCH', { move: 'files.portal' }), ctxOf(FILE)));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'visibility', total: 1 });
    expect(moveFileById).not.toHaveBeenCalled();
  });

  it('confirm and seen reach the guard, and the move goes ahead', async () => {
    const { PATCH } = await import('./files/[id]/route');
    const res = await answered(
      PATCH(json('PATCH', { move: 'files.portal', confirm: true, seen: 1 }), ctxOf(FILE)),
    );
    expect(res.status).toBe(200);
    expect(guardFileTo).toHaveBeenCalledWith(OWNER, FILE, 'files.portal', {
      confirm: true,
      seen: 1,
    });
    expect(moveFileById).toHaveBeenCalled();
  });

  it('a folder move asks the same way; a file copy (a new file) asks nothing', async () => {
    h.refuse = true;
    const file = await import('./files/[id]/route');
    for (const extra of [{}, { confirm: true, seen: 1 }]) {
      expect(
        (
          await answered(
            file.POST(json('POST', { copy_to: 'files.portal', ...extra }), ctxOf(FILE)),
          )
        ).status,
      ).toBe(201);
    }
    expect(copyFileById).toHaveBeenCalledTimes(2);
    const folder = await import('./folders/[id]/route');
    expect(
      (await answered(folder.PATCH(json('PATCH', { move: 'files.portal' }), ctxOf(FOLDER)))).status,
    ).toBe(409);
    expect(guardFolderTo).toHaveBeenCalled();
    expect(moveFolderById).not.toHaveBeenCalled();
  });

  it('a new file in a shared folder is written at once, with or without confirm', async () => {
    h.refuse = true;
    const { POST } = await import('./files/route');
    const body = { parentPath: 'files.portal', filename: 'a.md', content: 'x' };
    expect((await answered(POST(json('POST', body)))).status).toBe(200);
    expect((await answered(POST(json('POST', { ...body, confirm: true })))).status).toBe(200);
    expect(upsertFile).toHaveBeenCalledTimes(2);
  });

  it('an API key writes a new file into a shared folder too, unasked', async () => {
    h.refuse = true;
    const { POST } = await import('./files/route');
    const grant = {
      id: 'k1',
      loginId: OWNER,
      access: 'write',
      // With Search, so the mail-folder rule reads no database here.
      areas: ['files', 'search'],
    } as unknown as AccessKeyGrant;
    for (const extra of [{}, { confirm: true }]) {
      const req = json('POST', {
        parentPath: 'files.portal',
        filename: 'k.md',
        content: 'x',
        ...extra,
      });
      const res = await answered(
        runWithRequestContext(
          { req, path: '/api/v1/files', method: 'POST', accessKey: grant },
          () => POST(req),
        ),
      );
      expect(res.status).toBe(200);
    }
    expect(upsertFile).toHaveBeenCalledTimes(2);
  });

  it('a multipart upload into a shared folder is written at once, a confirm field ignored', async () => {
    h.refuse = true;
    const { POST } = await import('./files/route');
    for (const confirm of [null, 'true']) {
      const form = new FormData();
      form.set('parentPath', 'files.portal');
      if (confirm) form.set('confirm', confirm);
      form.set('file', new File(['hello'], 'b.txt', { type: 'text/plain' }));
      const res = await answered(
        POST(new Request('http://x/api/files/files', { method: 'POST', body: form })),
      );
      expect(res.status).toBe(200);
    }
    expect(upsertFile).toHaveBeenCalledTimes(2);
    expect(guardFileTo).not.toHaveBeenCalled();
  });
});
