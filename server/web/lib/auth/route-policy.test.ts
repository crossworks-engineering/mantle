/**
 * ROUTE_POLICY (route-policy.ts, arch A4 step 1): one row for every route
 * of the manifest and every method it is called with, and each field gives
 * exactly the answer of the list it folds, so moving the session guards
 * and the gate onto the row changed no answer (the route sweep of the
 * step). The guards read the row through these same readers
 * (memberOpenRead, memberOpenWrite, anyLoginRow, routeItemTarget); the
 * HTTP sweeps (auth-sweep, role-sweep, member-sweep and the W6a route
 * sweep on a database) drive the real app per login kind.
 *
 * Also pinned: the gate's policy of every row lets each HTTP caller through
 * steps 3 to 5 (gateCheck), so enterCall refuses no routed request in step
 * 1; the guards still decide, as before.
 *
 * A4 step 2: the pages of server/pages (the /s page, the render surfaces)
 * have rows too and run through enterCall, and the gate reads a routed
 * request's credential answers from its row (gateRouteView). Pinned: the
 * same answers as the path checks they replace (the old SHARE_BROKER_RE
 * and isRenderPath, copied below as they were) and PUBLIC_PATHS, for every
 * pattern, method and a path spelled with escapes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actorSetting,
  currentActor,
  currentCaller,
  gateCheck,
  hasRequestSlot,
  systemActor,
  type CallerVia,
  type GateCaller,
} from '@mantle/db';
import { ensureGateReady } from '@mantle/tools/gate-narrowers';
import { ACCESS_KEY_AREAS, type AccessKeyArea } from '../access-keys';
import { API_V1_ROUTES, keyMayCall, matchApiV1Route } from '../api-v1';
import { isPublicPath } from '../auth-constants';
import { isAnyLoginRoute } from './any-login-routes';
import { isMemberRoute } from './member-routes';
import {
  CREATE_ROUTES,
  isReadRequest,
  itemWriteTarget,
  memberMayRead,
  memberMayWrite,
  routeClass,
} from './route-scope';
import {
  anyLoginRow,
  buildRoutePolicy,
  currentRoute,
  memberOpenRead,
  memberOpenWrite,
  registerRouteSource,
  requestKeyRoute,
  routeItemTarget,
  routeRef,
  rowKeyRoute,
  servedMethods,
  spellsPattern,
  type RouteRow,
} from './route-policy';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '../..');
const hasManifest = existsSync(join(webRoot, 'server/route-manifest.gen.ts'));

const ALL_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/** Two concrete paths for a pattern, so a field that read a param's value
 *  would show. */
function pathsOf(pattern: string): string[] {
  return [
    pattern
      .replace(/:[A-Za-z0-9_]+\??/g, '11111111-1111-4111-8111-111111111111')
      .replace(/\*$/, 'a/b'),
    pattern.replace(/:[A-Za-z0-9_]+\??/g, 'x').replace(/\*$/, 'z'),
  ];
}

type Manifest = Array<{ pattern: string; methods: string[] }>;

describe.skipIf(!hasManifest)('ROUTE_POLICY: same answers as the lists', () => {
  let manifest: Manifest;
  let table: ReadonlyMap<string, RouteRow>;

  beforeAll(async () => {
    manifest = (await import('../../server/route-manifest.gen')).routeManifest;
    table = buildRoutePolicy(manifest);
  });

  it('has a row for every route and served method, and none for another method', () => {
    let rows = 0;
    for (const e of manifest) {
      const served = servedMethods(e);
      for (const m of ALL_METHODS) {
        const row = table.get(`${m} ${e.pattern}`);
        if (served.includes(m)) {
          expect(row, `${m} ${e.pattern}`).toBeDefined();
          expect(row!.method).toBe(m);
          expect(row!.pattern).toBe(e.pattern);
          rows += 1;
        } else {
          expect(row, `${m} ${e.pattern}`).toBeUndefined();
        }
      }
    }
    expect(table.size).toBe(rows);
    expect(rows).toBeGreaterThan(600);
  });

  it('every field answers what its list answers', () => {
    const diffs: string[] = [];
    const check = (key: string, what: string, got: unknown, want: unknown) => {
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        diffs.push(`${key} ${what}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
      }
    };
    for (const row of table.values()) {
      const { method: m, pattern: p, key } = row;
      check(key, 'scope', row.scope, routeClass(p));
      check(
        key,
        'area',
        row.area,
        routeClass(p)?.kind === 'area' ? (routeClass(p) as { area: string }).area : null,
      );
      check(key, 'effect', row.effect, isReadRequest(m, p) ? 'read' : 'write');
      check(key, 'memberMayRead', memberOpenRead(row), memberMayRead(m, p));
      check(key, 'memberMayWrite', memberOpenWrite(row), memberMayWrite(m, p));
      check(key, 'isAnyLoginRoute', anyLoginRow(row), isAnyLoginRoute(m, p));
      check(key, 'isMemberRoute', row.logins === 'member', isMemberRoute(m, p));
      check(key, 'open', row.open, row.logins ? 'login' : 'admin');
      check(key, 'creates', row.creates, CREATE_ROUTES.has(`${m} ${p}`));
      for (const path of pathsOf(p)) {
        const target = itemWriteTarget(m, p, path);
        check(`${key} @${path}`, 'item', routeItemTarget(row, path), target);
        // What requestCreatePolicy answered before A4.
        check(
          `${key} @${path}`,
          'makesItems',
          row.makesItems,
          !(m === 'DELETE' || target?.need === 'read'),
        );
        check(`${key} @${path}`, 'public', row.public, isPublicPath(path));
      }
    }
    expect(diffs).toEqual([]);
  });

  it('classes every row (plan 7)', () => {
    for (const row of table.values()) {
      // 'render' is a page's class only (registerPages, PRINT_PAGES).
      expect(row.class, row.key).not.toBe('render');
      if (row.pattern.startsWith('/s/')) expect(row.class, row.key).toBe('link');
      else if (row.scope) expect(row.class, row.key).toBe(row.scope.kind);
      else if (row.public) expect(row.class, row.key).toBe('public');
      else expect(row.class, row.key).toBe('self');
    }
  });

  it('a v1 row: its key area and effect are the key table, its alias the file it re-exports', () => {
    const v1 = [...table.values()].filter((r) => r.pattern.startsWith('/api/v1/'));
    expect(v1.length).toBeGreaterThan(API_V1_ROUTES.length);
    for (const row of v1) {
      for (const path of pathsOf(row.pattern)) {
        const route = matchApiV1Route(row.method, path);
        // api-v1.test.ts pins the key table to the route files.
        expect(route, row.key).not.toBeNull();
        expect(row.keyArea, row.key).toBe(route!.area);
        // The gate's caller carries the key's write switch: the read-only
        // narrower meets only what gateAccessKey refused already.
        expect(row.effect === 'write', row.key).toBe(route!.access === 'write');
      }
      const file = join(webRoot, 'app', row.pattern.replace(/:(\w+)/g, '[$1]'), 'route.ts');
      const src = readFileSync(file, 'utf8');
      const m = row.method === 'HEAD' ? 'GET' : row.method;
      const reExports = new RegExp(`export \\{[^}]*\\b${m}\\b[^}]*\\} from`).test(src);
      // An alias re-exports its base; a row with none has a handler of its
      // own (or no base route).
      expect(reExports, row.key).toBe(row.aliasOf !== null);
    }
    expect(table.get('GET /api/v1/pages')?.aliasOf).toBe('GET /api/pages');
    expect(table.get('GET /api/v1/files/:id')?.aliasOf).toBe('GET /api/files/files/:id');
    expect(table.get('GET /api/v1/whoami')?.aliasOf).toBeNull();
    for (const row of table.values()) {
      if (!row.pattern.startsWith('/api/v1/')) expect('keyArea' in row, row.key).toBe(false);
    }
  });

  it("the gate's policy of every row lets every HTTP caller through steps 3 to 5", () => {
    ensureGateReady();
    registerRouteSource();
    const vias: CallerVia[] = ['cookie', 'bearer', 'token', 'public', 'unjudged', 'key'];
    for (const row of table.values()) {
      for (const via of vias) {
        const caller: GateCaller = {
          actor: systemActor('http:no-login'),
          via,
          ...(via === 'key' ? { write: row.effect === 'write' } : {}),
          admin: null,
          enterScope: (_w, fn) => fn(),
        };
        expect(gateCheck(caller, routeRef(row)), `${via} ${row.key}`).toBeNull();
      }
    }
  });

  it('whoami is the one v1 row about the key itself (keySelf)', () => {
    for (const row of table.values()) {
      if (!row.pattern.startsWith('/api/v1/')) {
        expect('keySelf' in row, row.key).toBe(false);
        continue;
      }
      expect(row.keySelf, row.key).toBe(row.pattern === '/api/v1/whoami');
    }
    expect(table.get('GET /api/v1/whoami')?.keySelf).toBe(true);
    expect(table.get('HEAD /api/v1/whoami')?.keySelf).toBe(true);
  });

  // The key narrower is driven here with the areas set on the caller by
  // hand: the HTTP caller (gate.ts httpCaller) sets none, so on HTTP it
  // does not run and gateAccessKey and accessKeyLogin judge the areas.
  // This pins it for when a step sets them.
  it("an API key: the gate's key narrower and the row answer what keyMayCall answers by path, on every v1 row", () => {
    ensureGateReady();
    registerRouteSource();
    const areaSets: (readonly AccessKeyArea[] | null)[] = [
      null,
      [],
      ['pages'],
      ['search'],
      ['files', 'search'],
      ['tasks', 'notes', 'tables'],
      ['calendar', 'contacts', 'journal'],
      [...ACCESS_KEY_AREAS],
    ];
    const v1 = [...table.values()].filter((r) => r.pattern.startsWith('/api/v1/'));
    const diffs: string[] = [];
    let checked = 0;
    for (const row of v1) {
      for (const areas of areaSets) {
        for (const access of ['read', 'read_write'] as const) {
          const caller: GateCaller = {
            actor: systemActor('http:no-login'),
            via: 'key',
            write: access === 'read_write',
            admin: null,
            enterScope: (_w, fn) => fn(),
            facts: { keyAreas: areas },
          };
          const gate = gateCheck(caller, routeRef(row)) === null;
          const onRow = keyMayCall({ access, areas }, rowKeyRoute(row)).ok;
          for (const path of pathsOf(row.pattern)) {
            const byPath = keyMayCall({ access, areas }, matchApiV1Route(row.method, path)).ok;
            const what = `${row.key} @${path} ${access} ${JSON.stringify(areas)}`;
            if (gate !== byPath) diffs.push(`${what}: gate ${gate}, keyMayCall ${byPath}`);
            if (onRow !== byPath) diffs.push(`${what}: row ${onRow}, keyMayCall ${byPath}`);
            // What the gate and the guard ask (the row where the raw path
            // names it): the same answer on a plain path.
            const onRequest = keyMayCall({ access, areas }, requestKeyRoute(row, path)).ok;
            if (onRequest !== byPath) {
              diffs.push(`${what}: request ${onRequest}, keyMayCall ${byPath}`);
            }
            checked += 1;
          }
        }
      }
    }
    expect(diffs).toEqual([]);
    expect(checked).toBeGreaterThan(500);
    // Off the key table no key is let in (not in the API).
    expect(rowKeyRoute(table.get('GET /api/version')!)).toBeNull();
    expect(rowKeyRoute(null)).toBeNull();
  });

  // requestKeyRoute asks the one spelling test (spellsPattern) where fix
  // round 2 asked the key table (matchApiV1Route named the row's pattern).
  // The same answer on every row, for every spelling a request routed to
  // it can have: plain, a static segment escaped, a param escaped, and a
  // longer path. A trailing slash is the one spelling the key table read
  // and the spelling test does not, and no row answers it (the router is
  // strict): gate-route.test.ts pins that on the wire.
  it("requestKeyRoute: the spelling test answers fix round 2's key-table test, on every row", () => {
    const roundTwo = (row: RouteRow, rawPath: string) => {
      const raw = matchApiV1Route(row.method, rawPath);
      return raw && raw.pattern === row.pattern ? rowKeyRoute(row) : null;
    };
    const diffs: string[] = [];
    let keyed = 0;
    for (const row of table.values()) {
      const spellings = [
        ...pathsOf(row.pattern),
        ...escapedPathsOf(row.pattern),
        `${pathsOf(row.pattern)[0]}/extra`,
      ];
      for (const path of spellings) {
        const want = roundTwo(row, path);
        const got = requestKeyRoute(row, path);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          diffs.push(`${row.key} @${path}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
        }
        if (got) keyed += 1;
      }
      expect(requestKeyRoute(row, `${pathsOf(row.pattern)[0]}/`), row.key).toBeNull();
    }
    expect(diffs).toEqual([]);
    // Most v1 rows were let in on a plain spelling: not null against null.
    expect(keyed).toBeGreaterThan(API_V1_ROUTES.length);
    expect(requestKeyRoute(null, '/api/v1/pages')).toBeNull();
  });

  it('M3 (owner question for A4 step 4): HEAD of an any-login GET is open to Admin only', () => {
    // Today's answer, pinned so a change is deliberate: HEAD has the GET's
    // class; the owner routes a login outside Admin may read open their
    // HEAD too (memberMayRead reads HEAD as GET), but the any-login, chat,
    // Telegram and member lists name GET only, so such a HEAD row has
    // logins null and is open to Admin only.
    const byGet = new Map<string, number>();
    for (const row of table.values()) {
      if (row.method !== 'HEAD') continue;
      const get = table.get(`GET ${row.pattern}`)!;
      expect(row.class, row.key).toBe(get.class);
      if (get.logins === null || get.logins === 'owner') {
        expect(row.logins, row.key).toBe(get.logins);
        continue;
      }
      expect(row.logins, row.key).toBeNull();
      expect(row.open, row.key).toBe('admin');
      byGet.set(get.logins, (byGet.get(get.logins) ?? 0) + 1);
    }
    expect(byGet.get('any')).toBeGreaterThan(0);
    // The audit's case: an any-login GET of class 'self' whose HEAD is
    // class 'self', logins null, open 'admin'.
    const selfHeads = [...table.values()].filter(
      (r) =>
        r.method === 'HEAD' &&
        r.class === 'self' &&
        table.get(`GET ${r.pattern}`)?.logins === 'any',
    );
    expect(selfHeads.length).toBeGreaterThan(0);
    for (const r of selfHeads) expect(r, r.key).toMatchObject({ logins: null, open: 'admin' });
  });
});

describe.skipIf(!hasManifest)('the gate middleware finds the row once and enters the call', () => {
  const saved = process.env.SESSION_SECRET;
  let app: Hono;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'route-policy-test-secret-that-is-at-least-32-chars';
    const { gate } = await import('../../server/middleware/gate');
    const { registerPages, registerRoutes } = await import('../../server/route-loader');
    const seen = async () =>
      Response.json({
        route: currentRoute()?.key ?? null,
        via: currentCaller()?.via ?? null,
        slot: hasRequestSlot(),
      });
    app = new Hono();
    app.use('*', gate());
    // Real patterns of the manifest (their real rows), with a handler that
    // reports what it runs in.
    registerRoutes(app, [
      {
        pattern: '/api/version',
        methods: ['GET'],
        catchAll: null,
        catchAllOptional: false,
        load: async () => ({ GET: seen }),
      },
    ]);
    // The pages of server/pages (A4 step 2): their real patterns, a handler
    // that reports what it runs in.
    const page = async () => {
      const actor = currentActor();
      return Response.json({
        route: currentRoute()?.key ?? null,
        via: currentCaller()?.via ?? null,
        slot: hasRequestSlot(),
        actor: actor ? actorSetting(actor) : null,
      });
    };
    registerPages(app, [{ pattern: '/s/:token', methods: ['GET'], handle: page }], 'link');
    registerPages(app, [{ pattern: '/print/pages/:id', methods: ['GET'], handle: page }], 'render');
    app.notFound(() =>
      Response.json({ route: currentRoute()?.key ?? null, slot: hasRequestSlot() }),
    );
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = saved;
  });

  it('a routed request runs in the call: its row bound, the request slot open', async () => {
    const res = await app.request('/api/version');
    expect(await res.json()).toEqual({ route: 'GET /api/version', via: 'public', slot: true });
    const head = await app.request('/api/version', { method: 'HEAD' });
    expect(head.status).toBe(200);
  });

  it('a page runs in the call: its row bound, its own actor slot, no request slot', async () => {
    const share = await app.request('/s/abc');
    expect(await share.json()).toEqual({
      route: 'GET /s/:token',
      via: 'public',
      slot: false,
      actor: 'system:http:share-page',
    });
    const cookie = `mantle_render=${(await import('./tokens')).buildRenderToken({
      ownerId: '33333333-3333-4333-8333-333333333333',
      actorId: '55555555-5555-4555-8555-555555555555',
      nodeId: 'n1',
    })}`;
    const print = await app.request('/print/pages/n1', { headers: { cookie } });
    expect(await print.json()).toEqual({
      route: 'GET /print/pages/:id',
      via: 'token',
      slot: false,
      actor: 'system:http:render',
    });
    // No credential: the gate's login redirect, before the page.
    expect((await app.request('/print/pages/n1')).status).toBe(307);
  });

  it('a request no route answers runs as before: no row, no slot', async () => {
    const res = await app.request('/api/version/nope');
    expect(await res.json()).toEqual({ route: null, slot: false });
  });
});

// ── A4 step 2 ───────────────────────────────────────────────────────────────

/** The gate's path checks before A4 step 2, as they were (gate.ts and
 *  auth-constants.ts at the step 1 head): what the rows must answer. */
const OLD_SHARE_BROKER_RE =
  /^\/s\/[^/]+\/(bundle(\/css)?|frame-ticket|tool-broker|db-broker|view|rows)$/;
const OLD_RENDER_PAGE_RE = /^\/(?:print\/pages|print\/draws|render\/draws)\/[^/]+$/;
const OLD_RENDER_ASSET_RE = /^\/api\/(?:files\/files\/[^/]+|draws\/[^/]+\/svg)$/;

/** A path that spells the pattern's first static segment with an escape
 *  (`/s/x` as `/%73/x`), and one with an escape in each later one. */
function escapedPathsOf(pattern: string): string[] {
  const concrete = pathsOf(pattern)[1]!;
  const segs = concrete.split('/');
  const esc = (seg: string) =>
    seg && /^[a-z]/.test(seg)
      ? `%${seg.charCodeAt(0).toString(16).toUpperCase()}${seg.slice(1)}`
      : seg;
  const out: string[] = [];
  for (let i = 1; i < segs.length; i++) {
    const copy = [...segs];
    copy[i] = esc(copy[i]!);
    out.push(copy.join('/'));
  }
  return out;
}

describe.skipIf(!hasManifest)('A4 step 2: the pages have rows, and the gate reads the row', () => {
  let manifest: Manifest;
  let pages: Array<{ pattern: string; methods: readonly string[] }>;
  let printPatterns: Set<string>;
  let pageTable: ReadonlyMap<string, RouteRow>;
  let app: Hono;

  beforeAll(async () => {
    manifest = (await import('../../server/route-manifest.gen')).routeManifest;
    const { SHARE_PAGES } = await import('../../server/pages/share');
    const { PRINT_PAGES } = await import('../../server/pages/print');
    pages = [...SHARE_PAGES, ...PRINT_PAGES];
    printPatterns = new Set(PRINT_PAGES.map((p) => p.pattern));
    // Each list with its class, as app.ts registers them.
    pageTable = new Map([
      ...buildRoutePolicy(SHARE_PAGES, { page: 'link' }),
      ...buildRoutePolicy(PRINT_PAGES, { page: 'render' }),
    ]);
    const { gateRouteView, requestRow } = await import('../../server/middleware/gate');
    const { registerPages, registerRoutes, servedRoute } =
      await import('../../server/route-loader');
    // The app's own routes and pages; the first handler answers what the
    // gate would read, so no route ever runs.
    app = new Hono();
    app.use('*', async (c) => {
      const path = new URL(c.req.url).pathname;
      const route = servedRoute(c);
      const v = gateRouteView(route, requestRow(route, c.req.method), path);
      // A header, so a HEAD request reads it too.
      const view = JSON.stringify({
        byRow: v.byRow,
        public: v.public,
        cors: v.cors,
        renderCookie: v.renderCookie,
      });
      return new Response(null, { status: 204, headers: { 'x-view': view } });
    });
    registerRoutes(app, manifest as never);
    const stub = () => new Response(null);
    registerPages(
      app,
      SHARE_PAGES.map((p) => ({ ...p, handle: stub })),
      'link',
    );
    registerPages(
      app,
      PRINT_PAGES.map((p) => ({ ...p, handle: stub })),
      'render',
    );
  });

  it('the /s page is a link row and the render surfaces render rows: pages, in their own slot', () => {
    expect([...pageTable.keys()].sort()).toEqual(
      [
        'GET /s/:token',
        'HEAD /s/:token',
        'GET /print/pages/:id',
        'HEAD /print/pages/:id',
        'GET /print/draws/:id',
        'HEAD /print/draws/:id',
        'GET /render/draws/:id',
        'HEAD /render/draws/:id',
      ].sort(),
    );
    for (const row of pageTable.values()) {
      expect(row.page, row.key).toBe(true);
      expect(row.effect, row.key).toBe('read');
      expect(row.cors, row.key).toBe(false);
      if (row.pattern === '/s/:token') {
        expect(row.class).toBe('link');
        expect(row.public).toBe(true);
        expect(row.startsAs).toBe('http:share-page');
        expect(row.renderCookie).toBe(false);
      } else {
        expect(row.class, row.key).toBe('render');
        expect(row.public, row.key).toBe(false);
        expect(row.startsAs, row.key).toBe('http:render');
        expect(row.renderCookie, row.key).toBe(row.method === 'GET');
      }
    }
    const table = buildRoutePolicy(manifest);
    for (const row of table.values()) {
      expect(row.page, row.key).toBe(false);
      expect(row.startsAs, row.key).toBe('http:no-login');
    }
  });

  it("the gate's policy of every page row lets every HTTP caller through steps 3 to 5", () => {
    ensureGateReady();
    registerRouteSource();
    for (const row of pageTable.values()) {
      for (const via of ['cookie', 'bearer', 'token', 'public'] as CallerVia[]) {
        const caller: GateCaller = {
          actor: systemActor(row.startsAs),
          via,
          admin: null,
          enterScope: (_w, fn) => fn(),
        };
        expect(gateCheck(caller, routeRef(row)), `${via} ${row.key}`).toBeNull();
      }
    }
  });

  it('the render rows are the print page list, and only it', () => {
    for (const row of pageTable.values()) {
      expect(row.class === 'render', row.key).toBe(printPatterns.has(row.pattern));
    }
    expect(printPatterns.size).toBe(3);
  });

  it('a page the lists class otherwise is refused', () => {
    // A link page outside /s, a render page on a route the lists class.
    expect(() =>
      buildRoutePolicy([{ pattern: '/api/pages', methods: ['GET'] }], { page: 'link' }),
    ).toThrow(/page of class link; the lists class it content/);
    expect(() =>
      buildRoutePolicy([{ pattern: '/print/x/:id', methods: ['GET'] }], { page: 'link' }),
    ).toThrow(/page of class link; the lists class it not at all/);
    expect(() =>
      buildRoutePolicy([{ pattern: '/api/pages', methods: ['GET'] }], { page: 'render' }),
    ).toThrow(/page of class render/);
    expect(() =>
      buildRoutePolicy([{ pattern: '/s/:token', methods: ['GET'] }], { page: 'render' }),
    ).toThrow(/page of class render; the lists class it link/);
    // Off a page list, a pattern no list classes has no class at all.
    expect(() => buildRoutePolicy([{ pattern: '/print/pages/:id', methods: ['GET'] }])).toThrow(
      /has no class/,
    );
  });

  it('spellsPattern: the path as sent spells the pattern', () => {
    expect(spellsPattern('/s/:token/view', '/s/abc/view')).toBe(true);
    expect(spellsPattern('/s/:token/view', '/s/a%2Fb/view')).toBe(true);
    expect(spellsPattern('/s/:token/view', '/s/abc/%76iew')).toBe(false);
    expect(spellsPattern('/s/:token/view', '/s//view')).toBe(false);
    expect(spellsPattern('/s/:token/view', '/s/abc/view/x')).toBe(false);
    expect(spellsPattern('/api/x.y', '/api/xzy')).toBe(false);
    expect(spellsPattern('/a/*', '/a')).toBe(true);
    expect(spellsPattern('/a/*', '/a/b/c')).toBe(true);
    expect(spellsPattern('/a/*', '/ab')).toBe(false);
  });

  it('public, CORS and the render cookie: the same answers as the path checks they replace', async () => {
    const paths = new Set<string>([
      '/s',
      '/s/x/unknown',
      '/s/x/a/b/c',
      '/print',
      '/print/other',
      '/print/pages/x/more',
      '/render/draws',
      '/api/files/files/a/b',
      '/api/draws/x/svg/more',
      '/api/nothing-here',
      '/login',
      '/pair',
      '/app-runtime/x.js',
    ]);
    for (const e of [...manifest, ...pages]) {
      for (const p of pathsOf(e.pattern)) paths.add(p);
      for (const p of escapedPathsOf(e.pattern)) paths.add(p);
      paths.add(`${pathsOf(e.pattern)[0]}/extra`);
    }
    const diffs: string[] = [];
    let routed = 0;
    for (const path of paths) {
      for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS']) {
        const res = await app.request(path, { method });
        const got = JSON.parse(res.headers.get('x-view')!) as {
          byRow: boolean;
          public: boolean;
          cors: boolean;
          renderCookie: boolean;
        };
        if (got.byRow) routed += 1;
        const isApi = path === '/api' || path.startsWith('/api/');
        const want = {
          public: isPublicPath(path),
          cors: isApi || OLD_SHARE_BROKER_RE.test(path),
          renderCookie:
            method === 'GET' && (OLD_RENDER_PAGE_RE.test(path) || OLD_RENDER_ASSET_RE.test(path)),
        };
        const have = { public: got.public, cors: got.cors, renderCookie: got.renderCookie };
        if (JSON.stringify(have) !== JSON.stringify(want)) {
          diffs.push(`${method} ${path}: ${JSON.stringify(have)} != ${JSON.stringify(want)}`);
        }
      }
    }
    expect(diffs).toEqual([]);
    // The rows answered most of it: the comparison is not of the path
    // checks against themselves.
    expect(routed).toBeGreaterThan(1000);
  });
});
