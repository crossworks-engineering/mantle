/**
 * Email attachments on the Files routes (/api/v1/files aliases them). Until
 * W5b2 a key reached email only with the Search area (access matrix M4).
 * Since W5b2 a key acts exactly as its login (contract change 25): its areas
 * no longer narrow it, so a key limited to Files lists, opens and uploads
 * into attachments exactly as a session of its login does. The lookup
 * itself is pinned by packages/files/src/email-attachments.db.test.ts.
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
  reachesEmailAttachment: vi.fn(
    async (_o: string, ref: { path?: string }) => ref.path === 'inbox.a.attachments',
  ),
  emailAttachmentIds: vi.fn(
    async (_o: string, ids: string[]) => new Set(ids.filter((i) => i === MAIL)),
  ),
}));

vi.mock('@mantle/content/tree', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guardNewFileIn: vi.fn(async () => ({ changes: [], total: 0 })),
}));

vi.mock('@/lib/files', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureFilesRootBranch: vi.fn(async () => {}),
  upsertFile: vi.fn(async () => ({ id: PLAIN, filename: 'a.md', mimeType: 'text/markdown' })),
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

describe('Files routes and a key: the key acts as its login (W5b2)', () => {
  const grants = [undefined, key(['files']), key(null), key(['files', 'search'])];

  it('list attachments in the recent list and a folder list, as a session does', async () => {
    const { GET } = await import('./files/route');
    for (const grant of grants) {
      expect(await ids(await as(grant, 'http://x/api/v1/files?recent=1', GET))).toEqual([
        PLAIN,
        MAIL,
      ]);
      expect(await ids(await as(grant, 'http://x/api/v1/files?parent=inbox.a', GET))).toEqual([
        PLAIN,
        MAIL,
      ]);
    }
  });

  it('serve an attachment by id, metadata and bytes, as a session does', async () => {
    const { GET } = await import('./files/[id]/route');
    for (const grant of grants) {
      for (const url of [`http://x/api/v1/files/${MAIL}`, `http://x/api/v1/files/${MAIL}?raw=1`]) {
        const res = await as(grant, url, (r) => GET(r, ctxOf(MAIL)));
        expect(res.status, url).toBe(200);
      }
    }
  });

  it('take an upload into an attachments folder, as a session does', async () => {
    const { POST } = await import('./files/route');
    const post = (grant: AccessKeyGrant | undefined, parentPath: string) => {
      const url = 'http://x/api/v1/files';
      const req = new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parentPath, filename: 'a.md', content: 'x' }),
      });
      return runWithRequestContext(
        { req, path: '/api/v1/files', method: 'POST', ...(grant ? { accessKey: grant } : {}) },
        () => POST(req),
      );
    };
    for (const grant of grants) {
      expect((await post(grant, 'inbox.a.attachments')).status).toBe(200);
      expect((await post(grant, 'files.work')).status).toBe(200);
    }
  });
});
