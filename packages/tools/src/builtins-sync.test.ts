/**
 * The Sync admin tools (Sync plan M3; builtins-sync.ts): each one is the
 * sidecar's admin route, and a refusal comes back as the tool's error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const admin = vi.hoisted(() => ({ calls: [] as { path: string; body: unknown }[], fail: '' }));
vi.mock('@mantle/email', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/email')>();
  return {
    ...real,
    syncAdmin: vi.fn(async (path: string, body: unknown) => {
      admin.calls.push({ path, body });
      if (admin.fail) throw new real.SyncAdminError(admin.fail, 400);
      return { ok: true, name: 'x@example.com', done: true, what: 'mailbox' };
    }),
  };
});

import { sync_remove, sync_drive_set, sync_status } from './builtins-sync';
import type { ToolContext } from './types';

const ctx = { ownerId: '00000000-0000-4000-8000-000000000001' } as unknown as ToolContext;
const ID = '00000000-0000-4000-8000-0000000000aa';

beforeEach(() => {
  admin.calls = [];
  admin.fail = '';
});

describe('sync_remove', () => {
  it('asks the sidecar to remove the account and answers what went', async () => {
    const r = await sync_remove.handler({ id: ID }, ctx);
    expect(r).toMatchObject({ ok: true, output: { name: 'x@example.com', done: true } });
    expect(admin.calls).toEqual([{ path: '/admin/remove', body: { id: ID } }]);
  });

  it("answers the sidecar's refusal as the tool's error", async () => {
    admin.fail = 'No such account.';
    const r = await sync_remove.handler({ id: ID }, ctx);
    expect(r).toEqual({ ok: false, error: 'No such account.' });
  });
});

describe('sync_drive_set and sync_status', () => {
  it('a drive change needs a switch or a selection, and maps the selection fields', async () => {
    expect(await sync_drive_set.handler({ drive_id: ID }, ctx)).toMatchObject({ ok: false });
    expect(admin.calls).toEqual([]);
    await sync_drive_set.handler(
      { drive_id: ID, selections: [{ item_id: 'F1', path: '/Reports', is_folder: true }] },
      ctx,
    );
    expect(admin.calls[0]).toEqual({
      path: '/admin/drive',
      body: {
        driveId: ID,
        selections: [{ itemId: 'F1', path: '/Reports', isFolder: true, name: undefined }],
      },
    });
  });

  it('the status names where a person connects a Microsoft account', async () => {
    const r = await sync_status.handler({}, ctx);
    expect(r.ok && (r.output as { connect: string }).connect).toMatch(/An agent cannot sign in/);
  });
});
