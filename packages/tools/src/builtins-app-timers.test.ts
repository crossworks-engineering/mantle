/**
 * The app timer tools' handlers (builtins-app-timers.ts), with the database
 * stood in: the surface rule, the app read, the manage check before any
 * change, the timer rule, and what each answers. The database's own side
 * (the row rule, the write check, the caps, the runs) is
 * app-timers/app-timers.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppTimerRow } from '@mantle/db';

const h = vi.hoisted(() => ({
  app: null as null | { id: string; manifest: { toolSlugs?: string[] } },
  manageRefused: false,
  admin: true,
  timers: new Map<string, AppTimerRow>(),
  deleted: [] as string[],
  set: [] as unknown[],
  purged: [] as string[],
  purgeFails: false,
  queued: null as null | 'running' | { notBefore: Date },
}));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertItemRight: vi.fn(async () => {
    if (h.manageRefused) throw new Error('item-workspace: may not manage');
  }),
  loginHoldsAdmin: vi.fn(async () => h.admin),
  currentWorkspaceScope: vi.fn(() => null),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAppRuntime: vi.fn(async (_o: string, id: string) => (h.app?.id === id ? h.app : null)),
}));
vi.mock('@mantle/content/app-broker', () => ({
  appTimerPurgeAdminRows: vi.fn(async (_o: string, _a: string, timerId: string) => {
    if (h.purgeFails) throw new Error('busy');
    h.purged.push(timerId);
    return 1;
  }),
}));
vi.mock('./resolve', () => ({
  resolveTool: vi.fn(async (_o: string, slug: string) => ({
    slug,
    handler: { kind: 'builtin', ref: slug },
    requiresConfirm: false,
    externalAccess: null,
    description: '',
    inputSchema: {},
  })),
}));
vi.mock('./app-timers/store', () => ({
  getAppTimer: vi.fn(async (_a: string, name: string) => h.timers.get(name) ?? null),
  listAppTimers: vi.fn(async () => [...h.timers.values()]),
  deleteAppTimer: vi.fn(async (_a: string, name: string) => {
    h.deleted.push(name);
    const row = h.timers.get(name);
    h.timers.delete(name);
    return row?.id ?? null;
  }),
  queueAppTimerNow: vi.fn(
    async (_a: string, name: string) => h.queued ?? h.timers.get(name) ?? null,
  ),
  setAppTimer: vi.fn(async (t: Record<string, unknown>) => {
    h.set.push(t);
    const row = timer(String(t.name), {
      toolSlug: String(t.toolSlug),
      enabled: t.enabled !== false,
    });
    const created = !h.timers.has(row.name);
    h.timers.set(row.name, row);
    return { row, created };
  }),
}));

import './registry';
import { APP_TIMER_TOOLS } from './builtins-app-timers';

const APP = '11111111-1111-4111-8111-111111111111';
const LOGIN = '22222222-2222-4222-8222-222222222222';

function timer(name: string, over: Partial<AppTimerRow> = {}): AppTimerRow {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    ownerId: 'owner',
    appNodeId: APP,
    name,
    toolSlug: 'calculate',
    args: {},
    everyMinutes: 5,
    keepDays: 90,
    enabled: true,
    createdBy: LOGIN,
    createdAt: new Date(),
    updatedAt: new Date(),
    nextRunAt: new Date(),
    lastRunAt: null,
    lastOk: null,
    lastError: null,
    lastMs: null,
    failCount: 0,
    claimId: null,
    claimedAt: null,
    ...over,
  };
}

const def = (slug: string) => APP_TIMER_TOOLS.find((t) => t.slug === slug)!;
const asLogin = { ownerId: 'owner', surface: { kind: 'web', loginId: LOGIN } } as const;
const asTeamHeartbeat = { ownerId: 'owner', surface: { kind: 'team' } } as never;

beforeEach(() => {
  h.app = { id: APP, manifest: { toolSlugs: ['calculate', 'app_tools_set', 'peer_status'] } };
  h.manageRefused = false;
  h.admin = true;
  h.timers = new Map([['calc', timer('calc')]]);
  h.deleted = [];
  h.set = [];
  h.purged = [];
  h.purgeFails = false;
  h.queued = null;
});

describe('app_timer_delete', () => {
  it('removes a timer of an app the caller manages', async () => {
    const r = await def('app_timer_delete').handler({ app_id: APP, name: 'calc' }, asLogin);
    expect(r).toEqual({ ok: true, output: { app_id: APP, name: 'calc', deleted: true } });
    expect(h.deleted).toEqual(['calc']);
    // Its runs kept at admin rules go at once.
    expect(h.purged).toEqual([timer('calc').id]);
  });

  it('still deletes when the purge cannot reach the database, and says so', async () => {
    h.purgeFails = true;
    const r = await def('app_timer_delete').handler({ app_id: APP, name: 'calc' }, asLogin);
    expect(r).toMatchObject({ ok: true, output: { deleted: true } });
    expect(r.ok && (r.output as { note?: string }).note).toMatch(
      /admin rules could not be removed/,
    );
  });

  it('refuses: another surface, an app not read, one not managed, no such timer', async () => {
    expect(
      (await def('app_timer_delete').handler({ app_id: APP, name: 'calc' }, asTeamHeartbeat)).ok,
    ).toBe(false);
    h.app = null;
    expect(await def('app_timer_delete').handler({ app_id: APP, name: 'calc' }, asLogin)).toEqual({
      ok: false,
      error: `app ${APP} not found`,
    });
    h.app = { id: APP, manifest: {} };
    h.manageRefused = true;
    await expect(
      def('app_timer_delete').handler({ app_id: APP, name: 'calc' }, asLogin),
    ).rejects.toThrow(/manage/);
    h.manageRefused = false;
    expect((await def('app_timer_delete').handler({ app_id: APP, name: 'nope' }, asLogin)).ok).toBe(
      false,
    );
    expect(h.deleted).toEqual(['nope']);
  });
});

describe('app_timer_set', () => {
  it('sets a declared read as the calling login, within the minute', async () => {
    const r = await def('app_timer_set').handler(
      {
        app_id: APP,
        name: 'peers',
        tool: 'calculate',
        every_minutes: 5,
        args: { expression: '1' },
      },
      asLogin,
    );
    expect(r.ok).toBe(true);
    expect(h.set[0]).toMatchObject({
      appId: APP,
      name: 'peers',
      toolSlug: 'calculate',
      everyMinutes: 5,
      keepDays: 90,
      enabled: true,
      loginId: LOGIN,
    });
    expect((h.set[0] as { nextRunAt?: Date }).nextRunAt).toBeInstanceOf(Date);
  });

  it('refuses a write tool, an undeclared one, a risky one below Admin, and bad input', async () => {
    const set = (input: Record<string, unknown>) =>
      def('app_timer_set').handler(
        { app_id: APP, name: 't', tool: 'calculate', ...input },
        asLogin,
      );
    expect((await set({ tool: 'app_tools_set' })).ok).toBe(false);
    expect((await set({ tool: 'box_status' })).ok).toBe(false);
    h.admin = false;
    const risky = await set({ tool: 'peer_status' });
    expect(!risky.ok && risky.error).toMatch(/only an Admin user/);
    h.admin = true;
    expect((await set({ tool: 'peer_status' })).ok).toBe(true);
    for (const bad of [
      { every_minutes: 0 },
      { every_minutes: 2.5 },
      { keep_days: 0 },
      { args: 'x' },
      { enabled: 'yes' },
      { name: '-x' },
    ]) {
      expect((await set(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(h.set).toHaveLength(1);
  });

  it('switched off, its runs kept at admin rules go; switched on, nothing is purged', async () => {
    const set = (enabled: boolean) =>
      def('app_timer_set').handler(
        { app_id: APP, name: 'calc', tool: 'calculate', args: { expression: '1' }, enabled },
        asLogin,
      );
    expect((await set(true)).ok).toBe(true);
    expect(h.purged).toEqual([]);
    expect((await set(false)).ok).toBe(true);
    expect(h.purged).toEqual([timer('calc').id]);
  });

  it('needs a login: an owner path that names none is told so', async () => {
    const r = await def('app_timer_set').handler(
      { app_id: APP, name: 't', tool: 'calculate' },
      { ownerId: 'owner', surface: { kind: 'web' } },
    );
    expect(!r.ok && r.error).toMatch(/signed-in login/);
  });
});

describe('app_timer_run', () => {
  it('makes a switched-on timer due now; refuses a switched-off or orphaned one', async () => {
    const run = (name: string) => def('app_timer_run').handler({ app_id: APP, name }, asLogin);
    expect(await run('calc')).toMatchObject({ ok: true, output: { queued: true } });
    h.timers.set('off', timer('off', { enabled: false }));
    expect((await run('off')).ok).toBe(false);
    h.timers.set('gone', timer('gone', { createdBy: null }));
    expect((await run('gone')).ok).toBe(false);
    h.timers.set('writes', timer('writes', { toolSlug: 'app_tools_set' }));
    expect((await run('writes')).ok).toBe(false);
  });

  it('inside the floor (or the back-off) it is refused with the time it can run from', async () => {
    const run = () => def('app_timer_run').handler({ app_id: APP, name: 'calc' }, asLogin);
    h.queued = { notBefore: new Date('2026-11-03T10:05:00.000Z') };
    const r = await run();
    expect(!r.ok && r.error).toMatch(/ran too recently.*2026-11-03T10:05:00\.000Z/);
    h.queued = 'running';
    expect(!(await run()).ok).toBe(true);
  });
});

describe('app_timer_list', () => {
  it('lists the timers with their status', async () => {
    const r = await def('app_timer_list').handler({ app_id: APP }, asLogin);
    expect(r).toMatchObject({
      ok: true,
      output: {
        app_id: APP,
        runs_table: '_timer_runs',
        timers: [{ name: 'calc', every_minutes: 5 }],
      },
    });
  });
});
