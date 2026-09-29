/**
 * The client read routes (client logins C2) without a database: the login
 * rows and the content reads are stood in, the gate is the real one
 * (getClientOr401 / getClientForAsset over a signed cookie or `?at=` token).
 * These pin what the ROUTES do: admins and members are refused (403) before
 * any read, a malformed id is a 400 before any read, every read runs at the
 * client level, and the shell's asset token is minted for the client login.
 * The rules themselves are proven on Postgres in
 * packages/content/src/client-shared.viewer.db.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const MEMBER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const SPACE = '66666666-6666-4666-8666-666666666666';
const ITEM = '77777777-7777-4777-8777-777777777777';

const h = vi.hoisted(() => ({
  reads: [] as Array<[string, string]>,
  item: null as unknown,
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
    id === CLIENT
      ? row(CLIENT, 'client', 'client@example.invalid')
      : id === MEMBER
        ? row(MEMBER, 'member', 'member@example.invalid')
        : id === ADMIN
          ? row(ADMIN, 'admin', 'admin@example.invalid')
          : null,
  loadAnchorId: async () => ANCHOR,
  loadPersonalSpaceId: async () => SPACE,
}));

vi.mock('@mantle/content', async (importOriginal) => {
  const { currentViewerLevel } = await import('@mantle/db');
  const read =
    <T>(name: string, ret: () => T) =>
    async () => {
      h.reads.push([name, currentViewerLevel()]);
      return ret();
    };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    loadPreferencesFor: read('loadPreferencesFor', () => ({ siteName: 'Brand' })),
    listClientShared: read('listClientShared', () => ({ items: [], total: 0 })),
    getClientSharedItem: read('getClientSharedItem', () => h.item),
    getDrawSvg: read('getDrawSvg', () => '<svg/>'),
    clientDrawSvg: read('clientDrawSvg', () => '<svg id="client"/>'),
  };
});

vi.mock('@/lib/files', async () => {
  const { currentViewerLevel } = await import('@mantle/db');
  const { Readable } = await import('node:stream');
  return {
    fileById: vi.fn(async () => null),
    readFileById: vi.fn(async () => null),
    openFileById: vi.fn(async () => {
      h.reads.push(['openFileById', currentViewerLevel()]);
      return {
        stream: Readable.from([Buffer.from('BYTES')]),
        size: 5,
        row: { mimeType: 'text/html', filename: 'a.html' },
      };
    }),
  };
});

type Tokens = typeof import('@/lib/auth/tokens');
let tokens: Tokens;
let runWith: typeof import('@/server/request-context').runWithRequestContext;
const saved = process.env.SESSION_SECRET;

beforeAll(async () => {
  process.env.SESSION_SECRET = 'client-read-routes-secret-at-least-32-chars';
  tokens = await import('@/lib/auth/tokens');
  runWith = (await import('@/server/request-context')).runWithRequestContext;
});
afterAll(() => {
  process.env.SESSION_SECRET = saved;
});
beforeEach(() => {
  h.reads.length = 0;
  h.item = null;
});

/** Call a handler as `login` (a session cookie signed at the row's epoch). */
async function call(
  login: string | null,
  url: string,
  handler: (req: Request) => Promise<Response>,
): Promise<Response> {
  const headers = new Headers();
  if (login) {
    const { value } = tokens.buildSessionCookie(login, { epoch: 3, ttlSeconds: 3600 });
    headers.set('cookie', `${tokens.SESSION_COOKIE_NAME}=${value}`);
  }
  const req = new Request(`http://x${url}`, { headers });
  return runWith({ req, path: new URL(req.url).pathname, method: 'GET' }, () => handler(req));
}
const byId =
  (
    mod: { GET: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response> },
    id: string,
  ) =>
  (req: Request) =>
    mod.GET(req, { params: Promise.resolve({ id }) });

describe('client read routes: the gate', () => {
  it('refuses no session (401), an admin and a member (403) before any read', async () => {
    const shell = await import('./shell/route');
    const list = await import('./shared/route');
    const one = await import('./shared/[id]/route');
    const routes: Array<[string, (r: Request) => Promise<Response>]> = [
      ['/api/client/shell', () => shell.GET()],
      ['/api/client/shared', (r) => list.GET(r)],
      [`/api/client/shared/${ITEM}`, byId(one, ITEM)],
    ];
    for (const [url, handler] of routes) {
      expect((await call(null, url, handler)).status, url).toBe(401);
      for (const [login, reason] of [
        [ADMIN, 'admin-login'],
        [MEMBER, 'member-login'],
      ] as const) {
        const res = await call(login, url, handler);
        expect(res.status, `${url} ${login}`).toBe(403);
        expect(((await res.json()) as { reason: string }).reason).toBe(reason);
      }
    }
    expect(h.reads).toEqual([]);
  });

  it('refuses a member session and a member ?at= token on the byte routes', async () => {
    const files = await import('./files/[id]/route');
    const svg = await import('./draws/[id]/svg/route');
    const memberAt = tokens.buildAssetToken(ANCHOR, MEMBER, 3);
    for (const [url, handler] of [
      [`/api/client/files/${ITEM}`, byId(files, ITEM)],
      [`/api/client/draws/${ITEM}/svg`, byId(svg, ITEM)],
    ] as const) {
      expect((await call(MEMBER, url, handler)).status).toBe(401);
      expect((await call(null, `${url}?at=${memberAt}`, handler)).status).toBe(401);
    }
    expect(h.reads).toEqual([]);
  });
});

describe('client read routes: a client', () => {
  it('shell: who, the brand, and an asset token minted for the client login', async () => {
    const shell = await import('./shell/route');
    const res = await call(CLIENT, '/api/client/shell', () => shell.GET());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      role: 'client',
      loginId: CLIENT,
      displayName: 'Client Person',
      email: 'client@example.invalid',
      siteName: 'Brand',
    });
    expect(tokens.verifyAssetToken(String(body.assetToken))).toEqual({
      uid: ANCHOR,
      act: CLIENT,
      ep: 3,
    });
  });

  it('a malformed id is a 400 before any read, on every :id route', async () => {
    const one = await import('./shared/[id]/route');
    const files = await import('./files/[id]/route');
    const svg = await import('./draws/[id]/svg/route');
    for (const mod of [one, files, svg]) {
      const res = await call(CLIENT, '/api/client/x/not-a-uuid', byId(mod, 'not-a-uuid'));
      expect(res.status).toBe(400);
    }
    expect(h.reads).toEqual([]);
  });

  it('shared list and item read at the client level; a miss is a 404', async () => {
    const list = await import('./shared/route');
    const one = await import('./shared/[id]/route');
    const res = await call(CLIENT, '/api/client/shared?kind=page&page=2', (r) => list.GET(r));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], total: 0, page: 2, pageSize: 50 });
    expect((await call(CLIENT, '/api/client/shared?kind=task', (r) => list.GET(r))).status).toBe(
      400,
    );
    expect((await call(CLIENT, `/api/client/shared/${ITEM}`, byId(one, ITEM))).status).toBe(404);
    h.item = { id: ITEM, type: 'note', content: 'x' };
    const hit = await call(CLIENT, `/api/client/shared/${ITEM}`, byId(one, ITEM));
    expect(await hit.json()).toEqual({ item: h.item });
    expect(h.reads).toEqual([
      ['listClientShared', 'client'],
      ['getClientSharedItem', 'client'],
      ['getClientSharedItem', 'client'],
    ]);
  });

  it('bytes and the drawing SVG are read at the client level, with safe headers', async () => {
    const files = await import('./files/[id]/route');
    const svg = await import('./draws/[id]/svg/route');
    const bytes = await call(CLIENT, `/api/client/files/${ITEM}`, byId(files, ITEM));
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(bytes.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(await bytes.text()).toBe('BYTES');
    const pic = await call(CLIENT, `/api/client/draws/${ITEM}/svg`, byId(svg, ITEM));
    expect(pic.status).toBe(200);
    expect(await pic.text()).toBe('<svg id="client"/>');
    expect(pic.headers.get('content-security-policy')).toMatch(/sandbox/);
    expect(h.reads).toEqual([
      ['openFileById', 'client'],
      ['getDrawSvg', 'client'],
      ['clientDrawSvg', 'client'],
    ]);
  });

  it('a client ?at= token opens the byte routes', async () => {
    const files = await import('./files/[id]/route');
    const at = tokens.buildAssetToken(ANCHOR, CLIENT, 3);
    const res = await call(null, `/api/client/files/${ITEM}?at=${at}`, byId(files, ITEM));
    expect(res.status).toBe(200);
  });
});
