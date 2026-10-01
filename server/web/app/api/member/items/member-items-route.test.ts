/**
 * GET /api/member/items (item-list alignment) without a database: the
 * sources are stood in, so these pin what the ROUTE does with them. Each
 * source is read in its own scope with this member's ids, the State filter
 * reaches exactly the sources it names, and the Library rows of the page get
 * their author. The merge itself is unit-tested (member-items.test.ts); each
 * source's rules are proven on Postgres by its own db tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const LOGIN = '22222222-2222-4222-8222-222222222222';
const SPACE = '66666666-6666-4666-8666-666666666666';

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

const h = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; scope: string; args: unknown[] }>,
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
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const scoped =
    (name: string) =>
    async (...a: unknown[]) => {
      const fn = a[a.length - 1] as () => Promise<unknown>;
      scope.push(name);
      try {
        return await fn();
      } finally {
        scope.pop();
      }
    };
  const scope: string[] = [];
  (globalThis as { __scope?: string[] }).__scope = scope;
  return {
    ...real,
    withSpace: vi.fn(scoped('space')),
    withTeamDrafts: vi.fn(scoped('team-drafts')),
    withViewer: vi.fn(scoped('team')),
    withHumanViewer: vi.fn(scoped('human')),
  };
});

const scopeNow = () => (globalThis as { __scope?: string[] }).__scope?.at(-1) ?? 'admin';

vi.mock('@mantle/content', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const rec = (fn: string, answer: () => unknown) =>
    vi.fn(async (...args: unknown[]) => {
      h.calls.push({ fn, scope: scopeNow(), args });
      return answer();
    });
  const spaceRow = (id: string, n: number, over: Record<string, unknown> = {}) => ({
    id,
    type: 'page',
    title: id,
    icon: null,
    sharing: 'private',
    reviewState: 'draft',
    submittedAt: null,
    returnedNote: null,
    authorLoginId: LOGIN,
    updatedAt: at(n),
    ...over,
  });
  return {
    ...real,
    listMine: rec('listMine', () => ({ items: [spaceRow('own1', 50)], total: 1 })),
    listWithAdmin: rec('listWithAdmin', () => [
      spaceRow('held1', 5, { reviewState: 'with-admin' }),
    ]),
    listTeamDrafts: rec('listTeamDrafts', () => ({
      items: [spaceRow('team1', 40, { sharing: 'team', reviewState: 'submitted' })],
      total: 1,
    })),
    listLibrary: rec('listLibrary', () => ({
      items: [
        {
          id: 'lib1',
          type: 'page',
          title: 'L1',
          icon: null,
          summary: 's',
          audience: 'team',
          updatedAt: at(30),
        },
        {
          id: 'lib2',
          type: 'page',
          title: 'L2',
          icon: null,
          summary: null,
          audience: 'client',
          updatedAt: at(20),
        },
      ],
      total: 2,
    })),
    listAccepted: rec('listAccepted', () => ({
      items: [
        {
          id: 'acc1',
          type: 'page',
          title: 'A1',
          icon: null,
          audience: 'admin',
          acceptedAt: at(10),
          updatedAt: at(10),
        },
      ],
      total: 1,
    })),
    acceptedAuthors: rec(
      'acceptedAuthors',
      () => new Map([['lib1', { name: 'Pat', acceptedAt: at(1) }]]),
    ),
    acceptedByLogin: rec('acceptedByLogin', () => new Set(['lib1'])),
    listClientRequests: rec('listClientRequests', () => ({
      items: [
        {
          row: spaceRow('req1', 45, { reviewState: 'submitted', authorLoginId: 'c1' }),
          author: { name: 'Cleo', acceptedAt: null, role: 'client' },
        },
      ],
      total: 1,
    })),
  };
});

const get = async (qs = '') => {
  const { GET } = await import('./route');
  return GET(new Request(`http://x/api/member/items${qs}`));
};

beforeEach(() => {
  h.calls = [];
});

describe('GET /api/member/items', () => {
  it('lists every source in one list, newest first, each in its own scope', async () => {
    const res = await get('?kind=page');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((r: { id: string }) => r.id)).toEqual([
      'own1',
      'req1',
      'team1',
      'lib1',
      'lib2',
      'acc1',
      'held1',
    ]);
    expect(body.total).toBe(7);
    expect(body.items.map((r: { pill: string | null }) => r.pill)).toEqual([
      'private',
      'submitted',
      'submitted',
      null,
      null,
      null,
      'with-admin',
    ]);
    const scopes = Object.fromEntries(
      h.calls.filter((c) => c.fn.startsWith('list')).map((c) => [c.fn, c.scope]),
    );
    expect(scopes).toEqual({
      listMine: 'space',
      listWithAdmin: 'space',
      listTeamDrafts: 'team-drafts',
      listLibrary: 'team',
      listAccepted: 'admin',
      // Client requests (C5): the team role with the human flag.
      listClientRequests: 'human',
    });
    const { withHumanViewer } = await import('@mantle/db');
    expect(vi.mocked(withHumanViewer).mock.calls[0]?.[0]).toBe('team');
    expect(h.calls.find((c) => c.fn === 'listClientRequests')!.args[0]).toMatchObject({
      kind: 'page',
      limit: 50,
      offset: 0,
    });
    expect(body.items[1]).toMatchObject({
      source: 'client-request',
      pill: 'submitted',
      audience: null,
      byMe: false,
      author: { name: 'Cleo', acceptedAt: null, role: 'client' },
      space: { id: 'req1', reviewState: 'submitted' },
    });
    const mine = h.calls.find((c) => c.fn === 'listMine')!;
    expect(mine.args[0]).toBe(SPACE);
    expect(mine.args[1]).toMatchObject({ kind: 'page', limit: 50, offset: 0 });
    expect(h.calls.find((c) => c.fn === 'listTeamDrafts')!.args[0]).toBe(LOGIN);
    expect(h.calls.find((c) => c.fn === 'listLibrary')!.args[0]).toBe(ANCHOR);
    const acc = h.calls.find((c) => c.fn === 'listAccepted')!;
    expect(acc.args.slice(0, 2)).toEqual([ANCHOR, LOGIN]);
    // Only what the Library does not list already, merged on updatedAt.
    expect(acc.args[2]).toMatchObject({ order: 'updated', outside: ['team', 'client'] });
  });

  it('gives the Library rows of the page their author and byMe', async () => {
    const body = await (await get()).json();
    const lib1 = body.items.find((r: { id: string }) => r.id === 'lib1');
    const lib2 = body.items.find((r: { id: string }) => r.id === 'lib2');
    expect(lib1).toMatchObject({ source: 'library', byMe: true, author: { name: 'Pat' } });
    expect(lib2).toMatchObject({
      source: 'library',
      byMe: false,
      author: null,
      audience: 'client',
    });
    expect(h.calls.find((c) => c.fn === 'acceptedByLogin')!.args).toEqual([
      ANCHOR,
      LOGIN,
      ['lib1', 'lib2'],
    ]);
  });

  it('reads only the sources a State filter names, narrowed in their own query', async () => {
    await get('?state=private');
    expect(h.calls.filter((c) => c.fn.startsWith('list')).map((c) => c.fn)).toEqual(['listMine']);
    expect(h.calls[0]!.args[1]).toMatchObject({ reviewStates: ['draft'], sharing: 'private' });

    h.calls = [];
    await get('?state=submitted');
    const fns = h.calls.filter((c) => c.fn.startsWith('list'));
    expect(fns.map((c) => c.fn)).toEqual(['listMine', 'listTeamDrafts']);
    for (const c of fns) expect(c.args[1]).toMatchObject({ reviewStates: ['submitted'] });

    h.calls = [];
    const byMe = await (await get('?state=by-me')).json();
    expect(h.calls.filter((c) => c.fn.startsWith('list')).map((c) => c.fn)).toEqual([
      'listAccepted',
    ]);
    expect(h.calls[0]!.args[2]).not.toHaveProperty('audiences');
    expect(byMe.items).toEqual([
      expect.objectContaining({ id: 'acc1', byMe: true, source: 'accepted' }),
    ]);
  });

  it('the client-requests filter reads client requests only', async () => {
    const body = await (await get('?state=client-requests')).json();
    expect(h.calls.filter((c) => c.fn.startsWith('list')).map((c) => c.fn)).toEqual([
      'listClientRequests',
    ]);
    expect(body.items.map((r: { id: string }) => r.id)).toEqual(['req1']);
  });

  it('refuses an unknown state and a page past the cap', async () => {
    expect((await get('?state=secret')).status).toBe(400);
    expect((await get('?page=101')).status).toBe(400);
    expect(h.calls).toEqual([]);
  });
});
