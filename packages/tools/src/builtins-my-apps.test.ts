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

// Access matrix N6: at the 50-app cap the answer names what a member can
// do. A member has no delete and no admin sees a private draft, so "ask an
// admin to delete some" pointed at nothing.
describe('my_app_create at the cap', () => {
  it('says to submit one, never to ask an admin to delete a private draft', async () => {
    const { listSpaceApps } = await import('@mantle/content');
    vi.mocked(listSpaceApps).mockResolvedValueOnce(
      Array.from({ length: 50 }, (_, i) => ({ id: `a${i}`, mine: true })) as never,
    );
    const res = await def('my_app_create').handler({ name: 'One more' }, member());
    expect(res.ok).toBe(false);
    const error = (res as { error: string }).error;
    expect(error).toMatch(/my_app_submit/);
    expect(error).not.toMatch(/Ask an admin to accept or delete/);
  });
});
