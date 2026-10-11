/**
 * A member's mini apps over MCP (team apps Phase 3; brain apps under the
 * grant rules since workspaces W6b): who may call the my_app_* tools, and
 * that every change is checked against the member's edit right and keyed to
 * the brain. The content layer is mocked; its rules (may edit, may manage,
 * the private workspace) have their own DB test (member-brain-apps).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolHandlerContext } from './types';

const h = vi.hoisted(() => ({
  authorCalls: [] as { author: unknown; id: string; write?: boolean }[],
  readOnly: false,
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
  mine: 0,
  // The scope the call runs in (null: none), each exit from it with its
  // reason, and how deep in such an exit the code runs now.
  scope: null as { loginId: string | null } | null,
  exits: [] as (string | undefined)[],
  exitDepth: 0,
  // What ran inside an exit (depth > 0) and what in the login's scope.
  seen: [] as { what: string; inExit: boolean }[],
}));

vi.mock('@mantle/db', () => ({
  asSystem: async <T>(fn: () => Promise<T>, reason?: string): Promise<T> => {
    h.exits.push(reason);
    h.exitDepth++;
    try {
      return await fn();
    } finally {
      h.exitDepth--;
    }
  },
}));
vi.mock('@mantle/db/viewer', () => ({
  currentWorkspaceScope: () => h.scope,
}));
vi.mock('./builtins-app-guide', () => ({
  appGuideHandler: vi.fn(async () => ({ ok: true, output: { guide: '# Guide' } })),
}));
vi.mock('./app-build-stage', () => ({ buildAndStageApp: vi.fn() }));
vi.mock('./member-app-tools', () => ({
  memberAppToolVerdict: vi.fn(async () => {
    h.seen.push({ what: 'verdict', inExit: h.exitDepth > 0 });
    return { ok: true };
  }),
}));
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
  class MemberAppError extends Error {}
  const state = (id: string) => ({
    id,
    title: 'A',
    homeWs: 'ws-p',
    mayEdit: true,
    mayManage: true,
  });
  return {
    MemberAppError,
    AppRestoreDraftError: class extends Error {},
    AppSourceLimitError: class extends Error {},
    CannotDeleteEntryError: class extends Error {},
    NoGreenBuildError: class extends Error {},
    memberApp: vi.fn(async (author: unknown, id: string, opts: { write?: boolean } = {}) => {
      h.seen.push({ what: 'memberApp', inExit: h.exitDepth > 0 });
      h.authorCalls.push({ author, id, write: opts.write });
      if (opts.write && h.readOnly) {
        throw new MemberAppError('You may run this app but not change it.');
      }
      return state(id);
    }),
    // The check is the content layer's (its DB test); here it runs the change.
    withMemberAppWrite: vi.fn(async (author: unknown, id: string, fn: () => Promise<unknown>) => {
      h.seen.push({ what: 'withMemberAppWrite', inExit: h.exitDepth > 0 });
      h.authorCalls.push({ author, id, write: true });
      if (h.readOnly) throw new MemberAppError('You may run this app but not change it.');
      return fn();
    }),
    createMemberApp: vi.fn(),
    deleteMemberApp: vi.fn(async (author: unknown, id: string) => {
      h.appDeletes.push({ author, id });
      return { id, title: 'A', deletedAt: '2026-10-11T00:00:00.000Z' };
    }),
    undeleteMemberApp: vi.fn(async (author: unknown, id: string) => {
      h.appUndeletes.push({ author, id });
      return { id, title: 'A' };
    }),
    listDeletedMemberApps: vi.fn(async () =>
      Array.from({ length: h.inTrash }, (_, i) => ({ id: `t${i}`, title: `T${i}` })),
    ),
    listLoginApps: vi.fn(async () =>
      Array.from({ length: h.mine }, (_, i) => ({ id: `a${i}`, mine: true })),
    ),
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
    publishApp: vi.fn(),
    setManifest: vi.fn(async (_o: string, _id: string, m: Record<string, unknown>) => {
      h.seen.push({ what: 'setManifest', inExit: h.exitDepth > 0 });
      return m;
    }),
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
  h.mine = 0;
  h.authorCalls.length = 0;
  h.deleteCalls.length = 0;
  h.readOnly = false;
  h.running = 0;
  h.maxRunning = 0;
  h.deleteDelayMs = 0;
  h.appDeletes.length = 0;
  h.appUndeletes.length = 0;
  h.snapshotDeletes.length = 0;
  h.inTrash = 0;
  h.scope = null;
  h.exits.length = 0;
  h.exitDepth = 0;
  h.seen.length = 0;
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
  it('deletes a file from the draft of an app the member may edit, keyed to the brain', async () => {
    const res = await def('my_app_file_delete').handler(
      { id: APP.toUpperCase(), path: 'lib/old.ts' },
      member(),
    );
    expect(res).toMatchObject({ ok: true, output: { id: APP, deleted: true } });
    expect(h.authorCalls.every((c) => c.write === true && c.id === APP)).toBe(true);
    expect(h.authorCalls[0]!.author).toEqual({ loginId: 'login-1', brainId: 'brain' });
    expect(h.deleteCalls).toEqual([{ owner: 'brain', id: APP, path: 'lib/old.ts' }]);
  });

  it('refuses an app the member may not edit and deletes nothing', async () => {
    h.readOnly = true;
    const res = await def('my_app_file_delete').handler({ id: APP, path: 'a.ts' }, member());
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/not change it/) });
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

// Access matrix N6 (option A): at the 50-app cap the answer names the
// member's own delete. Sharing is a grant since W6b: no my_app_share or
// my_app_unshare.
describe('my_app_create at the cap', () => {
  it("points at the member's own delete, never at an admin or a missing delete", async () => {
    h.mine = 50;
    expect(MY_APP_TOOLS.map((t) => t.slug)).not.toContain('my_app_share');
    expect(MY_APP_TOOLS.map((t) => t.slug)).not.toContain('my_app_unshare');
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
  it('deletes an app the member manages (the content layer checks manage)', async () => {
    const res = await def('my_app_delete').handler({ id: APP.toUpperCase() }, member());
    expect(res).toMatchObject({ ok: true, output: { id: APP, deleted: true } });
    // Found in the member's scope first.
    expect(h.authorCalls).toEqual([
      { author: { loginId: 'login-1', brainId: 'brain' }, id: APP, write: false },
    ]);
    expect(h.appDeletes).toEqual([{ author: { loginId: 'login-1', brainId: 'brain' }, id: APP }]);
  });

  it('needs the Write switch and deletes nothing without it', async () => {
    const res = await def('my_app_delete').handler({ id: APP }, member(false));
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/read-only/) });
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
  it('brings a deleted app back (the content layer checks its home)', async () => {
    const res = await def('my_app_undelete').handler({ id: APP }, member());
    expect(res).toMatchObject({ ok: true, output: { id: APP } });
    expect(h.appUndeletes).toEqual([{ author: { loginId: 'login-1', brainId: 'brain' }, id: APP }]);
  });

  it('refuses at the 50-app cap: restore never passes it', async () => {
    h.mine = 50;
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
  it('lists the deleted apps of the homes the member moderates, with write off too', async () => {
    h.inTrash = 2;
    const res = await def('my_app_deleted_list').handler({}, member(false));
    expect(res).toMatchObject({ ok: true, output: { count: 2 } });
    expect(MY_APP_READ_TOOL_SLUGS).toContain('my_app_deleted_list');
  });
});

describe('my_app_snapshot_delete', () => {
  const SNAP = '99999999-8888-4777-8666-555555555555';

  it('deletes a snapshot the member took, by their login, keyed to the brain', async () => {
    const res = await def('my_app_snapshot_delete').handler(
      { id: APP, snapshot_id: SNAP.toUpperCase() },
      member(),
    );
    expect(res).toMatchObject({
      ok: true,
      output: { id: APP, deleted: SNAP, freed_bytes: 4096 },
    });
    expect(h.authorCalls.every((c) => c.write === true)).toBe(true);
    expect(h.snapshotDeletes).toEqual([
      { owner: 'brain', id: APP, snapshotId: SNAP, loginId: 'login-1' },
    ]);
  });

  it('refuses an app the member may not edit and deletes nothing', async () => {
    h.readOnly = true;
    const res = await def('my_app_snapshot_delete').handler(
      { id: APP, snapshot_id: SNAP },
      member(),
    );
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/not change it/) });
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

describe("the login's scope is left only for the app work after the check", () => {
  it('my_app_tools_set checks the declared tools in the login scope, the app rows by app-data', async () => {
    h.scope = { loginId: 'login-1' };
    const res = await def('my_app_tools_set').handler(
      { id: APP, tool_slugs: ['contact_list', 'page_get'] },
      member(),
    );
    expect(res).toMatchObject({ ok: true, output: { tool_slugs: ['contact_list', 'page_get'] } });
    // The member-rule check reads as the login (its workspace scope), not
    // as the system.
    expect(h.seen.filter((x) => x.what === 'verdict')).toEqual([
      { what: 'verdict', inExit: false },
      { what: 'verdict', inExit: false },
    ]);
    // The app work: inside the named exit (the edit check within it reads
    // in the login's own scope, withViewer).
    for (const what of ['withMemberAppWrite', 'setManifest']) {
      expect(h.seen.filter((x) => x.what === what).length, what).toBeGreaterThan(0);
      expect(
        h.seen.filter((x) => x.what === what).every((x) => x.inExit),
        what,
      ).toBe(true);
    }
    expect(h.exits.length).toBeGreaterThan(0);
    expect(h.exits.every((r) => r === 'app-data')).toBe(true);
  });

  it('my_app_guide leaves the scope for nothing', async () => {
    h.scope = { loginId: 'login-1' };
    expect((await def('my_app_guide').handler({}, member(false))).ok).toBe(true);
    expect(h.exits).toEqual([]);
  });

  it('refuses a scope opened for another login, before any exit', async () => {
    h.scope = { loginId: 'login-2' };
    for (const t of MY_APP_TOOLS) {
      const res = await t.handler(
        { id: APP, tool_slugs: ['x'], name: 'x', path: 'a.ts' },
        member(),
      );
      expect(res, t.slug).toMatchObject({
        ok: false,
        error: expect.stringMatching(/No one to act for/),
      });
    }
    expect(h.exits).toEqual([]);
    expect(h.seen).toEqual([]);
  });

  it('no tool body leaves the scope as a whole (source pin)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./builtins-my-apps.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/asSystem\(\s*\(\)\s*=>\s*def\.handler/);
    // One exit helper, and every exit goes through it.
    expect(src.match(/\basSystem\(/g)).toHaveLength(1);
  });
});
