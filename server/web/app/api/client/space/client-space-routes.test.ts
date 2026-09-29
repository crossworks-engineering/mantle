/**
 * The client's own space routes (client logins C5) without a database: the
 * login rows and the content layer are stood in, the gate is the real one
 * (getClientOr401 / getClientForAsset over a signed cookie). These pin what
 * the ROUTES do:
 *
 *  - a client works with pages, notes and files only: a drawing or a table
 *    is a 400 to create or to list, and any other kind in the space is a 404;
 *  - there is no share route and no team-drafts route for a client;
 *  - admins and members are refused on every new route (the client sweep
 *    drives them all through the app);
 *  - the upload's 413 and its headroom use the CLIENT's ceiling, never the
 *    member's;
 *  - writes have their own per-login budget (`client-writes:<login>`);
 *  - the review talk shows a reviewer's comment under the brand name, and
 *    the client's own comment as theirs (`mine` by login);
 *  - My requests rows carry no level and no staff name.
 *
 * The rules themselves (limits, caps, row security on comments) are proven
 * on Postgres in packages/content/src/client-space-c5.viewer.db.test.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const MEMBER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const SPACE = '66666666-6666-4666-8666-666666666666';
const ITEM = '77777777-7777-4777-8777-777777777777';
const COMMENT = '99999999-9999-4999-8999-999999999999';
/** A client of its own, so its write budget is its own. */
const CLIENT2 = '88888888-8888-4888-8888-888888888888';
const MB = 1024 * 1024;

const h = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown[]]>,
  /** The kind getMineRow answers for ITEM. */
  kind: 'page' as string,
  comments: [] as unknown[],
  headroom: 0,
  uploadError: null as Error | null,
  mine: { items: [] as unknown[], total: 0 },
  held: [] as unknown[],
  accepted: { items: [] as unknown[], total: 0 },
  /** What the comment writers throw (a SpaceItemStateError reason), if any. */
  commentRefusal: null as null | string,
  hasMore: false,
}));

const row = (id: string, role: string, email: string) => ({
  id,
  email,
  isOwner: false,
  displayName: role === 'client' ? 'Client Person' : null,
  role,
  contactId: null,
  disabledAt: null,
  sessionEpoch: 3,
});

vi.mock('@/lib/auth/login-row', () => ({
  loadLoginRow: async (id: string) =>
    id === CLIENT || id === CLIENT2
      ? row(id, 'client', `${id.slice(0, 4)}@example.invalid`)
      : id === MEMBER
        ? row(MEMBER, 'member', 'member@example.invalid')
        : id === ADMIN
          ? row(ADMIN, 'admin', 'admin@example.invalid')
          : null,
  loadAnchorId: async () => ANCHOR,
  loadPersonalSpaceId: async () => SPACE,
}));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withSpace: async (scope: unknown, fn: () => Promise<unknown>) => {
    h.calls.push(['withSpace', [scope]]);
    return fn();
  },
  withHumanViewer: async (_level: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const rec =
    <T>(name: string, ret: (...a: unknown[]) => T) =>
    async (...a: unknown[]) => {
      h.calls.push([name, a]);
      return ret(...a);
    };
  const spaceRow = () => ({
    id: ITEM,
    type: h.kind,
    title: 'Item',
    icon: null,
    sharing: 'private',
    reviewState: 'submitted',
    submittedAt: null,
    returnedNote: null,
    authorLoginId: CLIENT,
    updatedAt: '2026-09-01T00:00:00.000Z',
  });
  return {
    ...actual,
    isWithAdmin: rec('isWithAdmin', () => false),
    getMineRow: rec('getMineRow', spaceRow),
    getMineItem: rec('getMineItem', () => ({ row: spaceRow(), body: { type: h.kind } })),
    createMineItem: rec('createMineItem', () => spaceRow()),
    submitItem: rec('submitItem', spaceRow),
    listMine: rec('listMine', () => h.mine),
    listWithAdmin: rec('listWithAdmin', () => h.held),
    listAccepted: rec('listAccepted', () => h.accepted),
    listMineComments: rec('listMineComments', () => ({ rows: h.comments, hasMore: h.hasMore })),
    listClientThread: rec('listClientThread', () => ({ rows: h.comments, hasMore: h.hasMore })),
    assertEditable: rec('assertEditable', spaceRow),
    saveMineDraft: rec('saveMineDraft', () => ({ ok: true, rev: 2 })),
    saveMinePage: rec('saveMinePage', () => ({ ok: true })),
    updateMineItem: rec('updateMineItem', () => ({ row: spaceRow(), body: { type: h.kind } })),
    addMineComment: rec('addMineComment', () => {
      if (h.commentRefusal) {
        throw new (actual.SpaceItemStateError as new (r: string, m: string) => Error)(
          h.commentRefusal,
          'refused',
        );
      }
      return {
        id: COMMENT,
        nodeId: ITEM,
        ownerId: ANCHOR,
        authorKind: 'client',
        loginId: CLIENT,
        authorName: 'Client Person',
        body: 'x',
        threadScope: 'review',
        contactId: null,
        agentId: null,
        createdAt: new Date('2026-09-01T00:00:00Z'),
        editedAt: null,
      };
    }),
    addClientThreadComment: rec('addClientThreadComment', () => {
      if (h.commentRefusal) {
        throw new (actual.SpaceItemStateError as new (r: string, m: string) => Error)(
          h.commentRefusal,
          'refused',
        );
      }
      return null;
    }),
    loadPreferencesFor: rec('loadPreferencesFor', () => ({ siteName: 'Brand Co' })),
    spaceUploadHeadroom: rec('spaceUploadHeadroom', () => h.headroom),
  };
});

vi.mock('@mantle/files', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spacesRootAvailable: () => true,
  spaceSpoolDir: () => '/nonexistent-spool',
  sweepSpool: async () => undefined,
}));

vi.mock('@/lib/upload-stream', () => ({
  readMultipartUpload: vi.fn(async () => {
    if (h.uploadError) throw h.uploadError;
    return { fields: {}, file: null };
  }),
}));

type Tokens = typeof import('@/lib/auth/tokens');
let tokens: Tokens;
let runWith: typeof import('@/server/request-context').runWithRequestContext;
const saved = process.env.SESSION_SECRET;

beforeAll(async () => {
  process.env.SESSION_SECRET = 'client-space-routes-secret-at-least-32-chars';
  tokens = await import('@/lib/auth/tokens');
  runWith = (await import('@/server/request-context')).runWithRequestContext;
});
afterAll(() => {
  process.env.SESSION_SECRET = saved;
});
beforeEach(() => {
  h.calls.length = 0;
  h.kind = 'page';
  h.comments = [];
  h.headroom = 0;
  h.uploadError = null;
  h.mine = { items: [], total: 0 };
  h.held = [];
  h.accepted = { items: [], total: 0 };
  h.commentRefusal = null;
  h.hasMore = false;
});

type Handler = (req: Request) => Promise<Response>;

/** Call a handler as `login` (a session cookie signed at the row's epoch). */
async function call(
  login: string | null,
  method: string,
  url: string,
  handler: Handler,
  init: { body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (login) {
    const { value } = tokens.buildSessionCookie(login, { epoch: 3, ttlSeconds: 3600 });
    headers.set('cookie', `${tokens.SESSION_COOKIE_NAME}=${value}`);
  }
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const req = new Request(`http://x${url}`, { method, headers, body: init.body });
  return runWith({ req, path: new URL(req.url).pathname, method }, () => handler(req));
}
const params = (id = ITEM) => ({ params: Promise.resolve({ id }) });
const names = () => h.calls.map(([n]) => n);

describe('client space routes: kinds', () => {
  it('refuses to create a drawing or a table (400), before any write', async () => {
    const list = await import('./route');
    for (const type of ['draw', 'table']) {
      const res = await call(CLIENT, 'POST', '/api/client/space', (r) => list.POST(r), {
        body: JSON.stringify({ type, title: 'x' }),
      });
      expect(res.status, type).toBe(400);
    }
    expect(names()).not.toContain('createMineItem');
    // A page is created, in the client's own space.
    const ok = await call(CLIENT, 'POST', '/api/client/space', (r) => list.POST(r), {
      body: JSON.stringify({ type: 'page', title: 'x' }),
    });
    expect(ok.status).toBe(201);
    expect(h.calls.find(([n]) => n === 'withSpace')?.[1]).toEqual([
      { spaceId: SPACE, loginId: CLIENT },
    ]);
  });

  it('refuses to list a drawing or a table (400); the list reads only client kinds', async () => {
    const list = await import('./route');
    const items = await import('../items/route');
    for (const kind of ['draw', 'table']) {
      expect(
        (await call(CLIENT, 'GET', `/api/client/space?kind=${kind}`, (r) => list.GET(r))).status,
        kind,
      ).toBe(400);
      expect(
        (await call(CLIENT, 'GET', `/api/client/items?kind=${kind}`, (r) => items.GET(r))).status,
        kind,
      ).toBe(400);
    }
    expect(names()).not.toContain('listMine');
    const res = await call(CLIENT, 'GET', '/api/client/space', (r) => list.GET(r));
    expect(res.status).toBe(200);
    const opts = h.calls.find(([n]) => n === 'listMine')![1][1] as { kinds?: string[] };
    expect(opts.kinds).toEqual(['page', 'note', 'file']);
  });

  it('answers any other kind in the space as a 404, on the item routes', async () => {
    const one = await import('./[id]/route');
    const submit = await import('./[id]/submit/route');
    const comments = await import('./[id]/comments/route');
    for (const kind of ['draw', 'table']) {
      h.kind = kind;
      const url = `/api/client/space/${ITEM}`;
      expect((await call(CLIENT, 'GET', url, (r) => one.GET(r, params()))).status, kind).toBe(404);
      expect(
        (await call(CLIENT, 'POST', `${url}/submit`, (r) => submit.POST(r, params()))).status,
      ).toBe(404);
      expect(
        (await call(CLIENT, 'GET', `${url}/comments`, (r) => comments.GET(r, params()))).status,
      ).toBe(404);
    }
    expect(names()).not.toContain('getMineItem');
    expect(names()).not.toContain('submitItem');
    expect(names()).not.toContain('listMineComments');
    h.kind = 'note';
    expect(
      (await call(CLIENT, 'GET', `/api/client/space/${ITEM}`, (r) => one.GET(r, params()))).status,
    ).toBe(200);
  });
});

describe('client space routes: what a client does not get', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifestPath = join(here, '../../../../server/route-manifest.gen.ts');

  it('has no share route and no team-drafts route under /api/client/', async () => {
    expect(existsSync(join(here, '[id]/share/route.ts'))).toBe(false);
    const { CLIENT_ROUTES } = await import('@/lib/auth/client-routes');
    const forbidden = /\/share(\/|$)|\/team-drafts(\/|$)/;
    expect(CLIENT_ROUTES.filter((r) => forbidden.test(r))).toEqual([]);
    // The manifest is generated from the files: nothing of the kind exists.
    const manifest = readFileSync(manifestPath, 'utf8');
    expect(manifest).not.toMatch(/\/api\/client\/[^'"]*\/(share|team-drafts)['"/]/);
  });

  it('refuses no session (401), an admin and a member (403) on the new routes', async () => {
    const list = await import('./route');
    const one = await import('./[id]/route');
    const items = await import('../items/route');
    const accepted = await import('../accepted/[id]/route');
    const upload = await import('../space-files/route');
    const routes: Array<[string, string, Handler]> = [
      ['GET', '/api/client/space', (r) => list.GET(r)],
      ['POST', '/api/client/space', (r) => list.POST(r)],
      ['GET', `/api/client/space/${ITEM}`, (r) => one.GET(r, params())],
      ['DELETE', `/api/client/space/${ITEM}`, (r) => one.DELETE(r, params())],
      ['GET', '/api/client/items', (r) => items.GET(r)],
      ['GET', `/api/client/accepted/${ITEM}`, (r) => accepted.GET(r, params())],
      ['POST', '/api/client/space-files', (r) => upload.POST(r)],
    ];
    for (const [method, url, handler] of routes) {
      expect((await call(null, method, url, handler)).status, url).toBe(401);
      for (const [login, reason] of [
        [ADMIN, 'admin-login'],
        [MEMBER, 'member-login'],
      ] as const) {
        const res = await call(login, method, url, handler);
        expect(res.status, `${method} ${url} ${login}`).toBe(403);
        expect(((await res.json()) as { reason: string }).reason).toBe(reason);
      }
    }
    expect(h.calls).toEqual([]);
  });

  it('refuses a member session and a member ?at= token on the own-bytes route', async () => {
    const bytes = await import('./[id]/bytes/route');
    const url = `/api/client/space/${ITEM}/bytes`;
    const memberAt = tokens.buildAssetToken(ANCHOR, MEMBER, 3);
    expect((await call(MEMBER, 'GET', url, (r) => bytes.GET(r, params()))).status).toBe(401);
    expect(
      (await call(null, 'GET', `${url}?at=${memberAt}`, (r) => bytes.GET(r, params()))).status,
    ).toBe(401);
    expect(h.calls).toEqual([]);
  });
});

describe('client space routes: limits', () => {
  it('the upload 413 names the CLIENT ceiling (20 MB), never the member one', async () => {
    const upload = await import('../space-files/route');
    const tooBig = async () => {
      const { UploadTooLargeError } = await import('@mantle/files');
      return new UploadTooLargeError(20 * MB);
    };
    // Room for a full client file: the spool stops at it, a 413 naming it.
    h.headroom = 20 * MB;
    h.uploadError = await tooBig();
    const res = await call(CLIENT, 'POST', '/api/client/space-files', (r) => upload.POST(r));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { maxUploadBytes: number; error: string };
    expect(body.maxUploadBytes).toBe(20 * MB);
    expect(body.error).toMatch(/20 MB/);
    // A declared body over the ceiling is the same 413, before any spool.
    const declared = await call(CLIENT, 'POST', '/api/client/space-files', (r) => upload.POST(r), {
      headers: { 'content-length': String(30 * MB) },
    });
    expect(declared.status).toBe(413);
    expect(((await declared.json()) as { maxUploadBytes: number }).maxUploadBytes).toBe(20 * MB);
    // Less room than a file (a full space): 409 quota, not a 413.
    h.headroom = 5 * MB;
    h.uploadError = await tooBig();
    const full = await call(CLIENT, 'POST', '/api/client/space-files', (r) => upload.POST(r));
    expect(full.status).toBe(409);
    expect(((await full.json()) as { reason: string }).reason).toBe('quota');
  });

  it('writes have their own per-login budget, keyed client-writes:<login>', async () => {
    const list = await import('./route');
    const { rateLimit } = await import('@/lib/rate-limit');
    const { CLIENT_WRITES_PER_MIN } = await import('@/lib/client-space');
    for (let i = 0; i < CLIENT_WRITES_PER_MIN; i++) {
      rateLimit(`client-writes:${CLIENT2}`, { max: CLIENT_WRITES_PER_MIN, windowMs: 60_000 });
    }
    const res = await call(CLIENT2, 'POST', '/api/client/space', (r) => list.POST(r), {
      body: JSON.stringify({ type: 'note', title: 'x' }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(names()).not.toContain('createMineItem');
  });
});

describe('client space routes: the review talk', () => {
  const base = {
    nodeId: ITEM,
    ownerId: ANCHOR,
    contactId: null,
    agentId: null,
    threadScope: 'review',
    body: 'x',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    editedAt: null,
  };

  it('a reviewer’s comment wears the brand name; the client’s own is theirs', async () => {
    const comments = await import('./[id]/comments/route');
    h.comments = [
      { ...base, id: COMMENT, authorKind: 'owner', loginId: ADMIN, authorName: 'Staff Name' },
      { ...base, id: ITEM, authorKind: 'client', loginId: CLIENT, authorName: 'Client Person' },
    ];
    const res = await call(CLIENT, 'GET', `/api/client/space/${ITEM}/comments`, (r) =>
      comments.GET(r, params()),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      comments: { authorName: string; mine: boolean; authorKind: string }[];
    };
    expect(body.comments.map((c) => [c.authorKind, c.authorName, c.mine])).toEqual([
      ['owner', 'Brand Co', false],
      ['client', 'Client Person', true],
    ]);
    expect(JSON.stringify(body)).not.toContain('Staff Name');
  });
});

describe('client space routes: My requests', () => {
  it('rows carry no level and no staff name', async () => {
    const items = await import('../items/route');
    const own = {
      id: ITEM,
      type: 'page',
      title: 'Mine',
      icon: null,
      sharing: 'private',
      reviewState: 'returned',
      submittedAt: null,
      returnedNote: 'Say which site.',
      authorLoginId: CLIENT,
      updatedAt: '2026-09-03T00:00:00.000Z',
    };
    h.mine = { items: [own], total: 1 };
    h.held = [{ ...own, id: COMMENT, reviewState: 'with-admin', returnedNote: null }];
    h.accepted = {
      items: [
        {
          id: CLIENT2,
          type: 'note',
          title: 'Accepted',
          icon: null,
          audience: 'team',
          acceptedAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      ],
      total: 1,
    };
    const res = await call(CLIENT, 'GET', '/api/client/items', (r) => items.GET(r));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record<string, unknown>[]; total: number };
    expect(body.total).toBe(3);
    const keys = ['acceptedAt', 'icon', 'id', 'pill', 'source', 'space', 'title', 'type'];
    for (const r of body.items) expect(Object.keys(r).sort()).toEqual([...keys, 'updatedAt']);
    expect(body.items.map((r) => [r.source, r.pill])).toEqual([
      ['own', 'returned'],
      ['own', 'with-admin'],
      ['accepted', null],
    ]);
    expect(JSON.stringify(body)).not.toContain('audience');
    // Every source was asked for client kinds only.
    for (const n of ['listMine', 'listWithAdmin', 'listAccepted']) {
      const call = h.calls.find(([name]) => name === n)!;
      const opts = call[1][call[1].length - 1] as { kinds?: string[] };
      expect(opts.kinds, n).toEqual(['page', 'note', 'file']);
    }
  });

  it('the state filter reads only its source', async () => {
    const items = await import('../items/route');
    await call(CLIENT, 'GET', '/api/client/items?state=accepted', (r) => items.GET(r));
    expect(names()).toEqual(['listAccepted']);
    h.calls.length = 0;
    await call(CLIENT, 'GET', '/api/client/items?state=returned', (r) => items.GET(r));
    expect(names()).toEqual(['withSpace', 'listMine']);
    const opts = h.calls[1]![1][1] as { reviewStates?: string[] };
    expect(opts.reviewStates).toEqual(['returned']);
    expect(
      (await call(CLIENT, 'GET', '/api/client/items?state=draft', (r) => items.GET(r))).status,
    ).toBe(400);
  });
});

describe('client space routes: the C5 audit limits', () => {
  const doc = (bytes: number) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a'.repeat(bytes) }] }],
  });

  it('a page document over 500 KB is a 400 too-large (draft and Save), before any write', async () => {
    const draft = await import('./[id]/draft/route');
    const save = await import('./[id]/save/route');
    const url = `/api/client/space/${ITEM}`;
    for (const [path, handler] of [
      [`${url}/draft`, (r: Request) => draft.PUT(r, params())],
      [`${url}/save`, (r: Request) => save.POST(r, params())],
    ] as const) {
      const res = await call(CLIENT, path.endsWith('draft') ? 'PUT' : 'POST', path, handler, {
        body: JSON.stringify({ doc: doc(510_000) }),
      });
      expect(res.status, path).toBe(400);
      expect(((await res.json()) as { reason: string }).reason).toBe('too-large');
    }
    expect(names()).not.toContain('saveMineDraft');
    expect(names()).not.toContain('saveMinePage');
    // Under it (and over nothing a member's 2 MB would allow): it saves,
    // through the client's text-aware draft.
    const ok = await call(CLIENT, 'PUT', `${url}/draft`, (r) => draft.PUT(r, params()), {
      body: JSON.stringify({ doc: doc(490_000) }),
    });
    expect(ok.status).toBe(200);
    expect(names()).toContain('saveMineDraft');
  });

  it('a note over 50,000 characters is a 400 too-large (create and edit)', async () => {
    const list = await import('./route');
    const one = await import('./[id]/route');
    const big = await call(CLIENT, 'POST', '/api/client/space', (r) => list.POST(r), {
      body: JSON.stringify({ type: 'note', title: 'n', content: 'x'.repeat(50_001) }),
    });
    expect(big.status).toBe(400);
    expect(((await big.json()) as { reason: string }).reason).toBe('too-large');
    h.kind = 'note';
    const patch = await call(
      CLIENT,
      'PATCH',
      `/api/client/space/${ITEM}`,
      (r) => one.PATCH(r, params()),
      {
        body: JSON.stringify({ content: 'x'.repeat(50_001) }),
      },
    );
    expect(patch.status).toBe(400);
    expect(((await patch.json()) as { reason: string }).reason).toBe('too-large');
    expect(names()).not.toContain('createMineItem');
    expect(names()).not.toContain('updateMineItem');
    const ok = await call(CLIENT, 'POST', '/api/client/space', (r) => list.POST(r), {
      body: JSON.stringify({ type: 'note', title: 'n', content: 'x'.repeat(50_000) }),
    });
    expect(ok.status).toBe(201);
  });

  it('the comment caps: 429 comment-cap and 409 thread-full, on both client threads', async () => {
    const talk = await import('./[id]/comments/route');
    const shared = await import('../shared/[id]/comments/route');
    for (const [reason, status] of [
      ['comment-cap', 429],
      ['thread-full', 409],
    ] as const) {
      h.commentRefusal = reason;
      const a = await call(
        CLIENT,
        'POST',
        `/api/client/space/${ITEM}/comments`,
        (r) => talk.POST(r, params()),
        {
          body: JSON.stringify({ body: 'hi' }),
        },
      );
      expect([a.status, ((await a.json()) as { reason: string }).reason]).toEqual([status, reason]);
      const b = await call(
        CLIENT,
        'POST',
        `/api/client/shared/${ITEM}/comments`,
        (r) => shared.POST(r, params()),
        {
          body: JSON.stringify({ body: 'hi' }),
        },
      );
      expect([b.status, ((await b.json()) as { reason: string }).reason]).toEqual([status, reason]);
    }
  });

  it('thread reads are paged: `before` reaches the read, `hasMore` the answer', async () => {
    const talk = await import('./[id]/comments/route');
    const shared = await import('../shared/[id]/comments/route');
    const bad = await call(
      CLIENT,
      'GET',
      `/api/client/space/${ITEM}/comments?before=yesterday`,
      (r) => talk.GET(r, params()),
    );
    expect(bad.status).toBe(400);
    expect(names()).not.toContain('listMineComments');
    h.hasMore = true;
    const before = '2026-09-01T10:00:00.123Z';
    const a = await call(
      CLIENT,
      'GET',
      `/api/client/space/${ITEM}/comments?before=${before}`,
      (r) => talk.GET(r, params()),
    );
    expect(a.status).toBe(200);
    expect(((await a.json()) as { hasMore: boolean }).hasMore).toBe(true);
    const page = h.calls.find(([n]) => n === 'listMineComments')![1][2] as { before: Date };
    expect(page.before.toISOString()).toBe(before);
    const b = await call(CLIENT, 'GET', `/api/client/shared/${ITEM}/comments`, (r) =>
      shared.GET(r, params()),
    );
    expect(((await b.json()) as { hasMore: boolean }).hasMore).toBe(true);
    const newest = h.calls.find(([n]) => n === 'listClientThread')![1][2] as {
      before: Date | null;
    };
    expect(newest.before).toBeNull();
  });
});
