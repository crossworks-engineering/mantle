/**
 * The member routes for accepted items (member logins Phase 4, plan 6.2),
 * without a database: the lookups are stood in, so these pin what the ROUTES
 * do with them. A member's file or drawing is read at the team level first
 * and, only when that misses AND the author check says yes, on the admin
 * pool; the accepted routes pass this member's own login and brain; the
 * Library carries the author's name. The rules themselves are proven on
 * Postgres in packages/content/src/member-accepted.viewer.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const LOGIN = '22222222-2222-4222-8222-222222222222';
const SPACE = '66666666-6666-4666-8666-666666666666';
const FILE = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({
  teamHit: false,
  isAuthor: false,
  authorChecks: [] as Array<{ anchor: string; login: string; id: string }>,
  reads: [] as string[],
  byteReads: [] as string[],
  accepted: null as unknown,
  acceptedCalls: [] as unknown[][],
  drawSteps: [] as string[],
}));

const member = {
  role: 'member',
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

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The space and team-drafts scopes open a transaction; here they only run.
  withSpace: vi.fn(async (_s: unknown, fn: () => Promise<unknown>) => {
    h.drawSteps.push('space');
    return fn();
  }),
  withTeamDrafts: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

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
  isAuthorOfAcceptedFile: vi.fn(async (anchor: string, login: string, id: string) => {
    h.authorChecks.push({ anchor, login, id });
    return h.isAuthor;
  }),
  getDrawSvg: vi.fn(async () => (h.drawSteps.push('team'), null)),
  getTeamDraftDrawSvg: vi.fn(async () => (h.drawSteps.push('team-drafts'), null)),
  acceptedDrawSvg: vi.fn(async (anchor: string, login: string) => {
    h.drawSteps.push(`accepted:${anchor}:${login}`);
    return '<svg>ok</svg>';
  }),
  listAccepted: vi.fn(async (...args: unknown[]) => {
    h.acceptedCalls.push(args);
    return { items: [], total: 0 };
  }),
  getAcceptedItem: vi.fn(async (...args: unknown[]) => {
    h.acceptedCalls.push(args);
    return h.accepted;
  }),
  listLibrary: vi.fn(async () => ({
    items: [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ],
    total: 2,
  })),
  getLibraryItem: vi.fn(async () => ({ id: 'a', title: 'A', type: 'note', content: 'x' })),
  acceptedAuthors: vi.fn(
    async () => new Map([['a', { name: 'Ann Author', acceptedAt: '2026-09-27T00:00:00.000Z' }]]),
  ),
}));

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  h.teamHit = false;
  h.isAuthor = false;
  h.authorChecks = [];
  h.reads = [];
  h.byteReads = [];
  h.accepted = null;
  h.acceptedCalls = [];
  h.drawSteps = [];
});

describe('GET /api/member/files/:id', () => {
  it('serves a team-level file without asking about authorship', async () => {
    h.teamHit = true;
    const { GET } = await import('../files/[id]/route');
    const res = await GET(new Request(`http://x/api/member/files/${FILE}`), ctx(FILE));
    expect(res.status).toBe(200);
    expect(h.authorChecks).toEqual([]);
    expect(h.reads).toEqual(['team']);
  });

  it('serves the author their accepted file from the brain when the team level misses', async () => {
    h.isAuthor = true;
    const { GET } = await import('../files/[id]/route');
    const res = await GET(new Request(`http://x/api/member/files/${FILE}`), ctx(FILE));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('BYTES');
    expect(h.authorChecks).toEqual([{ anchor: ANCHOR, login: LOGIN, id: FILE }]);
    expect(h.reads).toEqual(['team', 'admin']);
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

  it('is a 404 for anyone else: never reads on the admin pool', async () => {
    const { GET } = await import('../files/[id]/route');
    const res = await GET(new Request(`http://x/api/member/files/${FILE}`), ctx(FILE));
    expect(res.status).toBe(404);
    expect(h.reads).toEqual(['team']);
  });
});

describe('GET /api/member/draws/:id/svg', () => {
  it('tries the author’s accepted drawing last, with this member’s own login', async () => {
    const { GET } = await import('../draws/[id]/svg/route');
    const res = await GET(new Request(`http://x/api/member/draws/${FILE}/svg`), ctx(FILE));
    expect(res.status).toBe(200);
    expect(h.drawSteps.at(-1)).toBe(`accepted:${ANCHOR}:${LOGIN}`);
    expect(h.drawSteps.indexOf(`accepted:${ANCHOR}:${LOGIN}`)).toBeGreaterThan(0);
  });
});

describe('GET /api/member/accepted[/:id]', () => {
  it('lists with this member’s own brain and login, paged', async () => {
    const { GET } = await import('./route');
    const res = await GET(new Request('http://x/api/member/accepted?kind=page&q=plan&page=2'));
    expect(res.status).toBe(200);
    expect(h.acceptedCalls[0]).toEqual([
      ANCHOR,
      LOGIN,
      { kind: 'page', q: 'plan', limit: 50, offset: 50 },
    ]);
    expect(await res.json()).toMatchObject({ page: 2, pageSize: 50 });
  });

  it('refuses a bad kind', async () => {
    const { GET } = await import('./route');
    const res = await GET(new Request('http://x/api/member/accepted?kind=task'));
    expect(res.status).toBe(400);
  });

  it('reads one with this member’s own login; not theirs is a 404', async () => {
    const { GET } = await import('./[id]/route');
    const res = await GET(new Request(`http://x/api/member/accepted/${FILE}`), ctx(FILE));
    expect(res.status).toBe(404);
    expect(h.acceptedCalls[0]).toEqual([ANCHOR, LOGIN, FILE, {}]);
    h.accepted = { id: FILE, type: 'note', content: 'x' };
    const ok = await GET(new Request(`http://x/api/member/accepted/${FILE}?tab=t1`), ctx(FILE));
    expect(await ok.json()).toEqual({ item: h.accepted });
    expect(h.acceptedCalls[1]).toEqual([ANCHOR, LOGIN, FILE, { tabId: 't1' }]);
    const bad = await GET(new Request('http://x/api/member/accepted/nope'), ctx('nope'));
    expect(bad.status).toBe(400);
  });
});

describe('the Library carries the author of an accepted item', () => {
  it('on each row, null where there is none', async () => {
    const { GET } = await import('../library/route');
    const body = await (await GET(new Request('http://x/api/member/library'))).json();
    expect(body.items).toEqual([
      {
        id: 'a',
        title: 'A',
        author: { name: 'Ann Author', acceptedAt: '2026-09-27T00:00:00.000Z' },
      },
      { id: 'b', title: 'B', author: null },
    ]);
  });

  it('on the item', async () => {
    const { GET } = await import('../library/[id]/route');
    const res = await GET(new Request(`http://x/api/member/library/${FILE}`), ctx(FILE));
    expect((await res.json()).item.author).toMatchObject({ name: 'Ann Author' });
  });
});
