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
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
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
import { PUBLIC_PATHS } from '../auth-constants';
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
  routeItemTarget,
  routeRef,
  rowKeyRoute,
  servedMethods,
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

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
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
    const vias: CallerVia[] = ['cookie', 'bearer', 'token', 'public', 'key'];
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
    const { registerRoutes } = await import('../../server/route-loader');
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

  it('a request no route answers runs as before: no row, no slot', async () => {
    const res = await app.request('/api/version/nope');
    expect(await res.json()).toEqual({ route: null, slot: false });
  });
});
