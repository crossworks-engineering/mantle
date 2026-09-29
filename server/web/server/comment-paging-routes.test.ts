/**
 * Thread paging on the member, admin and owner comment routes (client
 * logins C5 audit, I2) without a database: every thread GET reads ONE page
 * (the newest, or the one before `?before=`) and answers `hasMore`; a
 * `before` that is not an ISO time is a 400 before any read. The client
 * routes are pinned in app/api/client/space/client-space-routes.test.ts;
 * the paging itself on Postgres in
 * packages/content/src/client-abuse.viewer.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const ACTOR = '55555555-5555-4555-8555-555555555555';
const MEMBER = '44444444-4444-4444-8444-444444444444';
const SPACE = '66666666-6666-4666-8666-666666666666';
const ITEM = '77777777-7777-4777-8777-777777777777';
const BEFORE = '2026-09-01T10:00:00.123Z';

const h = vi.hoisted(() => ({ calls: [] as Array<[string, unknown[]]> }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: ANCHOR,
    email: 'admin@example.invalid',
    actor: { id: ACTOR, email: 'admin@example.invalid', displayName: null, isOwner: false },
  })),
  getMemberOr401: vi.fn(async () => ({
    role: 'member',
    loginId: MEMBER,
    anchorId: ANCHOR,
    spaceId: SPACE,
    email: 'member@example.invalid',
    displayName: 'Mia',
    contactId: null,
  })),
}));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withSpace: async (_scope: unknown, fn: () => Promise<unknown>) => fn(),
  withHumanViewer: async (_level: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@mantle/content', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const page =
    (name: string) =>
    async (...a: unknown[]) => {
      h.calls.push([name, a]);
      return { rows: [], hasMore: true };
    };
  return {
    ...real,
    isWithAdmin: async () => false,
    listMineComments: page('listMineComments'),
    listClientThread: page('listClientThread'),
    listReviewComments: page('listReviewComments'),
    listNodeComments: page('listNodeComments'),
  };
});

beforeEach(() => {
  h.calls.length = 0;
});

const ctx = { params: Promise.resolve({ id: ITEM }) };
type Get = (req: Request, c: typeof ctx) => Promise<Response>;

describe('thread paging on the member, admin and owner routes', () => {
  it('each GET reads one page, passes `before`, answers `hasMore`; a bad `before` is a 400', async () => {
    const routes: Array<[string, string, Get]> = [
      [
        'listMineComments',
        `/api/member/space/${ITEM}/comments`,
        (await import('../app/api/member/space/[id]/comments/route')).GET,
      ],
      [
        'listClientThread',
        `/api/member/library/${ITEM}/comments`,
        (await import('../app/api/member/library/[id]/comments/route')).GET,
      ],
      [
        'listReviewComments',
        `/api/team-admin/submissions/${ITEM}/comments`,
        (await import('../app/api/team-admin/submissions/[id]/comments/route')).GET,
      ],
      [
        'listNodeComments',
        `/api/nodes/${ITEM}/comments`,
        (await import('../app/api/nodes/[id]/comments/route')).GET,
      ],
    ];
    for (const [fn, url, GET] of routes) {
      h.calls.length = 0;
      const bad = await GET(new Request(`http://x${url}?before=soon`), ctx);
      expect(bad.status, url).toBe(400);
      expect(h.calls, url).toEqual([]);
      const res = await GET(new Request(`http://x${url}?before=${BEFORE}`), ctx);
      expect(res.status, url).toBe(200);
      expect(await res.json(), url).toEqual({ comments: [], hasMore: true });
      const [name, args] = h.calls[0]!;
      expect(name, url).toBe(fn);
      const q = args[args.length - 1] as { before: Date };
      expect(q.before.toISOString(), url).toBe(BEFORE);
      const newest = await GET(new Request(`http://x${url}`), ctx);
      expect(newest.status, url).toBe(200);
      const q2 = h.calls[1]![1][h.calls[1]![1].length - 1] as { before: Date | null };
      expect(q2.before, url).toBeNull();
    }
  });
});
