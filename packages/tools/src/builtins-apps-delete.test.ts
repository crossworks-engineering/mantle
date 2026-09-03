/**
 * Behavioural tests for the three destructive app tools — app_delete,
 * app_file_delete, app_table_export_remove.
 *
 * The three destroy very different amounts, and the middle one is the trap:
 *
 *  - `app_delete` takes the app, its builds AND its per-app database. Gated.
 *  - `app_file_delete` removes one source file from the DRAFT, and refuses the
 *    ENTRY file — an app whose entry is gone cannot build, so the refusal is
 *    what stops a one-call brick.
 *  - `app_table_export_remove` sounds destructive and is not. It dissolves the
 *    link only: the brain Table SURVIVES, holding its last synced rows, and
 *    simply stops refreshing. If anyone ever "fixes" this to delete the Table
 *    too, a user who asked to stop syncing loses their data. That expectation
 *    is pinned here in the one place a reader will look.
 *
 * Store edges stubbed; the tools' own guards and error mapping are real, and
 * the entry-file refusal runs through the real CannotDeleteEntryError class.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, deleteApp: vi.fn(), deleteDraftFile: vi.fn() };
});
vi.mock('@mantle/content/app-table-exports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content/app-table-exports')>();
  return { ...actual, removeAppTableExport: vi.fn() };
});

import { deleteApp, deleteDraftFile, CannotDeleteEntryError } from '@mantle/content';
import { removeAppTableExport } from '@mantle/content/app-table-exports';
import { APP_TOOLS } from './builtins-apps';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const appDel = APP_TOOLS.find((t) => t.slug === 'app_delete')!;
const fileDel = APP_TOOLS.find((t) => t.slug === 'app_file_delete')!;
const exportRm = APP_TOOLS.find((t) => t.slug === 'app_table_export_remove')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const APP_ID = '11111111-2222-4333-8444-555555555555';

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

beforeEach(() => vi.clearAllMocks());

describe('app_delete', () => {
  it('is confirm-gated — it takes the source, the builds and the app database', () => {
    expect(appDel.requiresConfirm).toBe(true);
  });

  it('refuses a blank id WITHOUT calling the store', async () => {
    expect(errorOf(await appDel.handler({ id: '  ' }, ctx))).toMatch(/id is required/);
    expect(deleteApp).not.toHaveBeenCalled();
  });

  it('reports a miss as a failure, not a deletion', async () => {
    vi.mocked(deleteApp).mockResolvedValue(false);
    expect(errorOf(await appDel.handler({ id: APP_ID }, ctx))).toMatch(/not found/);
  });

  it('reports the deletion when the store confirms it', async () => {
    vi.mocked(deleteApp).mockResolvedValue(true);
    expect(outputOf(await appDel.handler({ id: APP_ID }, ctx))).toEqual({
      id: APP_ID,
      deleted: true,
    });
  });

  it('surfaces a store failure instead of reporting success', async () => {
    vi.mocked(deleteApp).mockRejectedValue(new Error('db down'));
    expect(errorOf(await appDel.handler({ id: APP_ID }, ctx))).toBe('db down');
  });
});

describe('app_file_delete', () => {
  it('requires both id and path, and writes nothing without them', async () => {
    expect(errorOf(await fileDel.handler({ id: APP_ID }, ctx))).toMatch(/id and path are required/);
    expect(deleteDraftFile).not.toHaveBeenCalled();
  });

  it('surfaces the entry-file refusal with its reason intact', async () => {
    // Deleting the entry leaves an app that cannot build, so the caller has to
    // learn it was the ENTRY and not a bad path.
    //
    // Scope note, found by mutation: the handler's dedicated
    // `err instanceof CannotDeleteEntryError` branch is currently REDUNDANT —
    // deleting it changes nothing, because the generic fallback runs
    // `errorMessage(err)` and produces the identical string. So this case pins
    // the OUTCOME (the reason reaches the caller) and cannot pin the typed
    // branch. It would start earning its keep the moment the generic arm
    // stopped echoing err.message — which is exactly when it would matter.
    vi.mocked(deleteDraftFile).mockRejectedValue(
      new CannotDeleteEntryError('cannot delete the entry file'),
    );
    expect(errorOf(await fileDel.handler({ id: APP_ID, path: 'App.tsx' }, ctx))).toMatch(
      /entry file/,
    );
  });

  it('reports a missing app rather than a silent no-op', async () => {
    vi.mocked(deleteDraftFile).mockResolvedValue(null as never);
    expect(errorOf(await fileDel.handler({ id: APP_ID, path: 'x.tsx' }, ctx))).toMatch(/not found/);
  });

  it('deletes a non-entry file and reports the remaining file count', async () => {
    vi.mocked(deleteDraftFile).mockResolvedValue({
      files: { 'App.tsx': 'x', 'util.ts': 'y' },
    } as never);
    const out = outputOf(await fileDel.handler({ id: APP_ID, path: 'old.ts' }, ctx));
    expect(out).toMatchObject({ id: APP_ID, path: 'old.ts', deleted: true });
    // The count is how the caller confirms the draft still holds an app.
    expect(out.file_count).toBe(2);
  });
});

describe('app_table_export_remove', () => {
  it('requires both arguments, separately reported', async () => {
    expect(errorOf(await exportRm.handler({ table: 'tasks' }, ctx))).toMatch(/id is required/);
    expect(errorOf(await exportRm.handler({ id: APP_ID }, ctx))).toMatch(/table is required/);
    expect(removeAppTableExport).not.toHaveBeenCalled();
  });

  it('says plainly when there was no link to remove', async () => {
    vi.mocked(removeAppTableExport).mockResolvedValue(false as never);
    expect(errorOf(await exportRm.handler({ id: APP_ID, table: 'tasks' }, ctx))).toMatch(
      /no export link exists/,
    );
  });

  it('dissolves the link and reports it', async () => {
    vi.mocked(removeAppTableExport).mockResolvedValue(true as never);
    expect(outputOf(await exportRm.handler({ id: APP_ID, table: 'tasks' }, ctx))).toEqual({
      id: APP_ID,
      table: 'tasks',
      removed: true,
    });
  });

  it('promises in its description that the Table SURVIVES', () => {
    // The name reads like a delete. The description is where a model learns it
    // is not one, and that the Table stays as an ordinary editable grid. If
    // this sentence goes, the tool starts looking like data loss to the model
    // — and the next person to "align" the behaviour with the name would be
    // making it true.
    expect(exportRm.description).toMatch(/Table survives/i);
    expect(exportRm.description).toMatch(/app and its own database are untouched/i);
  });
});
