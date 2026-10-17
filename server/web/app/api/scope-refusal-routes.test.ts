/**
 * W6a fix round 2 (L-a): a create the workspace checks refuse (42501 with
 * their own message, isScopeWriteRefusal) leaves the route's catch as it
 * came, so app.onError answers 403 item-workspace (w6a-fix-sweep.db.test.ts
 * proves the answer through the app). Since A10 part 2 (fold 2) any other
 * error leaves it too: app.onError answers it (the one table, or the
 * opaque 500).
 * Since W7e the item routes too: a file rename, a folder rename, a contact,
 * an event, a journal entry and a gap answer. The session and the writers
 * are stood in.
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
  // The reader a converted handler calls (A4 step 3b): the same stand-in.
  ownerCaller: vi.fn(() => ({
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
  updateFormula: async () => {
    throw h.fail;
  },
}));

vi.mock('@/lib/files', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureFilesRootBranch: async () => undefined,
  // A file or folder write reads the item in the caller's scope first
  // (pre-check removal part 2): stood in as one it reads, so the write runs.
  fileById: async () => ({ id: '00000000-0000-4000-8000-0000000000aa' }),
  folderById: async () => ({ id: '00000000-0000-4000-8000-0000000000aa' }),
  createFolder: async () => {
    throw h.fail;
  },
  upsertFile: async () => {
    throw h.fail;
  },
  renameFileById: async () => {
    throw h.fail;
  },
  renameFolderById: async () => {
    throw h.fail;
  },
}));

vi.mock('@/lib/contacts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateContact: async () => {
    throw h.fail;
  },
}));

vi.mock('@/lib/events', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateEvent: async () => {
    throw h.fail;
  },
}));

vi.mock('@/lib/journal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateJournal: async () => {
    throw h.fail;
  },
  resolveGapEntry: async () => {
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

const patch = (url: string, body: unknown) =>
  new Request(`http://brain.example${url}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const ID = '00000000-0000-4000-8000-0000000000aa';
const params = { params: Promise.resolve({ id: ID }) };

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
  // W7e: the item routes.
  {
    name: 'PATCH /api/files/files/:id (rename)',
    run: async () =>
      (await import('./files/files/[id]/route')).PATCH(
        patch(`/api/files/files/${ID}`, { rename: 'other' }),
        params,
      ),
  },
  {
    name: 'PATCH /api/files/folders/:id (rename)',
    run: async () =>
      (await import('./files/folders/[id]/route')).PATCH(
        patch(`/api/files/folders/${ID}`, { rename: 'other' }),
        params,
      ),
  },
  {
    name: 'PATCH /api/contacts/:id',
    run: async () =>
      (await import('./contacts/[id]/route')).PATCH(
        patch(`/api/contacts/${ID}`, { company: 'x' }),
        params,
      ),
  },
  // A1 fix round (L4): a formula edit, open to every login since D1.
  {
    name: 'PATCH /api/formulas/:id',
    run: async () =>
      (await import('./formulas/[id]/route')).PATCH(
        patch(`/api/formulas/${ID}`, { title: 'x' }),
        params,
      ),
  },
  {
    name: 'PATCH /api/events/:id',
    run: async () =>
      (await import('./events/[id]/route')).PATCH(
        patch(`/api/events/${ID}`, { title: 'x' }),
        params,
      ),
  },
  {
    name: 'PATCH /api/journal/:id',
    run: async () =>
      (await import('./journal/[id]/route')).PATCH(
        patch(`/api/journal/${ID}`, { body: 'x' }),
        params,
      ),
  },
  {
    name: 'POST /api/journal/:id/resolve',
    run: async () =>
      (await import('./journal/[id]/resolve/route')).POST(
        post(`/api/journal/${ID}/resolve`, { answer: 'x' }),
        params,
      ),
  },
];

beforeEach(() => {
  h.fail = null;
});

describe('a workspace refusal leaves the create and item routes for app.onError (403)', () => {
  it.each(cases)('$name: rethrows the refusal', async ({ run }) => {
    const refusal = pgError('not allowed to add items to that folder', '42501');
    h.fail = refusal;
    await expect(run()).rejects.toBe(refusal);
  });

  // A10 part 2, fold 2: the route's hand catch is gone. Any other error
  // leaves the route as it came too: app.onError answers a domain error
  // by the one table (an InputError's 400 and its text) and anything else
  // with the opaque 500, never the error's text.
  it.each(cases)('$name: another error leaves the route for app.onError', async ({ run }) => {
    const other = new Error('something else went wrong');
    h.fail = other;
    await expect(run()).rejects.toBe(other);
  });

  it.each(cases)(
    '$name: a missing grant (42501, another message) leaves the route too',
    async ({ run }) => {
      const gap = pgError('permission denied for table nodes', '42501');
      h.fail = gap;
      await expect(run()).rejects.toBe(gap);
    },
  );
});
