/**
 * Items made from an email attachment (the extractor turns a spreadsheet
 * attachment into a Table, T4; pages and notes, A1) on the Tables, pages
 * and notes routes. Until W5b2 a key reached email only with the Search
 * area (access matrix M4). Since W5b2 a key acts exactly as its login
 * (contract change 25): its areas no longer narrow it, so a key without
 * Search lists, reads and writes them exactly as a session of its login
 * does. A key still never changes the content of an item others read (N3).
 * The lookup itself is pinned by
 * packages/files/src/email-attachments.db.test.ts.
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

describe('Tables, pages and notes routes and a key: the key acts as its login (W5b2)', () => {
  it('list a Table made from an attachment, in the query, for every key', async () => {
    const { GET } = await import('./route');
    const { listTables, countTables } = await import('@/lib/tables');
    const flag = () =>
      (vi.mocked(listTables).mock.calls.at(-1)![1] as { withoutEmailCopies?: boolean })
        .withoutEmailCopies;
    for (const grant of [key(['tables']), key(['tables', 'search']), key(null)]) {
      await as(grant, 'http://x/api/v1/tables', GET);
      expect(flag()).toBe(false);
      expect(
        (vi.mocked(countTables).mock.calls.at(-1)![1] as { withoutEmailCopies?: boolean })
          .withoutEmailCopies,
      ).toBe(false);
    }
    await as(undefined, 'http://x/api/tables', GET);
    expect(flag()).toBe(false);
  });

  it('serve a page or a note made from an attachment to a key, as to a session (A1)', async () => {
    const pages = await import('../pages/[id]/route');
    const notes = await import('../notes/[id]/route');
    for (const [GET, kind] of [
      [pages.GET, 'pages'],
      [notes.GET, 'notes'],
    ] as const) {
      const url = `http://x/api/v1/${kind}/${FROM_MAIL}`;
      const res = await as(key([kind]), url, (req) => GET(req, ctxOf(FROM_MAIL)));
      expect(res.status, kind).toBe(200);
    }
  });

  it('take a key write on one, through v1 and the inner routes (B1)', async () => {
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
      expect(res.status, `${method} ${kind}`).toBe(200);
    }
    expect(lib.pages.updatePage).toHaveBeenCalled();
    expect(lib.pages.deletePage).toHaveBeenCalled();
    expect(lib.notes.updateNote).toHaveBeenCalled();
    expect(lib.notes.deleteNote).toHaveBeenCalled();
    expect(lib.tables.updateTable).toHaveBeenCalled();
    expect(lib.tables.deleteTable).toHaveBeenCalled();
  });

  it('a key PATCH of the doc of a shared page is still 403 (N3), attachment or not', async () => {
    const v1Pages = await import('../v1/pages/[id]/route');
    const { othersCanRead } = await import('@mantle/mcp-core/shared-item');
    const { updatePage } = await import('@/lib/pages');
    vi.mocked(othersCanRead).mockResolvedValue(true);
    try {
      for (const id of [FROM_MAIL, PLAIN]) {
        const req = new Request(`http://x/api/v1/pages/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ doc: { type: 'doc', content: [] } }),
        });
        const res = await runWithRequestContext(
          { req, path: new URL(req.url).pathname, method: 'PATCH', accessKey: key(['pages']) },
          () => v1Pages.PATCH(req, ctxOf(id)),
        );
        expect(res.status, id).toBe(403);
        expect(await res.json()).toMatchObject({ reason: 'key-shared-item' });
      }
      expect(updatePage).not.toHaveBeenCalled();
    } finally {
      vi.mocked(othersCanRead).mockResolvedValue(false);
    }
  });

  it('serve a Table made from an attachment by id to a key, as to a session', async () => {
    const { GET } = await import('./[id]/route');
    const url = `http://x/api/v1/tables/${FROM_MAIL}`;
    for (const grant of [key(['tables']), undefined]) {
      const res = await as(grant, url, (req) => GET(req, ctxOf(FROM_MAIL)));
      expect(res.status).toBe(200);
    }
    const plain = await as(key(['tables']), `http://x/api/v1/tables/${PLAIN}`, (req) =>
      GET(req, ctxOf(PLAIN)),
    );
    expect(plain.status).toBe(200);
  });
});
