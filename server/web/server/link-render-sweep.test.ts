/**
 * The /s and /print sweep (arch A4 step 2): every answer the public share
 * surface and the render surfaces give on the wire, through the real app
 * (static layer, gate, routes, pages), pinned in a snapshot. Step 2 moved
 * these surfaces into the HTTP pipeline (their ROUTE_POLICY rows, run
 * through enterCall); the snapshot was written on the commit before it and
 * must not change: status, every header (cache, CSP, CORS, cookies,
 * redirects) and the body, for a concrete request of every pattern. Brokers,
 * assets, frames, the code form, bad and expired tokens, retired links,
 * missing items, preflights, oversized bodies, other methods, and the
 * credentials the gate judges on the way.
 *
 * It also pins who each handler ran as (the actor the share gate or the
 * render guard named), read inside the stood-in content reads.
 *
 * No database: every read a request reaches is stood in below. A request
 * that would reach the database is not in the sweep (the db broker, rows,
 * aggregate and evaluate run only as far as the share gate).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const OWNER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const PAGE = '44444444-4444-4444-8444-444444444444';
const OTHER_PAGE = '44444444-4444-4444-8444-000000000000';
const DRAW = '77777777-7777-4777-8777-777777777777';
const FILE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTACT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const h = vi.hoisted(() => ({
  actors: [] as string[],
  routes: [] as { what: string; route: string | null; slot: boolean }[],
}));

/** Note who the current code runs as (the actor the gate, the share gate
 *  or the render guard named), and the row and request slot it runs in
 *  (`routes`, outside the snapshot: the step 1 fix round's 'unclassified'
 *  check, below). */
async function seen(what: string): Promise<void> {
  const db = await import('@mantle/db');
  const { currentRoute } = await import('../lib/auth/route-policy');
  const actor = db.currentActor();
  h.actors.push(`${what}: ${actor ? db.actorSetting(actor) : 'none'}`);
  h.routes.push({ what, route: currentRoute()?.key ?? null, slot: db.hasRequestSlot() });
}

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/db')>()),
  loginScopeFor: async (loginId: string) => ({ kind: 'user', loginId, ws: [], modWs: [] }),
  brainOnWorkspacesNow: async () => true,
}));

vi.mock('../lib/auth/login-row', () => ({
  loadLoginRow: async (id: string) =>
    id === '55555555-5555-4555-8555-555555555555'
      ? {
          id,
          email: 'admin@example.invalid',
          displayName: null,
          contactId: null,
          isOwner: false,
          role: 'admin',
          disabledAt: null,
          sessionEpoch: 0,
        }
      : null,
  loadAnchorId: async () => '33333333-3333-4333-8333-333333333333',
  loadPersonalSpaceId: async (id: string) => `${id.slice(0, 8)}-0000-4000-8000-000000000000`,
}));

const SHARES = vi.hoisted(() => {
  const owner = '33333333-3333-4333-8333-333333333333';
  const base = { ownerId: owner, settings: {}, contactId: null, canWrite: false };
  return {
    live: { ...base, id: 'share-live', nodeId: 'note-1', nodeType: 'note' },
    liveapp: { ...base, id: 'share-app', nodeId: 'app-1', nodeType: 'app' },
    gone: { ...base, id: 'share-gone', nodeId: 'note-gone', nodeType: 'note' },
    contact: {
      ...base,
      id: 'share-contact',
      nodeId: 'note-2',
      nodeType: 'note',
      contactId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    },
  } as Record<string, Record<string, unknown>>;
});

const shareByToken = async (token: string) => SHARES[token] ?? null;

vi.mock('@/lib/shares', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shares')>()),
  resolveActiveShareRowByToken: vi.fn(shareByToken),
  resolveActiveShareByToken: vi.fn(shareByToken),
  loadShareView: vi.fn(async (share: { nodeId: string; id: string }) => {
    await seen(`view ${share.id}`);
    if (share.nodeId === 'app-1') return { kind: 'app', appId: 'app-1', title: 'An app' };
    if (share.nodeId === 'note-gone') return null;
    return { kind: 'note', title: 'A note', content: 'Some **text**.' };
  }),
  recordShareView: vi.fn(async () => {}),
  liveServedIds: vi.fn(async (s: { nodeId: string }) => new Set([s.nodeId])),
  isAssetAllowed: vi.fn(async () => {
    await seen('asset');
    return false;
  }),
  isEmbeddedDrawAllowed: vi.fn(async () => {
    await seen('embedded draw');
    return false;
  }),
  isDrawServable: vi.fn(async () => {
    await seen('draw');
    return false;
  }),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  resolveActiveShareRowByToken: vi.fn(shareByToken),
  isRetiredTeamLinkToken: vi.fn(async (token: string) => token === 'team-old'),
  isRetiredClientLinkToken: vi.fn(async (token: string) => token === 'client-old'),
  contactShareGateRow: vi.fn(async (contactId: string) =>
    contactId === 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      ? { ownerId: '33333333-3333-4333-8333-333333333333', codeEpoch: 2, open: true }
      : null,
  ),
  recordShareAccess: vi.fn(() => {}),
  recordAppAccess: vi.fn(() => {}),
  listContactShares: vi.fn(async () => ({ items: [], more: false })),
  loadProfilePreferences: vi.fn(async () => ({ siteName: 'A brain' })),
  checkContactShareCode: vi.fn(async () => ({ ok: false, contactId: null, lockedNow: false })),
  getApp: vi.fn(async () => {
    await seen('app');
    return null;
  }),
  getAppRuntime: vi.fn(async () => {
    await seen('app runtime');
    return { id: 'app-1', publishedBuild: { ok: true }, manifest: { toolSlugs: [] } };
  }),
  getPage: vi.fn(async (_owner: string, id: string) => {
    await seen(`page ${id.slice(-4)}`);
    return id === '44444444-4444-4444-8444-444444444444'
      ? { title: 'Notes', width: 'narrow', doc: { type: 'doc', content: [] } }
      : null;
  }),
  getDrawSvg: vi.fn(async () => {
    await seen('draw svg');
    return '<svg xmlns="http://www.w3.org/2000/svg"/>';
  }),
  getDraw: vi.fn(async () => {
    await seen('draw scene');
    return { scene: { elements: [] }, fileRefs: {} };
  }),
}));

vi.mock('@/lib/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit')>()),
  auditFireAndForget: vi.fn(() => {}),
}));

vi.mock('@/lib/app-frame', () => ({
  renderAppFrame: vi.fn(async () => new Response('<!doctype html>', { status: 200 })),
}));

vi.mock('./pages/appearance', () => ({
  loadAppearanceAttrs: async () => undefined,
  loadShareAppearance: async () => ({
    attrs: undefined,
    defaultMode: 'light',
    neatBackground: null,
  }),
}));

vi.mock('../lib/files', async (orig) => ({
  ...(await orig<typeof import('../lib/files')>()),
  readFileById: async ({ fileId }: { fileId: string }) => {
    await seen('file bytes');
    return fileId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      ? { bytes: Buffer.from('png'), row: { mimeType: 'image/png', filename: 'a.png' } }
      : null;
  },
}));

vi.mock('../lib/access-keys', async (orig) => ({
  ...(await orig<typeof import('../lib/access-keys')>()),
  verifyAccessKey: vi.fn(async () => ({ ok: false, keyId: null, reason: 'unknown' })),
}));

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));

/** A request of the sweep: a label, the path, and how it is sent. */
type Probe = { label: string; path: string; init?: RequestInit };

const ORIGIN = 'https://client.example';

/** A signed value (payload.signature) or a long opaque token: its value
 *  changes with the clock, so the sweep pins its place, not its bytes. */
function normal(text: string): string {
  return text.replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, '<signed>');
}

/** Every answer the two sweeps gave, by label (the check below compares). */
const swept = new Map<string, unknown>();

async function answer(app: import('hono').Hono, p: Probe) {
  h.actors.length = 0;
  h.routes.length = 0;
  const res = await app.request(p.path, p.init);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = normal(v);
  });
  const text = await res.text();
  const html = (res.headers.get('content-type') ?? '').includes('text/html');
  const body =
    html && text.length > 300
      ? `html ${text.length} sha256:${createHash('sha256').update(normal(text)).digest('hex').slice(0, 16)}`
      : normal(text);
  return { status: res.status, headers, body, actors: [...h.actors] };
}

describe.skipIf(!hasManifest)('the /s and /print sweep (A4 step 2: the same answers)', () => {
  const saved = {
    secret: process.env.SESSION_SECRET,
    cors: process.env.MANTLE_API_CORS_ORIGINS,
    detached: process.env.MANTLE_DETACHED_DEV,
    neat: process.env.MANTLE_NEAT_LICENSE_KEY,
  };
  let app: import('hono').Hono;
  let tokens: typeof import('../lib/auth/tokens');

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'link-render-sweep-secret-at-least-32-chars';
    process.env.MANTLE_API_CORS_ORIGINS = ORIGIN;
    delete process.env.MANTLE_DETACHED_DEV;
    delete process.env.MANTLE_NEAT_LICENSE_KEY;
    tokens = await import('../lib/auth/tokens');
    const { createApp } = await import('./app');
    app = await createApp();
  }, 60_000);

  afterAll(() => {
    for (const [k, v] of [
      ['SESSION_SECRET', saved.secret],
      ['MANTLE_API_CORS_ORIGINS', saved.cors],
      ['MANTLE_DETACHED_DEV', saved.detached],
      ['MANTLE_NEAT_LICENSE_KEY', saved.neat],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('answers every /s request as before', async () => {
    const contactCookie = `mantle_contact=${
      tokens.buildContactVisitorValue({ contactId: CONTACT, ownerId: OWNER, codeEpoch: 2 }).value
    }`;
    const withOrigin = { headers: { origin: ORIGIN } };
    const preflight = {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    };
    const post = (body: unknown, extra: Record<string, string> = {}) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, ...extra },
      body: JSON.stringify(body),
    });
    const probes: Probe[] = [
      // The page.
      { label: 'page: open link', path: '/s/live' },
      { label: 'page: open link, sub path', path: '/s/live?p=a%2Fb' },
      { label: 'page: open link, HEAD', path: '/s/live', init: { method: 'HEAD' } },
      { label: 'page: open link, POST', path: '/s/live', init: { method: 'POST' } },
      { label: 'page: open link, Origin', path: '/s/live', init: withOrigin },
      { label: 'page: open link, preflight', path: '/s/live', init: preflight },
      { label: 'page: app link', path: '/s/liveapp' },
      { label: 'page: item gone', path: '/s/gone' },
      { label: 'page: no such token', path: '/s/missing' },
      { label: 'page: expired (not active)', path: '/s/expired' },
      { label: 'page: retired team link', path: '/s/team-old' },
      { label: 'page: retired client link', path: '/s/client-old' },
      { label: 'page: contact share, no cookie', path: '/s/contact' },
      {
        label: 'page: contact share, cookie',
        path: '/s/contact',
        init: { headers: { cookie: contactCookie } },
      },
      {
        label: 'page: contact share, bad cookie',
        path: '/s/contact',
        init: { headers: { cookie: 'mantle_contact=nope' } },
      },
      {
        label: 'page: an API key rides along',
        path: '/s/live',
        init: { headers: { authorization: 'Bearer mtlk_notakey' } },
      },
      {
        label: 'page: a bad bearer rides along',
        path: '/s/live',
        init: { headers: { authorization: 'Bearer nope' } },
      },
      { label: 'bare /s', path: '/s' },
      { label: 'unknown /s sub path', path: '/s/live/nothing-here' },
      { label: 'unknown /s sub path, Origin', path: '/s/live/nothing-here', init: withOrigin },
      { label: 'image suffix under /s', path: '/s/live/a/pic.png' },
      // The JSON view and the rows (brokers a client page calls cross-origin).
      { label: 'view: open link', path: '/s/live/view', init: withOrigin },
      { label: 'view: item gone', path: '/s/gone/view', init: withOrigin },
      { label: 'view: no such token', path: '/s/missing/view', init: withOrigin },
      { label: 'view: contact share, no cookie', path: '/s/contact/view', init: withOrigin },
      {
        label: 'view: contact share, cookie',
        path: '/s/contact/view',
        init: { headers: { origin: ORIGIN, cookie: contactCookie } },
      },
      { label: 'view: preflight', path: '/s/live/view', init: preflight },
      { label: 'view: POST', path: '/s/live/view', init: post({}) },
      { label: 'rows: no such token', path: '/s/missing/rows?tab=t', init: withOrigin },
      { label: 'rows: contact share, no cookie', path: '/s/contact/rows', init: withOrigin },
      { label: 'rows: preflight', path: '/s/live/rows', init: preflight },
      { label: 'aggregate: no such token', path: '/s/missing/aggregate', init: withOrigin },
      { label: 'aggregate: contact, no cookie', path: '/s/contact/aggregate' },
      // The app brokers.
      { label: 'bundle: app link', path: '/s/liveapp/bundle', init: withOrigin },
      { label: 'bundle: note link', path: '/s/live/bundle', init: withOrigin },
      { label: 'bundle: no such token', path: '/s/missing/bundle', init: withOrigin },
      { label: 'bundle: contact, no cookie', path: '/s/contact/bundle', init: withOrigin },
      { label: 'bundle: preflight', path: '/s/liveapp/bundle', init: preflight },
      { label: 'bundle css: app link', path: '/s/liveapp/bundle/css', init: withOrigin },
      { label: 'bundle css: no such token', path: '/s/missing/bundle/css' },
      { label: 'bundle css: preflight', path: '/s/liveapp/bundle/css', init: preflight },
      { label: 'frame ticket: app link', path: '/s/liveapp/frame-ticket', init: post({}) },
      { label: 'frame ticket: note link', path: '/s/live/frame-ticket', init: post({}) },
      { label: 'frame ticket: no such token', path: '/s/missing/frame-ticket', init: post({}) },
      {
        label: 'frame ticket: contact, no cookie',
        path: '/s/contact/frame-ticket',
        init: post({}),
      },
      { label: 'frame ticket: GET', path: '/s/liveapp/frame-ticket', init: withOrigin },
      { label: 'frame ticket: preflight', path: '/s/liveapp/frame-ticket', init: preflight },
      { label: 'tool broker: open link', path: '/s/liveapp/tool-broker', init: post({}) },
      { label: 'tool broker: note link', path: '/s/live/tool-broker', init: post({}) },
      { label: 'tool broker: no such token', path: '/s/missing/tool-broker', init: post({}) },
      { label: 'tool broker: contact, no cookie', path: '/s/contact/tool-broker', init: post({}) },
      { label: 'tool broker: preflight', path: '/s/liveapp/tool-broker', init: preflight },
      { label: 'db broker: no such token', path: '/s/missing/db-broker', init: post({}) },
      { label: 'db broker: contact, no cookie', path: '/s/contact/db-broker', init: post({}) },
      { label: 'db broker: GET', path: '/s/liveapp/db-broker', init: withOrigin },
      { label: 'db broker: preflight', path: '/s/liveapp/db-broker', init: preflight },
      {
        label: 'db broker: body over the ceiling',
        path: '/s/liveapp/db-broker',
        init: post({}, { 'content-length': String(64 * 1024 * 1024) }),
      },
      // Same-origin surfaces: no CORS, even with an Origin.
      { label: 'frame: app link, no ticket', path: '/s/liveapp/frame', init: withOrigin },
      { label: 'frame: app link, bad ticket', path: '/s/liveapp/frame?t=nope' },
      { label: 'frame: note link', path: '/s/live/frame' },
      { label: 'frame: no such token', path: '/s/missing/frame' },
      { label: 'frame: contact, no ticket', path: '/s/contact/frame' },
      { label: 'frame: preflight', path: '/s/liveapp/frame', init: preflight },
      { label: 'asset: not served', path: `/s/live/a/${FILE}`, init: withOrigin },
      { label: 'asset: no such token', path: `/s/missing/a/${FILE}` },
      { label: 'asset: contact, no cookie', path: `/s/contact/a/${FILE}` },
      { label: 'asset: preflight', path: `/s/live/a/${FILE}`, init: preflight },
      { label: 'draw: not servable', path: '/s/live/draw', init: withOrigin },
      { label: 'draw: no such token', path: '/s/missing/draw' },
      { label: 'draw: contact, no cookie', path: '/s/contact/draw' },
      { label: 'embedded draw: not allowed', path: `/s/live/draw/${DRAW}`, init: withOrigin },
      { label: 'embedded draw: no such token', path: `/s/missing/draw/${DRAW}` },
      { label: 'evaluate: no such token', path: '/s/missing/evaluate', init: post({}) },
      { label: 'evaluate: contact, no cookie', path: '/s/contact/evaluate', init: post({}) },
      { label: 'evaluate: preflight', path: '/s/live/evaluate', init: preflight },
      { label: 'code: wrong code', path: '/s/contact/code', init: post({ code: '000000' }) },
      { label: 'code: no such token', path: '/s/missing/code', init: post({ code: '1' }) },
      { label: 'code: GET', path: '/s/contact/code' },
      { label: 'code: preflight', path: '/s/contact/code', init: preflight },
      // A static segment spelled with escapes: the router decodes it, the
      // gate's credential checks read the path as sent.
      { label: 'escaped: page prefix', path: '/%73/live' },
      { label: 'escaped: page token', path: '/s/%6Cive' },
      { label: 'escaped: view', path: '/s/live/%76iew', init: withOrigin },
      { label: 'escaped: bundle preflight', path: '/s/liveapp/%62undle', init: preflight },
      { label: 'escaped: public API route', path: '/api/%76ersion' },
      { label: 'image suffix on a non-public route', path: '/api/files/files/x.png' },
    ];
    const answers: Record<string, unknown> = {};
    for (const p of probes)
      answers[p.label] = swept.set(p.label, await answer(app, p)).get(p.label);
    expect(answers).toMatchSnapshot();
  });

  it('answers every /print and /render request as before', async () => {
    const render = (nodeId: string) =>
      `mantle_render=${tokens.buildRenderToken({ ownerId: OWNER, actorId: ADMIN, nodeId })}`;
    const session = `mantle_session=${tokens.buildSessionCookie(ADMIN).value}`;
    const withCookie = (cookie: string, method = 'GET') => ({ method, headers: { cookie } });
    const probes: Probe[] = [
      { label: 'print page: no credential', path: `/print/pages/${PAGE}` },
      {
        label: 'print page: render cookie',
        path: `/print/pages/${PAGE}`,
        init: withCookie(render(PAGE)),
      },
      {
        label: 'print page: render cookie, HEAD',
        path: `/print/pages/${PAGE}`,
        init: withCookie(render(PAGE), 'HEAD'),
      },
      {
        label: 'print page: render cookie, POST',
        path: `/print/pages/${PAGE}`,
        init: withCookie(render(PAGE), 'POST'),
      },
      {
        label: 'print page: render cookie for another node',
        path: `/print/pages/${OTHER_PAGE}`,
        init: withCookie(render(PAGE)),
      },
      {
        label: 'print page: render cookie, missing page',
        path: `/print/pages/${OTHER_PAGE}`,
        init: withCookie(render(OTHER_PAGE)),
      },
      {
        label: 'print page: render token as the session cookie',
        path: `/print/pages/${PAGE}`,
        init: withCookie(`mantle_session=${render(PAGE).split('=')[1]}`),
      },
      { label: 'print page: session', path: `/print/pages/${PAGE}`, init: withCookie(session) },
      {
        label: 'print page: session, POST',
        path: `/print/pages/${PAGE}`,
        init: withCookie(session, 'POST'),
      },
      {
        label: 'print page: bad bearer',
        path: `/print/pages/${PAGE}`,
        init: { headers: { authorization: 'Bearer nope' } },
      },
      {
        label: 'print page: an API key',
        path: `/print/pages/${PAGE}`,
        init: { headers: { authorization: 'Bearer mtlk_notakey' } },
      },
      {
        label: 'print page: Origin',
        path: `/print/pages/${PAGE}`,
        init: { headers: { origin: ORIGIN, cookie: render(PAGE) } },
      },
      { label: 'print draw: no credential', path: `/print/draws/${DRAW}` },
      {
        label: 'print draw: render cookie',
        path: `/print/draws/${DRAW}`,
        init: withCookie(render(DRAW)),
      },
      {
        label: 'print draw: render cookie for another node',
        path: `/print/draws/${DRAW}`,
        init: withCookie(render(PAGE)),
      },
      { label: 'render draw: no credential', path: `/render/draws/${DRAW}` },
      {
        label: 'render draw: render cookie',
        path: `/render/draws/${DRAW}`,
        init: withCookie(render(DRAW)),
      },
      {
        label: 'render draw: render cookie, HEAD',
        path: `/render/draws/${DRAW}`,
        init: withCookie(render(DRAW), 'HEAD'),
      },
      { label: 'unknown print path: no credential', path: '/print/other' },
      {
        label: 'unknown print path: render cookie',
        path: `/print/pages/${PAGE}/more`,
        init: withCookie(render(PAGE)),
      },
      {
        label: 'unknown render path: session',
        path: '/render/other/x',
        init: withCookie(session),
      },
      // The byte routes a render surface loads, and the ones it may not.
      {
        label: 'page image: render cookie',
        path: `/api/files/files/${FILE}?raw=1`,
        init: withCookie(render(PAGE)),
      },
      {
        label: 'page image: render cookie, HEAD',
        path: `/api/files/files/${FILE}?raw=1`,
        init: withCookie(render(PAGE), 'HEAD'),
      },
      {
        label: 'page image: render cookie, PATCH',
        path: `/api/files/files/${FILE}`,
        init: withCookie(render(PAGE), 'PATCH'),
      },
      { label: 'page image: no credential', path: `/api/files/files/${FILE}?raw=1` },
      {
        label: 'files deeper: render cookie',
        path: `/api/files/files/${FILE}/x`,
        init: withCookie(render(PAGE)),
      },
      {
        label: 'admin private bytes: render cookie',
        path: `/api/admin/space/${FILE}/bytes`,
        init: withCookie(render(PAGE)),
      },
      { label: 'pages API: render cookie', path: '/api/pages', init: withCookie(render(PAGE)) },
      {
        label: 'escaped: print page, render cookie',
        path: `/print/%70ages/${PAGE}`,
        init: withCookie(render(PAGE)),
      },
      {
        label: 'escaped: page image, render cookie',
        path: `/api/%66iles/files/${FILE}?raw=1`,
        init: withCookie(render(PAGE)),
      },
    ];
    const answers: Record<string, unknown> = {};
    for (const p of probes)
      answers[p.label] = swept.set(p.label, await answer(app, p)).get(p.label);
    expect(answers).toMatchSnapshot();
  });

  // A4 step 1 fix round 1 refuses a request slot with no ROUTE_POLICY row
  // ('unclassified', session.ts guardRoute). The /s page, its brokers and
  // the render pages are routed since step 2, so each carries its row on
  // the request context: a page runs in an actor slot (no request slot, no
  // guard), a broker in a request slot that has its row. Neither can meet
  // the refusal, and the answers are the sweep's.
  it("binds a row on every /s and /print request, so 'unclassified' never fires", async () => {
    const ORIGIN_ONLY = { headers: { origin: ORIGIN } };
    const render = `mantle_render=${tokens.buildRenderToken({ ownerId: OWNER, actorId: ADMIN, nodeId: PAGE })}`;
    const cases: {
      label: string;
      path: string;
      init?: RequestInit;
      route: string;
      slot: boolean;
    }[] = [
      { label: 'page: open link', path: '/s/live', route: 'GET /s/:token', slot: false },
      { label: 'page: app link', path: '/s/liveapp', route: 'GET /s/:token', slot: false },
      {
        label: 'view: open link',
        path: '/s/live/view',
        init: ORIGIN_ONLY,
        route: 'GET /s/:token/view',
        slot: true,
      },
      {
        label: 'bundle: app link',
        path: '/s/liveapp/bundle',
        init: ORIGIN_ONLY,
        route: 'GET /s/:token/bundle',
        slot: true,
      },
      {
        label: 'print page: render cookie',
        path: `/print/pages/${PAGE}`,
        init: { headers: { cookie: render } },
        route: 'GET /print/pages/:id',
        slot: false,
      },
    ];
    for (const c of cases) {
      const got = await answer(app, c);
      // The same answer as the sweep (its snapshot is the step 1 code's).
      expect(swept.has(c.label), c.label).toBe(true);
      expect(got, c.label).toEqual(swept.get(c.label));
      expect(got.body, c.label).not.toContain('unclassified');
      // The handler reached its reads, each with its row on the request.
      expect(h.routes.length, c.label).toBeGreaterThan(0);
      for (const r of h.routes) {
        expect(r, `${c.label}: ${r.what}`).toEqual({ what: r.what, route: c.route, slot: c.slot });
      }
    }
  });
});
