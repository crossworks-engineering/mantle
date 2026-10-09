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
}));

vi.mock('@/lib/pages', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPage: vi.fn(async (_o: string, id: string) => ({ id })),
}));

const key = (areas: AccessKeyGrant['areas']) =>
  ({ id: 'k1', loginId: OWNER, access: 'read', areas }) as unknown as AccessKeyGrant;

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
