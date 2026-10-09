/**
 * A key reaches email only with the Search area (access matrix M4), and the
 * extractor turns a spreadsheet attachment into a Table (T4). So for a key
 * without Search the Tables routes (/api/v1/tables aliases them) leave such
 * a Table out of the list and answer 404 for it by id, its rows included. A
 * session and a key with Search see it as before. The lookup itself is
 * pinned by packages/files/src/email-attachments.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessKeyGrant } from '@/lib/access-keys';
import { runWithRequestContext } from '@/server/request-context';

const OWNER = '11111111-1111-4111-8111-111111111111';
const PLAIN = '22222222-2222-4222-8222-222222222222';
const FROM_MAIL = '33333333-3333-4333-8333-333333333333';

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({ id: OWNER })),
}));

vi.mock('@mantle/files', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emailAttachmentIds: vi.fn(
    async (_o: string, ids: string[]) => new Set(ids.filter((i) => i === FROM_MAIL)),
  ),
}));

const table = (id: string) => ({ id, title: id.slice(0, 4), updatedAt: '2026-10-01' });

vi.mock('@/lib/tables', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listTables: vi.fn(async () => [table(PLAIN), table(FROM_MAIL)]),
  countTables: vi.fn(async () => 2),
  listTableTags: vi.fn(async () => []),
  getTable: vi.fn(async (_o: string, id: string) => table(id)),
  updateTable: vi.fn(async (_o: string, id: string) => table(id)),
  deleteTable: vi.fn(async () => true),
}));

vi.mock('@/lib/pages', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPage: vi.fn(async (_o: string, id: string) => ({ id })),
  updatePage: vi.fn(async (_o: string, id: string) => ({ id, doc: { secret: true } })),
  deletePage: vi.fn(async () => true),
}));

const key = (areas: AccessKeyGrant['areas']) =>
  ({ id: 'k1', loginId: OWNER, access: 'read', areas }) as unknown as AccessKeyGrant;

vi.mock('@mantle/mcp-core/shared-item', () => ({ othersCanRead: vi.fn(async () => false) }));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSingleOwnerId: vi.fn(async () => OWNER),
}));

vi.mock('@/lib/notes', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getNote: vi.fn(async (_o: string, id: string) => ({ id })),
  updateNote: vi.fn(async (_o: string, id: string) => ({ id, content: 'x' })),
  deleteNote: vi.fn(async () => true),
}));

/** Run a write handler as the request the gate would hand it. */
function write<T>(
  grant: AccessKeyGrant | undefined,
  url: string,
  method: 'PATCH' | 'DELETE',
  fn: (req: Request) => Promise<T>,
) {
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'PATCH' ? { body: JSON.stringify({ title: 'Renamed' }) } : {}),
  });
  return runWithRequestContext(
    { req, path: new URL(url).pathname, method, ...(grant ? { accessKey: grant } : {}) },
    () => fn(req),
  );
}

function as<T>(grant: AccessKeyGrant | undefined, url: string, fn: (req: Request) => Promise<T>) {
  const req = new Request(url);
  return runWithRequestContext(
    { req, path: new URL(url).pathname, method: 'GET', ...(grant ? { accessKey: grant } : {}) },
    () => fn(req),
  );
}

const ctxOf = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => vi.clearAllMocks());

describe('Tables, pages and notes routes and a key without the Search area (T4)', () => {
  it('leave a Table made from an attachment out of the list, in the query', async () => {
    const { GET } = await import('./route');
    const { listTables, countTables } = await import('@/lib/tables');
    const flag = () =>
      (vi.mocked(listTables).mock.calls.at(-1)![1] as { withoutEmailCopies?: boolean })
        .withoutEmailCopies;
    await as(key(['tables']), 'http://x/api/v1/tables', GET);
    expect(flag()).toBe(true);
    expect(
      (vi.mocked(countTables).mock.calls.at(-1)![1] as { withoutEmailCopies?: boolean })
        .withoutEmailCopies,
    ).toBe(true);
    await as(key(['tables', 'search']), 'http://x/api/v1/tables', GET);
    expect(flag()).toBe(false);
    await as(undefined, 'http://x/api/tables', GET);
    expect(flag()).toBe(false);
  });

  it('answer 404 for a page or a note made from an attachment (A1)', async () => {
    const pages = await import('../pages/[id]/route');
    const notes = await import('../notes/[id]/route');
    for (const [GET, kind] of [
      [pages.GET, 'pages'],
      [notes.GET, 'notes'],
    ] as const) {
      const url = `http://x/api/v1/${kind}/${FROM_MAIL}`;
      const hidden = await as(key([kind]), url, (req) => GET(req, ctxOf(FROM_MAIL)));
      expect(hidden.status, kind).toBe(404);
    }
  });

  it('answer 404 to a write on one, through v1 and the inner routes (B1)', async () => {
    const v1Pages = await import('../v1/pages/[id]/route');
    const pages = await import('../pages/[id]/route');
    const notes = await import('../notes/[id]/route');
    const tables = await import('./[id]/route');
    const lib = {
      pages: await import('@/lib/pages'),
      notes: await import('@/lib/notes'),
      tables: await import('@/lib/tables'),
    };
    const cases = [
      ['pages', 'PATCH', v1Pages.PATCH],
      ['pages', 'PATCH', pages.PATCH],
      ['pages', 'DELETE', pages.DELETE],
      ['notes', 'PATCH', notes.PATCH],
      ['notes', 'DELETE', notes.DELETE],
      ['tables', 'PATCH', tables.PATCH],
      ['tables', 'DELETE', tables.DELETE],
    ] as const;
    for (const [kind, method, handler] of cases) {
      const url = `http://x/api/v1/${kind}/${FROM_MAIL}`;
      const res = await write(key([kind]), url, method, (req) => handler(req, ctxOf(FROM_MAIL)));
      expect(res.status, `${method} ${kind}`).toBe(404);
    }
    expect(lib.pages.updatePage).not.toHaveBeenCalled();
    expect(lib.pages.deletePage).not.toHaveBeenCalled();
    expect(lib.notes.updateNote).not.toHaveBeenCalled();
    expect(lib.notes.deleteNote).not.toHaveBeenCalled();
    expect(lib.tables.updateTable).not.toHaveBeenCalled();
    expect(lib.tables.deleteTable).not.toHaveBeenCalled();
    // An ordinary page is written as before.
    const plain = await write(key(['pages']), `http://x/api/v1/pages/${PLAIN}`, 'PATCH', (req) =>
      v1Pages.PATCH(req, ctxOf(PLAIN)),
    );
    expect(plain.status).toBe(200);
  });

  it('a key PATCH of a shared page made from an attachment is 404, not 403 (C1)', async () => {
    const v1Pages = await import('../v1/pages/[id]/route');
    const { othersCanRead } = await import('@mantle/mcp-core/shared-item');
    vi.mocked(othersCanRead).mockResolvedValue(true);
    const req = new Request(`http://x/api/v1/pages/${FROM_MAIL}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc: { type: 'doc', content: [] } }),
    });
    const res = await runWithRequestContext(
      { req, path: new URL(req.url).pathname, method: 'PATCH', accessKey: key(['pages']) },
      () => v1Pages.PATCH(req, ctxOf(FROM_MAIL)),
    );
    expect(res.status).toBe(404);
  });

  it('answer 404 for it by id, and serve an ordinary Table', async () => {
    const { GET } = await import('./[id]/route');
    const url = `http://x/api/v1/tables/${FROM_MAIL}`;
    const hidden = await as(key(['tables']), url, (req) => GET(req, ctxOf(FROM_MAIL)));
    expect(hidden.status).toBe(404);
    const plain = await as(key(['tables']), `http://x/api/v1/tables/${PLAIN}`, (req) =>
      GET(req, ctxOf(PLAIN)),
    );
    expect(plain.status).toBe(200);
    const session = await as(undefined, url, (req) => GET(req, ctxOf(FROM_MAIL)));
    expect(session.status).toBe(200);
  });
});
