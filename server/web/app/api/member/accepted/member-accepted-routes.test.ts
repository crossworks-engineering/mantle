/**
 * The member byte routes (member logins Phase 1, deprecated since
 * workspaces W7e) and the removed Library and accepted-item routes, without
 * a database: the lookups are stood in, so these pin what the ROUTES do. A
 * member's file or drawing is read in its own scope only (W7e: no accepted
 * item read on the admin pool any more); /api/member/library* and
 * /api/member/accepted* answer 410. The scope itself is proven on Postgres
 * in server/web/server/w7e-member-scope.db.test.ts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const LOGIN = '22222222-2222-4222-8222-222222222222';
const SPACE = '66666666-6666-4666-8666-666666666666';
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
  spaceId: SPACE,
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

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

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

describe('GET /api/member/files/:id', () => {
  it('serves a file the member reads, in its own scope only', async () => {
    h.teamHit = true;
    const { GET } = await import('../files/[id]/route');
    const res = await GET(new Request(`http://x/api/member/files/${FILE}`), ctx(FILE));
    expect(res.status).toBe(200);
    expect(h.reads).toEqual(['team']);
  });

  it('streams the bytes (never buffers the whole file) with the same headers', async () => {
    h.teamHit = true;
    const { GET } = await import('../files/[id]/route');
    const res = await GET(new Request(`http://x/api/member/files/${FILE}`), ctx(FILE));
    expect(res.status).toBe(200);
    expect(h.byteReads).toEqual(['streamed']);
    expect(res.headers.get('content-length')).toBe('5');
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-disposition')).toContain('a.txt');
    expect(await res.text()).toBe('BYTES');
  });

  it('is rate limited per login, before any file is opened', async () => {
    const { GET } = await import('../files/[id]/route');
    const { MEMBER_BYTES_PER_MIN } = await import('@/lib/member-space');
    const auth = await import('@/lib/auth');
    // A login of its own, so the other tests' requests do not share the budget.
    vi.mocked(auth.getMemberForAsset).mockImplementation(async () => ({
      ...member,
      loginId: '77777777-7777-4777-8777-777777777777',
    }));
    try {
      h.teamHit = true;
      let limited: Response | null = null;
      let served = 0;
      for (let i = 0; i <= MEMBER_BYTES_PER_MIN && !limited; i += 1) {
        const res = await GET(new Request(`http://x/api/member/files/${FILE}`), ctx(FILE));
        if (res.status === 429) limited = res;
        else served += 1;
      }
      expect(served).toBe(MEMBER_BYTES_PER_MIN);
      expect(limited?.headers.get('retry-after')).toMatch(/^\d+$/);
      // The refused request opened nothing.
      expect(h.byteReads).toHaveLength(served);
    } finally {
      vi.mocked(auth.getMemberForAsset).mockImplementation(async () => member);
    }
  });

  it('is a 404 for a file it does not read: no accepted-file read on the admin pool (W7e)', async () => {
    const { GET } = await import('../files/[id]/route');
    const res = await GET(new Request(`http://x/api/member/files/${FILE}`), ctx(FILE));
    expect(res.status).toBe(404);
    expect(h.reads).toEqual(['team']);
  });
});

describe('GET /api/member/draws/:id/svg', () => {
  it('reads the drawing in the member scope and sends only what the image filter leaves', async () => {
    h.drawHit = true;
    const { GET } = await import('../draws/[id]/svg/route');
    const res = await GET(new Request(`http://x/api/member/draws/${FILE}/svg`), ctx(FILE));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<svg>images the member may see</svg>');
    expect(h.reads).toEqual(['team']);
    expect(h.svgFilters).toEqual([[ANCHOR, FILE, '<svg>saved</svg>']]);
  });

  it('is a 404 for a drawing it does not read: no accepted snapshot is tried (W7e)', async () => {
    const { GET } = await import('../draws/[id]/svg/route');
    const res = await GET(new Request(`http://x/api/member/draws/${FILE}/svg`), ctx(FILE));
    expect(res.status).toBe(404);
    expect(h.reads).toEqual(['team']);
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
