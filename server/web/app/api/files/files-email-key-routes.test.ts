/**
 * A key reaches email only with the Search area (access matrix M4). The
 * attachments of synced mail are file nodes, so for a key limited to Files
 * the Files routes (/api/v1/files aliases them) leave them out of the
 * recent list and a folder list, and answer 404 for one by id, its bytes
 * included. A session, an all-areas key and a key with Search see them as
 * before. The lookup itself is pinned by
 * packages/files/src/email-attachments.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessKeyGrant } from '@/lib/access-keys';
import { runWithRequestContext } from '@/server/request-context';

const OWNER = '11111111-1111-4111-8111-111111111111';
const PLAIN = '22222222-2222-4222-8222-222222222222';
const MAIL = '33333333-3333-4333-8333-333333333333';

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({ id: OWNER })),
  getOwnerForAsset: vi.fn(async () => ({ id: OWNER })),
}));

const row = (id: string) => ({ id, filename: `${id.slice(0, 4)}.pdf`, updatedAt: '2026-10-01' });

vi.mock('@mantle/files', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emailAttachmentIds: vi.fn(
    async (_o: string, ids: string[]) => new Set(ids.filter((i) => i === MAIL)),
  ),
}));

vi.mock('@/lib/files', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureFilesRootBranch: vi.fn(async () => {}),
  listRecentFiles: vi.fn(async () => [row(PLAIN), row(MAIL)]),
  listFiles: vi.fn(async () => [row(PLAIN), row(MAIL)]),
  fileById: vi.fn(async ({ fileId }: { fileId: string }) => row(fileId)),
  readFileById: vi.fn(async ({ fileId }: { fileId: string }) => ({
    row: { ...row(fileId), mimeType: 'application/pdf' },
    bytes: Buffer.from('%PDF'),
  })),
}));

const key = (areas: AccessKeyGrant['areas']) =>
  ({ id: 'k1', loginId: OWNER, access: 'read', areas }) as unknown as AccessKeyGrant;

/** Run a handler as the request the gate would hand it. */
function as<T>(grant: AccessKeyGrant | undefined, url: string, fn: (req: Request) => Promise<T>) {
  const req = new Request(url);
  return runWithRequestContext(
    { req, path: new URL(url).pathname, method: 'GET', ...(grant ? { accessKey: grant } : {}) },
    () => fn(req),
  );
}

const ctxOf = (id: string) => ({ params: Promise.resolve({ id }) });

async function ids(res: Response): Promise<string[]> {
  return ((await res.json()) as { files: { id: string }[] }).files.map((f) => f.id);
}

beforeEach(() => vi.clearAllMocks());

describe('Files routes and a key without the Search area', () => {
  it('leave attachments out of the recent list and a folder list', async () => {
    const { GET } = await import('./files/route');
    const filesOnly = key(['files']);
    expect(await ids(await as(filesOnly, 'http://x/api/v1/files?recent=1', GET))).toEqual([PLAIN]);
    expect(await ids(await as(filesOnly, 'http://x/api/v1/files?parent=inbox.a', GET))).toEqual([
      PLAIN,
    ]);
  });

  it('answer 404 for an attachment by id, metadata and bytes', async () => {
    const { GET } = await import('./files/[id]/route');
    const filesOnly = key(['files']);
    const meta = await as(filesOnly, `http://x/api/v1/files/${MAIL}`, (r) => GET(r, ctxOf(MAIL)));
    expect(meta.status).toBe(404);
    const raw = await as(filesOnly, `http://x/api/v1/files/${MAIL}?raw=1`, (r) =>
      GET(r, ctxOf(MAIL)),
    );
    expect(raw.status).toBe(404);
    const plain = await as(filesOnly, `http://x/api/v1/files/${PLAIN}?raw=1`, (r) =>
      GET(r, ctxOf(PLAIN)),
    );
    expect(plain.status).toBe(200);
  });

  it('leave a session, an all-areas key and a Search key as before', async () => {
    const list = (await import('./files/route')).GET;
    const one = (await import('./files/[id]/route')).GET;
    for (const grant of [undefined, key(null), key(['files', 'search'])]) {
      expect(await ids(await as(grant, 'http://x/api/v1/files?recent=1', list))).toEqual([
        PLAIN,
        MAIL,
      ]);
      const res = await as(grant, `http://x/api/v1/files/${MAIL}?raw=1`, (r) =>
        one(r, ctxOf(MAIL)),
      );
      expect(res.status).toBe(200);
    }
  });
});
