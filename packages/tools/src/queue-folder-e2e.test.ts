/**
 * The queue-time create check end to end (A5 step 6a fix round 1, M1):
 * turnCallRefusal, asked before a call that needs approval is queued, runs
 * the gate with `queue` in its context; the gate's item pre-check
 * (gate-prerun.ts) asks createFolderRefusal for the create's target folder.
 * file_create makes the missing folders of its path itself, so a new
 * subfolder of a folder the scope reads queues; a path with no folder the
 * scope reads is refused; a scope that holds Admin is not asked.
 *
 * The real gate, pre-check and folder check. The scope, the Admin view and
 * the folders the scope reads are stood in (no database).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  scope: null as null | Record<string, unknown>,
  holdsAdmin: false,
  folders: ['files.team'] as string[],
  asked: [] as string[][],
}));

vi.mock('../../db/src/viewer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/src/viewer')>();
  return {
    ...real,
    currentWorkspaceScope: () => h.scope ?? real.currentWorkspaceScope(),
    currentGateScope: () => null,
    asSystem: (fn: () => Promise<unknown>) => fn(),
  };
});
vi.mock('../../db/src/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/src/client')>();
  const viewer = await import('../../db/src/viewer');
  const chain = () => {
    const q: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'limit', 'orderBy', 'groupBy']) {
      q[m] = () => q;
    }
    q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
      Promise.resolve([]).then(ok, bad);
    return q;
  };
  return {
    ...real,
    db: { select: () => chain(), insert: () => ({ values: async () => [] }) },
    scopeHoldsAdmin: async () => h.holdsAdmin,
    scopeHasArea: async () => h.holdsAdmin,
    withTurnScope: (scope: never, fn: () => Promise<unknown>) => viewer.runInViewerScope(scope, fn),
  };
});
vi.mock('../../db/src/create-home', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createHomeIntent: async () => ({ createWs: null, privateWs: null }),
}));
vi.mock('../../db/src/item-rights', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  foldersReadOf: async (_owner: string, paths: readonly string[]) => {
    h.asked.push([...paths]);
    return new Set(paths.filter((p) => h.folders.includes(p)));
  },
}));

import { loginActor, runAsActor, type Tool } from '@mantle/db';
import { ensureGateReady, turnCallRefusal } from './index';

const OWNER = '99999999-9999-4999-8999-999999999999';
const LOGIN = '55555555-5555-4555-8555-555555555555';
const ADMIN_WS = '11111111-1111-4111-8111-111111111111';
const TEAM_WS = '22222222-2222-4222-8222-222222222222';

const fileCreate = {
  slug: 'file_create',
  ownerId: OWNER,
  handler: { kind: 'builtin', ref: 'file_create' },
  requiresConfirm: true,
  inputSchema: { type: 'object', properties: {} },
} as unknown as Tool;

/** turnCallRefusal of a file_create into `path`, for a member of the Team
 *  workspace (or, `admin`, a scope that holds Admin). */
function queueRefusal(path: string, admin = false): Promise<string | null> {
  h.scope = {
    kind: 'assistant',
    loginId: LOGIN,
    ws: admin ? [ADMIN_WS, TEAM_WS] : [TEAM_WS],
    modWs: [TEAM_WS],
  };
  h.holdsAdmin = admin;
  h.asked = [];
  return runAsActor(loginActor(LOGIN), () =>
    turnCallRefusal(
      fileCreate,
      { parent_path: path, filename: 'a.md', content: 'x' },
      { ownerId: OWNER, surface: { kind: 'web' } },
    ),
  ).finally(() => {
    h.scope = null;
  });
}

beforeAll(() => {
  ensureGateReady();
});

describe('a queued file_create, through the gate to the folder check (fix round 1, M1)', () => {
  it('a new subfolder under a folder of the scope queues', async () => {
    expect(await queueRefusal('files.team.reports')).toBeNull();
    // Asked: the pre-check reached the folder check, with the path's folders.
    expect(h.asked).toEqual([['files.team', 'files.team.reports']]);
  });

  it('a folder outside the scope is refused, never queued', async () => {
    expect(await queueRefusal('files.board.minutes')).toBe(
      'No folder on the path files.board.minutes is one in your workspaces, so this call is not queued for approval: put it in a folder of yours (folder_list / tree_list lists them).',
    );
  });

  it('a scope that holds Admin is not asked', async () => {
    expect(await queueRefusal('files.board.minutes', true)).toBeNull();
    expect(h.asked).toEqual([]);
  });
});
