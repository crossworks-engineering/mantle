/**
 * The caching headers of a file's bytes (workspaces W7e fix round 1, L2).
 * Since W7e the bytes are read in the login's scope, for every login, so a
 * browser or a shared cache must not keep what a login read once and may
 * not read now:
 *
 *  - raw bytes (GET /api/files/files/:id?raw=1; the member route is gone
 *    since W8d): `private, no-store`;
 *  - a thumbnail (?thumb=1, its 200 and its 304): `private, no-cache`, so
 *    the browser revalidates every use and the scoped lookup runs first.
 *
 * No database: the gates, the file reads and the thumbnailer are stood in.
 */
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '11111111-1111-4111-8111-111111111111';
const FILE = '22222222-2222-4222-8222-222222222222';
const SHA = 'abc123';

const h = vi.hoisted(() => ({ member: false }));

const memberCaller = {
  role: 'member',
  loginId: '33333333-3333-4333-8333-333333333333',
  anchorId: '11111111-1111-4111-8111-111111111111',
  email: 'm@example.invalid',
  displayName: 'M',
  contactId: null,
};

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The asset reader the pipeline answers (A4 hand batch B).
  readerAssetCaller: vi.fn(() => ({
    user: { id: OWNER },
    member: h.member ? memberCaller : null,
  })),
  memberAssetCaller: vi.fn(() => memberCaller),
}));
vi.mock('@/lib/member-space', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  memberBytesGate: vi.fn(() => null),
}));
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withViewer: vi.fn(async (_o: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@mantle/files', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emailAttachmentIds: vi.fn(async () => new Set<string>()),
  thumbnailFor: vi.fn(async () => Buffer.from('JPEG')),
}));
const fileRow = {
  id: FILE,
  filename: 'a.png',
  mimeType: 'image/png',
  sha256: SHA,
};
vi.mock('@/lib/files', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fileById: vi.fn(async () => fileRow),
  readFileById: vi.fn(async () => ({ row: fileRow, bytes: Buffer.from('PNGBYTES') })),
  openFileById: vi.fn(async () => ({
    row: fileRow,
    size: 8,
    stream: Readable.from([Buffer.from('PNGBYTES')]),
  })),
}));

const ctx = () => ({ params: Promise.resolve({ id: FILE }) });
const req = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://brain.example.invalid${path}`, { headers });

beforeEach(() => {
  h.member = false;
});

describe('the cache headers of file bytes (W7e fix round 1, L2)', () => {
  it.each([false, true])(
    'GET /api/files/files/:id?raw=1 is private, no-store (member: %s)',
    async (member) => {
      h.member = member;
      const { GET } = await import('./files/[id]/route');
      const res = await GET(req(`/api/files/files/${FILE}?raw=1`), ctx());
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    },
  );

  it.each([false, true])(
    'a thumbnail is private, no-cache, its 304 too (member: %s)',
    async (member) => {
      h.member = member;
      const { GET } = await import('./files/[id]/route');
      const res = await GET(req(`/api/files/files/${FILE}?thumb=1`), ctx());
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-cache');
      const again = await GET(
        req(`/api/files/files/${FILE}?thumb=1`, { 'if-none-match': `"${SHA}.thumb"` }),
        ctx(),
      );
      expect(again.status).toBe(304);
      expect(again.headers.get('cache-control')).toBe('private, no-cache');
    },
  );
});
