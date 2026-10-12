/**
 * The removed member byte routes (member logins Phase 1, deprecated since
 * workspaces W7e, 410 since W8d) and the removed Library and accepted-item
 * routes (410 since W7e), without a database: the lookups are stood in, so
 * these pin that the ROUTES read nothing. Every login reads bytes on
 * /api/files/files/:id and /api/draws/:id/svg in its own scope, proven on
 * Postgres in server/web/server/w7e-member-scope.db.test.ts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const LOGIN = '22222222-2222-4222-8222-222222222222';
const FILE = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({
  teamHit: false,
  drawHit: false,
  reads: [] as string[],
  byteReads: [] as string[],
  svgFilters: [] as unknown[][],
}));

const member = {
  role: 'member' as const,
  loginId: LOGIN,
  anchorId: ANCHOR,
  email: 'pat@example.invalid',
  displayName: 'Pat',
  contactId: null,
};

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMemberOr401: vi.fn(async () => member),
  getMemberForAsset: vi.fn(async () => member),
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  return {
    ...actual,
    // The R6 shim reads the login's workspaces on the admin pool; here it
    // runs `fn` at the level asked, so the stubs see who reads.
    withViewer: vi.fn(
      async (
        level: Parameters<typeof actual.runInLevelRoleForTest>[0],
        _for: unknown,
        fn: () => Promise<unknown>,
      ) => actual.runInLevelRoleForTest(level, fn),
    ),
  };
});

vi.mock('@/lib/files', async () => {
  const { currentViewerLevel } = await import('@mantle/db');
  const hit = () => {
    const level = currentViewerLevel();
    h.reads.push(level);
    return level === 'team' ? h.teamHit : true;
  };
  return {
    fileById: vi.fn(async () =>
      hit() ? { sha256: 'abc', mimeType: 'text/plain', filename: 'a.txt' } : null,
    ),
    readFileById: vi.fn(async () => {
      h.byteReads.push('buffered');
      return hit()
        ? { bytes: Buffer.from('BYTES'), row: { mimeType: 'text/plain', filename: 'a.txt' } }
        : null;
    }),
    openFileById: vi.fn(async () => {
      h.byteReads.push('streamed');
      const { Readable } = await import('node:stream');
      return hit()
        ? {
            stream: Readable.from([Buffer.from('BYT'), Buffer.from('ES')]),
            size: 5,
            row: { mimeType: 'text/plain', filename: 'a.txt' },
          }
        : null;
    }),
  };
});

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDrawSvg: vi.fn(async () => {
    const { currentViewerLevel } = await import('@mantle/db');
    h.reads.push(currentViewerLevel());
    return h.drawHit ? '<svg>saved</svg>' : null;
  }),
  scopedDrawSvg: vi.fn(async (...args: unknown[]) => {
    h.svgFilters.push(args);
    return '<svg>images the member may see</svg>';
  }),
}));

// The first import of each route compiles its graph; under a loaded run
// that alone can pass a test's timeout, so it happens here, once. One at a
// time: parallel first imports raced the async `@/lib/auth` mock factory in
// CI, and a route got the real module (v0.232.346's failed release run).
beforeAll(async () => {
  await import('../files/[id]/route');
  await import('../draws/[id]/svg/route');
  await import('./route');
  await import('./[id]/route');
  await import('../library/route');
  await import('../library/[id]/route');
}, 60_000);

beforeEach(() => {
  h.teamHit = false;
  h.drawHit = false;
  h.reads = [];
  h.byteReads = [];
  h.svgFilters = [];
});

describe('the member byte routes are gone (W8d)', () => {
  it('GET /api/member/files/:id answers 410 to a member and opens nothing', async () => {
    h.teamHit = true;
    const { GET } = await import('../files/[id]/route');
    const res = await GET(new Request(`http://x/api/member/files/${FILE}`));
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: 'gone' });
    expect(h.reads).toEqual([]);
    expect(h.byteReads).toEqual([]);
  });

  it('GET /api/member/draws/:id/svg answers 410 to a member and reads nothing', async () => {
    h.drawHit = true;
    const { GET } = await import('../draws/[id]/svg/route');
    const res = await GET(new Request(`http://x/api/member/draws/${FILE}/svg`));
    expect(res.status).toBe(410);
    expect(h.reads).toEqual([]);
    expect(h.svgFilters).toEqual([]);
  });
});

describe('the Library and accepted-item routes are gone (W7e)', () => {
  it('answer 410 code gone to a member', async () => {
    const routes = [
      (await import('./route')).GET,
      (await import('./[id]/route')).GET,
      (await import('../library/route')).GET,
      (await import('../library/[id]/route')).GET,
    ];
    for (const GET of routes) {
      const res = await GET();
      expect(res.status).toBe(410);
      expect(((await res.json()) as { code: string }).code).toBe('gone');
    }
  });
});
