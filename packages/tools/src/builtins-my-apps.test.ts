/**
 * A member's own mini apps over MCP (team apps Phase 3): who may call the
 * my_app_* tools, and that every change runs on the author's own app in the
 * author's own space. The content layer is mocked; its rules (the author's
 * row, a frozen state) have their own DB tests (member-space-apps).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolHandlerContext } from './types';

const h = vi.hoisted(() => ({
  space: 'space-1' as string | null,
  authorCalls: [] as { author: unknown; id: string; write?: boolean }[],
  frozen: false,
  deleteCalls: [] as { owner: string; id: string; path: string }[],
  // In-flight deletes and the most seen at once (the write slot test).
  running: 0,
  maxRunning: 0,
  deleteDelayMs: 0,
  // The trash and snapshot deletes (access matrix N6).
  appDeletes: [] as { author: unknown; id: string }[],
  appUndeletes: [] as { author: unknown; id: string }[],
  snapshotDeletes: [] as { owner: string; id: string; snapshotId: string; loginId: string }[],
  inTrash: 0,
}));

vi.mock('@mantle/db', () => ({ asSystem: <T>(fn: () => T) => fn() }));
vi.mock('./builtins-my-space', () => ({
  onBehalfOf: vi.fn(async (ctx: ToolHandlerContext) => {
    const s = ctx.surface;
    const loginId = s?.kind === 'team' ? s.loginId : undefined;
    return loginId && h.space ? { loginId, spaceId: h.space } : null;
  }),
}));
vi.mock('./builtins-app-guide', () => ({
  appGuideHandler: vi.fn(async () => ({ ok: true, output: { guide: '# Guide' } })),
}));
vi.mock('./app-build-stage', () => ({ buildAndStageApp: vi.fn() }));
vi.mock('./member-app-tools', () => ({ memberAppToolVerdict: vi.fn() }));
vi.mock('@mantle/content/app-broker', () => ({
  assertSafeScript: vi.fn(),
  checkAppSchemaScript: vi.fn(),
}));
vi.mock('@mantle/content/app-snapshots', () => ({
  AppSnapshotBudgetError: class extends Error {},
  AppSnapshotRefusedError: class extends Error {},
  createAppSnapshot: vi.fn(),
  deleteMemberAppSnapshot: vi.fn(
    async (owner: string, id: string, snapshotId: string, loginId: string) => {
      h.snapshotDeletes.push({ owner, id, snapshotId, loginId });
      return { id: snapshotId, seq: 3, freedBytes: 4096 };
    },
  ),
  listAppSnapshots: vi.fn(),
  restoreAppSnapshot: vi.fn(),
}));
vi.mock('@mantle/content', () => {
  class SpaceAppError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    SpaceAppError,
    AppRestoreDraftError: class extends Error {},
    AppSourceLimitError: class extends Error {},
    CannotDeleteEntryError: class extends Error {},
    NoGreenBuildError: class extends Error {},
    authorSpaceApp: vi.fn(async (author: unknown, id: string, opts: { write?: boolean } = {}) => {
      h.authorCalls.push({ author, id, write: opts.write });
      if (opts.write && h.frozen) {
        throw new SpaceAppError('frozen', 'This app is submitted for review, so it is frozen.');
      }
      return { id, title: 'A', sharing: 'private', reviewState: 'draft' };
    }),
    createSpaceApp: vi.fn(),
    deleteSpaceApp: vi.fn(async (author: unknown, id: string) => {
      h.appDeletes.push({ author, id });
      return {
        id,
        title: 'A',
        sharing: 'private',
        reviewState: 'draft',
        deletedAt: '2026-10-09T00:00:00.000Z',
        wasShared: true,
        wasSubmitted: false,
      };
    }),
    undeleteSpaceApp: vi.fn(async (author: unknown, id: string) => {
      h.appUndeletes.push({ author, id });
      return { id, title: 'A', sharing: 'private', reviewState: 'draft' };
    }),
    listDeletedSpaceApps: vi.fn(async () =>
      Array.from({ length: h.inTrash }, (_, i) => ({ id: `t${i}`, title: `T${i}` })),
    ),
    // The lock is the content layer's (its DB test); here it runs the change.
    withAuthorWrite: vi.fn(async (_a: unknown, _id: string, fn: () => Promise<unknown>) => fn()),
    declareAppSchema: vi.fn(),
    deleteDraftFile: vi.fn(async (owner: string, id: string, path: string) => {
      h.running += 1;
      h.maxRunning = Math.max(h.maxRunning, h.running);
      await new Promise((r) => setTimeout(r, h.deleteDelayMs));
      h.running -= 1;
      h.deleteCalls.push({ owner, id, path });
      return { entry: 'App.tsx', files: { 'App.tsx': '' } };
    }),
    getApp: vi.fn(),
    listAppAccess: vi.fn(),
    listSpaceApps: vi.fn(async () => []),
    publishApp: vi.fn(),
    recallSpaceApp: vi.fn(),
    setManifest: vi.fn(),
    setSpaceAppSharing: vi.fn(async (_a: unknown, id: string, sharing: string) => ({
      id,
      title: 'A',
      sharing,
      reviewState: 'draft',
    })),
    submitSpaceApp: vi.fn(),
    workingSource: vi.fn(),
    writeDraftFile: vi.fn(),
  };
});

const { MY_APP_TOOLS, MY_APP_READ_TOOL_SLUGS, MY_APP_WRITE_TOOL_SLUGS, withLoginWriteSlot } =
  await import('./builtins-my-apps');

const def = (slug: string) => {
  const d = MY_APP_TOOLS.find((t) => t.slug === slug);
  if (!d) throw new Error(slug);
  return d;
};

const APP = '11111111-2222-4333-8444-555555555555';
const mcp = (write: boolean) => ({ via: 'oauth' as const, write });
const member = (write = true): ToolHandlerContext => ({
  ownerId: 'brain',
  surface: { kind: 'team', loginId: 'login-1', contactName: 'M', mcp: mcp(write) },
});

beforeEach(() => {
  h.space = 'space-1';
  h.authorCalls.length = 0;
  h.deleteCalls.length = 0;
  h.frozen = false;
  h.running = 0;
  h.maxRunning = 0;
  h.deleteDelayMs = 0;
  h.appDeletes.length = 0;
  h.appUndeletes.length = 0;
  h.snapshotDeletes.length = 0;
  h.inTrash = 0;
});

describe('who may call the my_app tools', () => {
  it('splits reads from writes, every slug once', () => {
    expect(MY_APP_READ_TOOL_SLUGS).toContain('my_app_list');
    expect(MY_APP_WRITE_TOOL_SLUGS).toContain('my_app_file_delete');
    const all = [...MY_APP_READ_TOOL_SLUGS, ...MY_APP_WRITE_TOOL_SLUGS];
    expect(new Set(all).size).toBe(all.length);
    for (const s of MY_APP_READ_TOOL_SLUGS) expect(def(s).readOnly, s).toBe(true);
    for (const s of MY_APP_WRITE_TOOL_SLUGS) expect(def(s).readOnly, s).toBeFalsy();
  });

  it('refuses every caller that is not a member on their own MCP', async () => {
    const others: ToolHandlerContext[] = [
      { ownerId: 'brain', surface: { kind: 'owner', via: 'mcp' } },
      { ownerId: 'brain', surface: { kind: 'web' } },
      // A member's chat turn: no MCP connection stamped.
      { ownerId: 'brain', surface: { kind: 'team', loginId: 'login-1' } },
      { ownerId: 'brain', surface: { kind: 'client', loginId: 'c-1', mcp: mcp(true) } },
      { ownerId: 'brain' },
    ];
    for (const ctx of others) {
      for (const t of MY_APP_TOOLS) {
        const res = await t.handler({ id: APP, path: 'a.ts', name: 'x' }, ctx);
        expect(res.ok, `${t.slug} ${JSON.stringify(ctx.surface)}`).toBe(false);
      }
    }
    expect(h.deleteCalls).toEqual([]);
  });

  it('refuses every change on a read-only connection', async () => {
    for (const slug of MY_APP_WRITE_TOOL_SLUGS) {
      const res = await def(slug).handler({ id: APP, name: 'x', path: 'a.ts' }, member(false));
      expect(res, slug).toMatchObject({ ok: false, error: expect.stringMatching(/read-only/) });
    }
  });
});

describe('my_app_file_delete', () => {
  it("deletes a file from the author's own draft, in the author's own space", async () => {
    const res = await def('my_app_file_delete').handler(
      { id: APP.toUpperCase(), path: 'lib/old.ts' },
      member(),
    );
    expect(res).toMatchObject({ ok: true, output: { id: APP, deleted: true } });
    expect(h.authorCalls).toEqual([
      { author: { loginId: 'login-1', spaceId: 'space-1' }, id: APP, write: true },
    ]);
    // Keyed to the space, never the brain the call came in on.
    expect(h.deleteCalls).toEqual([{ owner: 'space-1', id: APP, path: 'lib/old.ts' }]);
  });

  it('refuses a submitted (frozen) app and deletes nothing', async () => {
    h.frozen = true;
    const res = await def('my_app_file_delete').handler({ id: APP, path: 'a.ts' }, member());
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/frozen/) });
    expect(h.deleteCalls).toEqual([]);
  });

  it('refuses an id that is not a UUID', async () => {
    const res = await def('my_app_file_delete').handler({ id: 'x', path: 'a.ts' }, member());
    expect(res.ok).toBe(false);
    expect(h.deleteCalls).toEqual([]);
  });
});

// M3 re-audit, medium 1: a burst of parallel changes from one MCP client
// runs one at a time per login, never all at once.
describe('one change at a time per member', () => {
  it('serializes parallel writes of one login', async () => {
    h.deleteDelayMs = 20;
    const calls = Array.from({ length: 5 }, (_, i) =>
      def('my_app_file_delete').handler({ id: APP, path: `f${i}.ts` }, member()),
    );
    const out = await Promise.all(calls);
    expect(out.every((r) => r.ok)).toBe(true);
    expect(h.maxRunning).toBe(1);
    expect(h.deleteCalls).toHaveLength(5);
  });

  it('answers busy after the wait, and frees the slot when a change ends', async () => {
    let release!: () => void;
    const first = withLoginWriteSlot(
      'k',
      () => new Promise<string>((r) => (release = () => r('a'))),
    );
    expect(await withLoginWriteSlot('k', async () => 'b', 10)).toEqual({ busy: true });
    // Another login is never held up.
    expect(await withLoginWriteSlot('other', async () => 'c', 10)).toBe('c');
    release();
    expect(await first).toBe('a');
    expect(await withLoginWriteSlot('k', async () => 'd', 10)).toBe('d');
  });
});

// Access matrix N1: sharing with the team is UI only; MCP only makes an app
// private again.
describe('my_app_unshare', () => {
  it("makes the author's own app private, never shares it", async () => {
    expect(MY_APP_TOOLS.map((t) => t.slug)).not.toContain('my_app_share');
    const res = await def('my_app_unshare').handler({ id: APP }, member());
    expect(res).toMatchObject({ ok: true, output: { id: APP, sharing: 'private' } });
    expect(def('my_app_unshare').inputSchema).toMatchObject({ required: ['id'] });
  });

  it('needs the Write switch', async () => {
    const res = await def('my_app_unshare').handler({ id: APP }, member(false));
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/read-only/) });
  });
});

// Access matrix N6 (option A): at the 50-app cap the answer names the
// member's own delete. No admin sees a private draft, so "ask an admin to
// delete some" pointed at nothing, and "a member cannot delete" is no
// longer true.
describe('my_app_create at the cap', () => {
  it("points at the member's own delete, never at an admin or a missing delete", async () => {
    const { listSpaceApps } = await import('@mantle/content');
    vi.mocked(listSpaceApps).mockResolvedValueOnce(
      Array.from({ length: 50 }, (_, i) => ({ id: `a${i}`, mine: true })) as never,
    );
    const res = await def('my_app_create').handler({ name: 'One more' }, member());
    expect(res.ok).toBe(false);
    const error = (res as { error: string }).error;
    expect(error).toMatch(/my_app_delete/);
    expect(error).toMatch(/my_app_undelete/);
    expect(error).not.toMatch(/cannot delete/);
    expect(error).not.toMatch(/Ask an admin to accept or delete/);
  });
});

describe('my_app_delete', () => {
  it("moves the author's own app to their trash, in the author's own space", async () => {
    const res = await def('my_app_delete').handler({ id: APP.toUpperCase() }, member());
    expect(res).toMatchObject({
      ok: true,
      output: { id: APP, deleted: true, was_shared: true, was_submitted: false },
    });
    // Found by the author's own row first (any state: a submitted app may go).
    expect(h.authorCalls).toEqual([
      { author: { loginId: 'login-1', spaceId: 'space-1' }, id: APP, write: false },
    ]);
    expect(h.appDeletes).toEqual([{ author: { loginId: 'login-1', spaceId: 'space-1' }, id: APP }]);
  });

  it('needs the Write switch and deletes nothing without it', async () => {
    const res = await def('my_app_delete').handler({ id: APP }, member(false));
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/read-only/) });
    expect(h.appDeletes).toEqual([]);
  });

  it('refuses when the trash is full, and says how to make room', async () => {
    h.inTrash = 50;
    const res = await def('my_app_delete').handler({ id: APP }, member());
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/my_app_undelete/) });
    expect(h.appDeletes).toEqual([]);
  });

  it('refuses an id that is not a UUID', async () => {
    const res = await def('my_app_delete').handler({ id: 'x' }, member());
    expect(res.ok).toBe(false);
    expect(h.appDeletes).toEqual([]);
  });

  it('is a write: offered only with write on, behind the write slot', () => {
    expect(MY_APP_WRITE_TOOL_SLUGS).toContain('my_app_delete');
    expect(def('my_app_delete').requiresConfirm).toBeFalsy();
  });
});

describe('my_app_undelete', () => {
  it("brings the author's own app back from their trash, private", async () => {
    const res = await def('my_app_undelete').handler({ id: APP }, member());
    expect(res).toMatchObject({
      ok: true,
      output: { id: APP, sharing: 'private', reviewState: 'draft' },
    });
    expect(h.appUndeletes).toEqual([
      { author: { loginId: 'login-1', spaceId: 'space-1' }, id: APP },
    ]);
  });

  it('refuses at the 50-app cap: restore never passes it', async () => {
    const { listSpaceApps } = await import('@mantle/content');
    vi.mocked(listSpaceApps).mockResolvedValueOnce(
      Array.from({ length: 50 }, (_, i) => ({ id: `a${i}`, mine: true })) as never,
    );
    const res = await def('my_app_undelete').handler({ id: APP }, member());
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/my_app_delete/) });
    expect(h.appUndeletes).toEqual([]);
  });

  it('needs the Write switch', async () => {
    const res = await def('my_app_undelete').handler({ id: APP }, member(false));
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/read-only/) });
    expect(h.appUndeletes).toEqual([]);
  });
});

describe('my_app_deleted_list', () => {
  it("lists the author's own trash, with write off too", async () => {
    h.inTrash = 2;
    const res = await def('my_app_deleted_list').handler({}, member(false));
    expect(res).toMatchObject({ ok: true, output: { count: 2 } });
    expect(MY_APP_READ_TOOL_SLUGS).toContain('my_app_deleted_list');
  });
});

describe('my_app_snapshot_delete', () => {
  const SNAP = '99999999-8888-4777-8666-555555555555';

  it("deletes the author's own snapshot, by their login, in their own space", async () => {
    const res = await def('my_app_snapshot_delete').handler(
      { id: APP, snapshot_id: SNAP.toUpperCase() },
      member(),
    );
    expect(res).toMatchObject({
      ok: true,
      output: { id: APP, deleted: SNAP, freed_bytes: 4096 },
    });
    expect(h.authorCalls).toEqual([
      { author: { loginId: 'login-1', spaceId: 'space-1' }, id: APP, write: true },
    ]);
    // Keyed to the space and the calling login, never the brain.
    expect(h.snapshotDeletes).toEqual([
      { owner: 'space-1', id: APP, snapshotId: SNAP, loginId: 'login-1' },
    ]);
  });

  it('refuses a submitted (frozen) app and deletes nothing', async () => {
    h.frozen = true;
    const res = await def('my_app_snapshot_delete').handler(
      { id: APP, snapshot_id: SNAP },
      member(),
    );
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/frozen/) });
    expect(h.snapshotDeletes).toEqual([]);
  });

  it('refuses a snapshot id that is not a UUID', async () => {
    const res = await def('my_app_snapshot_delete').handler(
      { id: APP, snapshot_id: 'v3' },
      member(),
    );
    expect(res.ok).toBe(false);
    expect(h.snapshotDeletes).toEqual([]);
  });
});
