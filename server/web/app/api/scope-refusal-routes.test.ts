/**
 * W6a fix round 2 (L-a): a create the workspace checks refuse (42501 with
 * their own message, isScopeWriteRefusal) leaves the route's catch as it
 * came, so app.onError answers 403 item-workspace (w6a-fix-sweep.db.test.ts
 * proves the answer through the app); any other error keeps the route's 400.
 * The session and the writers are stood in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '00000000-0000-4000-8000-000000000001';

const h = vi.hoisted(() => ({ fail: null as unknown }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: OWNER,
    actor: { id: OWNER, displayName: 'Admin' },
  })),
}));

vi.mock('@/lib/api-v1', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callerMayConfirm: () => true,
  callerMayReadEmail: () => true,
}));

vi.mock('@/lib/formulas', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createFormula: async () => {
    throw h.fail;
  },
}));

vi.mock('@/lib/files', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureFilesRootBranch: async () => undefined,
  createFolder: async () => {
    throw h.fail;
  },
  upsertFile: async () => {
    throw h.fail;
  },
}));

vi.mock('@mantle/content/tree', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guardNewFileIn: async () => undefined,
}));

/** What drizzle throws for a refused statement: the driver error as cause. */
const pgError = (message: string, code: string) =>
  Object.assign(new Error('Failed query: insert into "nodes" ...'), {
    cause: Object.assign(new Error(message), { code }),
  });

const post = (url: string, body: unknown) =>
  new Request(`http://brain.example${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

type Case = { name: string; run: () => Promise<Response> };

const cases: Case[] = [
  {
    name: 'POST /api/formulas',
    run: async () =>
      (await import('./formulas/route')).POST(post('/api/formulas', { spec: { id: 'f' } })),
  },
  {
    name: 'POST /api/files/folders',
    run: async () =>
      (await import('./files/folders/route')).POST(
        post('/api/files/folders', { parentPath: 'files.side', slug: 'inner' }),
      ),
  },
  {
    name: 'POST /api/files/files (text)',
    run: async () =>
      (await import('./files/files/route')).POST(
        post('/api/files/files', { parentPath: 'files.side', filename: 'a.txt', content: 'x' }),
      ),
  },
];

beforeEach(() => {
  h.fail = null;
});

describe('a workspace refusal leaves the create routes for app.onError (403)', () => {
  it.each(cases)('$name: rethrows the refusal', async ({ run }) => {
    const refusal = pgError('not allowed to add items to that folder', '42501');
    h.fail = refusal;
    await expect(run()).rejects.toBe(refusal);
  });

  it.each(cases)('$name: another error keeps its 400', async ({ run }) => {
    h.fail = new Error('something else went wrong');
    const res = await run();
    expect(res.status).toBe(400);
  });

  it.each(cases)(
    '$name: a missing grant (42501, another message) is not a refusal',
    async ({ run }) => {
      h.fail = pgError('permission denied for table nodes', '42501');
      const res = await run();
      expect(res.status).toBe(400);
    },
  );
});
