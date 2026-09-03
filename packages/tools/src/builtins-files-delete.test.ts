/**
 * Behavioural tests for file_delete and folder_delete.
 *
 * file_delete carries the most unusual contract in the destructive set: when a
 * file has derived nodes (extracted images, imported tables, pages, notes) the
 * first call returns **ok: true and deletes nothing**. It is a count-and-
 * confirm preview, not a failure — the caller is expected to read the counts,
 * check with the user, and call again with `delete_derived: true`.
 *
 * That shape is easy to "tidy" into a bug in either direction:
 *
 *  - turn the preview into `ok: false` and the model treats a normal, expected
 *    step as an error and gives up (or retries blindly);
 *  - let the preview fall through to the delete and the two-step confirmation
 *    disappears silently, taking the derived nodes with it.
 *
 * So the preview arm is pinned twice: it succeeds, AND nothing was destroyed.
 *
 * The store edges are stubbed; the tools' own branching is real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  return { ...actual, deleteFileById: vi.fn(), deleteFolder: vi.fn() };
});
vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, deleteFileWithDerived: vi.fn() };
});

import { deleteFileById, deleteFolder } from '@mantle/files';
import { deleteFileWithDerived } from '@mantle/content';
// file_delete / folder_delete are mcpOnly, so they live in the OPERATOR
// export, not FILE_TOOLS — they are never granted to an agent.
import { FILE_OPERATOR_TOOLS } from './builtins-files';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const all = FILE_OPERATOR_TOOLS as readonly BuiltinToolDef[];
const fileDel = all.find((t) => t.slug === 'file_delete')!;
const folderDel = all.find((t) => t.slug === 'folder_delete')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const FILE_ID = '11111111-2222-4333-8444-555555555555';
const FOLDER_ID = '99999999-2222-4333-8444-555555555555';

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): string {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return String(res.output);
}

beforeEach(() => vi.clearAllMocks());

describe('file_delete', () => {
  it('refuses a blank file_id WITHOUT calling either store path', async () => {
    const res = await fileDel.handler({ file_id: '' }, ctx);
    expect(errorOf(res)).toMatch(/file_id required/);
    expect(deleteFileById).not.toHaveBeenCalled();
    expect(deleteFileWithDerived).not.toHaveBeenCalled();
  });

  it('deletes a plain file with no derived nodes', async () => {
    vi.mocked(deleteFileById).mockResolvedValue({ ok: true } as never);
    const res = await fileDel.handler({ file_id: FILE_ID }, ctx);
    expect(deleteFileById).toHaveBeenCalledWith({ ownerId: 'o1', fileId: FILE_ID });
    expect(outputOf(res)).toBe('deleted');
  });

  describe('the derived-node preview', () => {
    beforeEach(() => {
      vi.mocked(deleteFileById).mockResolvedValue({
        ok: false,
        reason: 'has_derived',
        derived: { pages: 2, tables: 1 },
      } as never);
    });

    it('SUCCEEDS rather than erroring — it is a confirmation step, not a fault', async () => {
      const res = await fileDel.handler({ file_id: FILE_ID }, ctx);
      // ok:false here would read as a broken call and stop a legitimate flow.
      expect(res.ok).toBe(true);
    });

    it('says plainly that nothing was deleted, and how to proceed', async () => {
      const out = outputOf(await fileDel.handler({ file_id: FILE_ID }, ctx));
      expect(out).toMatch(/nothing was deleted/);
      // The recovery move must be in the message; without it the model has to
      // guess that a second call with a flag is the intended next step.
      expect(out).toMatch(/delete_derived/);
    });

    it('does NOT reach the cascading delete on the preview call', async () => {
      await fileDel.handler({ file_id: FILE_ID }, ctx);
      // The whole point of the two-step: the destructive path stays untouched
      // until the caller opts in explicitly.
      expect(deleteFileWithDerived).not.toHaveBeenCalled();
    });
  });

  it('cascades only when delete_derived is explicitly set', async () => {
    vi.mocked(deleteFileWithDerived).mockResolvedValue({
      ok: true,
      reaped: { pages: 2 },
      skipped: 0,
    } as never);
    const res = await fileDel.handler({ file_id: FILE_ID, delete_derived: true }, ctx);
    expect(deleteFileWithDerived).toHaveBeenCalledWith('o1', FILE_ID);
    // And the plain path is NOT also called — one delete, not two.
    expect(deleteFileById).not.toHaveBeenCalled();
    expect(outputOf(res)).toMatch(/deleted, along with/);
  });

  it('reports derived nodes it could not remove instead of hiding them', async () => {
    vi.mocked(deleteFileWithDerived).mockResolvedValue({
      ok: true,
      reaped: { pages: 2 },
      skipped: 3,
    } as never);
    const out = outputOf(await fileDel.handler({ file_id: FILE_ID, delete_derived: true }, ctx));
    // A silent skip leaves orphans the user believes are gone.
    expect(out).toMatch(/3 derived node\(s\) skipped/);
  });

  it('explains an attachment refusal with the fix, not a bare failure', async () => {
    vi.mocked(deleteFileById).mockResolvedValue({ ok: false, reason: 'attachment' } as never);
    expect(errorOf(await fileDel.handler({ file_id: FILE_ID }, ctx))).toMatch(
      /email attachment; delete it from the email instead/,
    );
  });

  it('names the drawings blocking an image delete', async () => {
    vi.mocked(deleteFileById).mockResolvedValue({
      ok: false,
      reason: 'in_drawing',
      drawings: [{ title: 'Site plan' }],
    } as never);
    const err = errorOf(await fileDel.handler({ file_id: FILE_ID }, ctx));
    // Naming the drawing is the difference between a fixable message and a
    // dead end — the user has to know WHICH drawing to edit.
    expect(err).toMatch(/Site plan/);
  });
});

describe('folder_delete', () => {
  it('refuses a blank folder_id WITHOUT calling the store', async () => {
    const res = await folderDel.handler({ folder_id: '' }, ctx);
    expect(errorOf(res)).toMatch(/folder_id required/);
    expect(deleteFolder).not.toHaveBeenCalled();
  });

  it('deletes an empty folder', async () => {
    vi.mocked(deleteFolder).mockResolvedValue({ ok: true } as never);
    const res = await folderDel.handler({ folder_id: FOLDER_ID }, ctx);
    expect(deleteFolder).toHaveBeenCalledWith({ ownerId: 'o1', folderId: FOLDER_ID });
    expect(outputOf(res)).toBe('deleted');
  });

  it('surfaces the store’s refusal reason rather than a generic failure', async () => {
    // The two refusals that matter — a non-empty folder and the files root —
    // are decided in the store; the tool must pass the reason through so the
    // caller learns which one it hit.
    vi.mocked(deleteFolder).mockResolvedValue({ ok: false, reason: 'not empty' } as never);
    expect(errorOf(await folderDel.handler({ folder_id: FOLDER_ID }, ctx))).toMatch(/not empty/);
  });
});
