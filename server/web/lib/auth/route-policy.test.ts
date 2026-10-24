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
import { dirname, join, relative, sep } from 'node:path';
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
import { reExportedHandlers, specPattern } from '../../scripts/route-callers';
import { ACCESS_KEY_AREAS, type AccessKeyArea } from '../access-keys';
import { API_V1_ROUTES, keyMayCall, matchApiV1Route } from '../api-v1';
import { isPublicPath } from '../auth-constants';
import { TELEGRAM_LOGIN_ROUTES, isAnyLoginRoute } from './any-login-routes';
import { isMemberRoute } from './member-routes';
import {
  CREATE_ROUTES,
  isReadRequest,
  itemWriteTarget,
  memberMayRead,
  memberMayWrite,
  routeClass,
  NO_ITEM_WRITES,
} from './route-scope';
import {
  anyLoginRow,
  buildRoutePolicy,
  buildRouteRow,
  currentRoute,
  memberOpenRead,
  memberOpenWrite,
  registerRouteSource,
  requestKeyRoute,
  routeItemTarget,
  ADMIN_OPEN_ROWS,
  routeGatePolicy,
  routeRef,
  routeSwitchedOff,
  rowKeyRoute,
  ROUTE_POLICY_SOURCE,
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

type Manifest = Array<{ file: string; pattern: string; methods: string[] }>;

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

  it("S9 part 1: every route file declares, and its declarations build the lists' rows", () => {
    // Field for field, every row (route-policy-declarations.test.ts holds
    // the same rows to __snapshots__/route-policy.rows.json). The lists
    // stay the source until part 2's flip.
    expect(ROUTE_POLICY_SOURCE).toBe('lists');
    const undeclared = (manifest as Array<{ pattern: string; policy?: unknown }>)
      .filter((e) => e.policy === undefined)
      .map((e) => e.pattern);
    expect(undeclared).toEqual([]);
    const declared = buildRoutePolicy(manifest, { source: 'declarations' });
    const diffs: string[] = [];
    for (const [key, row] of table) {
      if (JSON.stringify(declared.get(key)) !== JSON.stringify(row)) diffs.push(key);
    }
    expect(diffs).toEqual([]);
    expect(declared.size).toBe(table.size);
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
      // The Telegram chat rows (and the HEADs their GET handler answers)
      // are the login's own chats, whatever their prefix (A4 step 3b), and
      // so is the update banner, the owner's carve-out (ADMIN_OPEN_ROWS).
      const asGet = `${m === 'HEAD' ? 'GET' : m} ${p}`;
      const scope =
        TELEGRAM_LOGIN_ROUTES.includes(asGet) || asGet === 'GET /api/updates/check'
          ? { kind: 'self' }
          : routeClass(p);
      check(key, 'scope', row.scope, scope);
      check(
        key,
        'area',
        row.area,
        scope?.kind === 'area' ? (scope as { area: string }).area : null,
      );
      check(key, 'effect', row.effect, isReadRequest(m, p) ? 'read' : 'write');
      // A v1 row answers a login outside Admin as its base route (D3, the
      // A8 finding F1), read from the hand-written V1_BASES below, never
      // from the code under test (fix round 1, finding 8).
      const asGetKey = `${m === 'HEAD' ? 'GET' : m} ${p}`;
      const v1Base = p.startsWith('/api/v1/') ? (V1_BASES[asGetKey] ?? null) : null;
      const [bm, bp] = v1Base
        ? [v1Base.slice(0, v1Base.indexOf(' ')), v1Base.slice(v1Base.indexOf(' ') + 1)]
        : [m, p];
      check(key, 'memberMayRead', memberOpenRead(row), memberMayRead(bm, bp));
      check(key, 'memberMayWrite', memberOpenWrite(row), memberMayWrite(bm, bp));
      // A HEAD row has its GET's logins (the owner's decision 2a): the
      // lists name GET only.
      const listed = m === 'HEAD' ? 'GET' : m;
      check(key, 'isAnyLoginRoute', anyLoginRow(row), isAnyLoginRoute(listed, p));
      check(key, 'isMemberRoute', row.logins === 'member', isMemberRoute(listed, p));
      check(key, 'open', row.open, row.logins ? 'login' : 'admin');
      // A v1 create reads ?ws= as its base does (A8 fix round 1, L3).
      check(key, 'creates', row.creates, CREATE_ROUTES.has(v1Base ?? `${m} ${p}`));
      for (const path of pathsOf(p)) {
        const target = itemWriteTarget(m, p, path);
        check(`${key} @${path}`, 'item', routeItemTarget(row, path), target);
        // What requestCreatePolicy answered before A4: no item made by a
        // delete or by a read write (the gate's ITEM_READ_WRITES until the
        // pre-check removal part 2, NO_ITEM_WRITES since; the same seven).
        check(
          `${key} @${path}`,
          'makesItems',
          row.makesItems,
          !(m === 'DELETE' || target?.need === 'read' || NO_ITEM_WRITES.has(`${m} ${p}`)),
        );
        check(`${key} @${path}`, 'public', row.public, isPublicPath(path));
      }
    }
    expect(diffs).toEqual([]);
  });

  it('a v1 row: its base, a member’s reach and ?ws= are the hand-written lists (A8 F1, L3)', () => {
    const v1 = [...table.values()].filter((r) => r.pattern.startsWith('/api/v1/'));
    const got: Record<string, string | null> = {};
    const memberReach: string[] = [];
    const creates: string[] = [];
    for (const row of v1) {
      if (row.method === 'HEAD') continue;
      const v1Row = API_V1_ROUTES.find((r) => r.method === row.method && r.pattern === row.pattern);
      got[row.key] = row.aliasOf ?? v1Row?.base ?? null;
      if (memberOpenRead(row) || memberOpenWrite(row)) memberReach.push(row.key);
      if (row.creates) creates.push(row.key);
    }
    expect(got).toEqual(V1_BASES);
    expect(memberReach.sort()).toEqual([...V1_MEMBER_REACH].sort());
    expect(creates.sort()).toEqual([...V1_CREATES].sort());
    // A HEAD row reaches a member where its GET does.
    for (const row of v1) {
      if (row.method !== 'HEAD') continue;
      const get = `GET ${row.pattern}`;
      expect(memberOpenRead(row), row.key).toBe(V1_MEMBER_REACH.includes(get));
      expect(row.creates, row.key).toBe(false);
    }
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
      // An alias is the route its file re-exports, resolved from the
      // `from` path to that route file's pattern (round 3 LOW-1), the same
      // method there (a HEAD the GET handler answers: its GET's, under the
      // row's own method); a row with none has a handler of its own (or no
      // base route). The generator holds a declared aliasOf to the same.
      const rel = relative(webRoot, file).split(sep).join('/');
      const from = reExportedHandlers(src, rel)[m];
      // The one resolver of a `from` spec (route-callers.ts specPattern),
      // the generator's and the codemod's; the manifest serves what it names.
      const basePattern = from
        ? (specPattern(rel, from.spec, (f) => existsSync(join(webRoot, f))) ?? undefined)
        : undefined;
      if (basePattern !== undefined) {
        expect(
          manifest.some((e) => e.pattern === basePattern),
          basePattern,
        ).toBe(true);
      }
      expect(from === undefined || from.name === m, row.key).toBe(true);
      expect(basePattern !== undefined ? `${row.method} ${basePattern}` : null, row.key).toBe(
        row.aliasOf,
      );
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

  it("A4 step 3b: the Telegram chat rows are the login's own, in no Admin area", () => {
    const keys = TELEGRAM_LOGIN_ROUTES.flatMap((k) =>
      k.startsWith('GET ') ? [k, k.replace(/^GET /, 'HEAD ')] : [k],
    );
    expect(keys).toHaveLength(8);
    for (const key of keys) {
      const row = table.get(key)!;
      expect(row.class, key).toBe('self');
      expect(row.scope, key).toEqual({ kind: 'self' });
      expect(row.area, key).toBeNull();
      expect(routeGatePolicy(row).scope, key).toBe('any');
      // Their prefix still names the connectors area: the owner routes
      // under it (PATCH /api/telegram/chats/:id) stay area rows.
      expect(routeClass(row.pattern), key).toEqual({ kind: 'area', area: 'connectors' });
    }
    expect(table.get('PATCH /api/telegram/chats/:id')!.area).toBe('connectors');
  });

  it('A4 step 3b: the owner decision of 2026-10-14 on the update routes', () => {
    // The cached update banner is open to every Admin user, a named
    // carve-out: the login's own, in no area.
    expect([...ADMIN_OPEN_ROWS]).toEqual(['GET /api/updates/check']);
    for (const key of ['GET /api/updates/check', 'HEAD /api/updates/check']) {
      const row = table.get(key)!;
      expect(row.class, key).toBe('self');
      expect(row.area, key).toBeNull();
      // The gate answers the session user (any Admin user, or null: A4
      // hand batch A); the handler answers a null as before.
      expect(row.caller, key).toBe('session');
    }
    // Only a carve-out's row may read the session user.
    expect(() =>
      buildRouteRow('GET', '/api/updates/status', () => false, { reads: 'session' }),
    ).toThrow(/does not serve its row/);
    // The status poll and the forced check need the settings area, and the
    // gate answers it (their handlers read the caller).
    for (const key of [
      'GET /api/updates/status',
      'HEAD /api/updates/status',
      'POST /api/updates/check',
    ]) {
      const row = table.get(key)!;
      expect(row.class, key).toBe('area');
      expect(row.area, key).toBe('settings');
      expect(row.caller, key).toBe('owner');
    }
  });

  it('A4 step 3b: a connector OAuth callback is a write, run as the login its guard names', () => {
    for (const pattern of ['/api/mcp-connectors/oauth/callback', '/api/microsoft/oauth/callback']) {
      for (const method of ['GET', 'HEAD']) {
        const row = table.get(`${method} ${pattern}`)!;
        expect(row.effect, row.key).toBe('write');
        expect(row.public, row.key).toBe(false);
        expect(row.actor, row.key).toBeNull();
        expect(row.area, row.key).toBe('connectors');
        expect(routeGatePolicy(row).effect, row.key).toBe('write');
      }
    }
  });

  it('A4 step 3a: a public row that writes names the actor it runs as today; no other row does', () => {
    const named: string[] = [];
    for (const row of table.values()) {
      if (row.public && row.effect === 'write') {
        // The request slot's first actor, until a guard or a share gate
        // names a caller: what each ran as before it had a name.
        expect(row.actor, row.key).toBe('http:no-login');
        expect(row.actor, row.key).toBe(row.startsAs);
        expect(routeGatePolicy(row).actor, row.key).toEqual(systemActor('http:no-login'));
        named.push(row.key);
      } else {
        expect(row.actor, row.key).toBeNull();
        expect(routeGatePolicy(row).actor, row.key).toBeUndefined();
      }
    }
    // Signup, invite accept, sign in, the token routes, OAuth, the /s
    // brokers among them.
    for (const key of [
      'POST /api/auth/signup',
      'POST /api/auth/invite/accept',
      'POST /api/auth/login',
      'POST /api/oauth/token',
      'POST /s/:token/db-broker',
    ]) {
      expect(named, key).toContain(key);
    }
    // Not public: the connector OAuth callbacks and the onboarding seed run
    // as the login their guard names.
    for (const key of ['GET /api/mcp-connectors/oauth/callback', 'POST /api/onboarding']) {
      expect(table.get(key)?.actor, key).toBeNull();
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
  // does not run and gateAccessKey and findKeyLogin judge the areas (keyOnRow).
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

  it('a gone row (A4 hand batch A): none is left since A7; a stub row still names its kind', () => {
    // The 410 stubs went in arch A7 (server/web/server/a7-gone-routes.test.ts):
    // no row of the manifest is a gone row. lib/gone.ts stays for a route
    // retired later, and a gone row must still name its kind.
    expect([...table.values()].filter((r) => r.gone)).toEqual([]);
    expect(() => buildRouteRow('GET', '/api/shell', () => false, { gone: true })).toThrow(
      /gone stub with no caller kind/,
    );
    expect(table.get('GET /api/shell')?.gone).toBe(false);
  });

  it('a row that is not public and reads no caller is refused at boot (A4 hand batch B fix round 1, M1)', () => {
    // A synthetic row: an owner row whose handler reads nothing.
    expect(() => buildRouteRow('POST', '/api/notes')).toThrow(
      /POST \/api\/notes reads no caller: a row that is not public reads the caller/,
    );
    // A new method of a route file that reads on another method: its own
    // row reads nothing, and is refused whatever the file reads.
    expect(() =>
      buildRoutePolicy([
        { pattern: '/api/notes', methods: ['GET', 'POST'], reads: { GET: 'owner' } },
      ]),
    ).toThrow(/POST \/api\/notes reads no caller/);
    // Each login list's rows alike.
    for (const [method, pattern] of [
      ['GET', '/api/shell'],
      ['GET', '/api/member/mcp'],
      ['GET', '/api/assistant/thread'],
      ['GET', '/api/updates/check'],
    ] as const) {
      expect(() => buildRouteRow(method, pattern), `${method} ${pattern}`).toThrow(
        /reads no caller/,
      );
    }
    // A public row judges its own credential, and so does a page.
    expect(buildRouteRow('GET', '/api/version').caller).toBeNull();
    expect(buildRouteRow('POST', '/api/auth/login').caller).toBeNull();
    expect(buildRouteRow('GET', '/s/:token', () => false, { page: 'link' }).caller).toBeNull();
    expect(
      buildRouteRow('GET', '/print/pages/:id', () => false, { page: 'render' }).caller,
    ).toBeNull();
    // A test's stand-in rows, whose handlers call the guards themselves.
    expect(buildRouteRow('POST', '/api/notes', () => false, { standIn: true }).caller).toBeNull();
    // The app's table: no such row.
    expect([...table.values()].filter((r) => !r.caller && !r.public && !r.page)).toEqual([]);
  });

  it('a switched route (A4 hand batch A fix round 1): the switch its route file declares, on its rows', () => {
    // Found by the route FILE, not by a pattern kept here: a route moved to
    // another URL keeps its file's declaration, and this test still finds
    // its rows. The dev tool must never be served in production.
    const text = readFileSync(join(webRoot, 'server/route-manifest.gen.ts'), 'utf8');
    const patternOf = (file: string) => {
      const m = new RegExp(
        `pattern: "([^"]+)"[^\\n]*import\\("\\.\\./${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)`,
      ).exec(text);
      expect(m, file).not.toBeNull();
      return m![1]!;
    };
    const queue = patternOf('app/api/dev-tools/queue-approval/route');
    const row = table.get(`POST ${queue}`);
    expect(row, queue).toBeDefined();
    expect(row!.switch).toBe('not-production');
    // The streamed turn's stream (and its HEAD) and its cancel.
    const stream = patternOf('app/api/assistant/turn/[turnId]/stream/route');
    const cancel = patternOf('app/api/assistant/turn/[turnId]/cancel/route');
    expect(table.get(`GET ${stream}`)?.switch).toBe('turn-streaming');
    expect(table.get(`HEAD ${stream}`)?.switch).toBe('turn-streaming');
    expect(table.get(`POST ${cancel}`)?.switch).toBe('turn-streaming');
    // No other row is switched.
    const switched = [...table.values()].filter((r) => r.switch !== null).map((r) => r.key);
    expect(switched.sort()).toEqual(
      [`GET ${stream}`, `HEAD ${stream}`, `POST ${cancel}`, `POST ${queue}`].sort(),
    );
    // Off: the gate's answer, the handler's words.
    const before = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string>).NODE_ENV = 'production';
      expect(routeSwitchedOff(row!)).toEqual({
        status: 404,
        body: { error: 'not available in production' },
      });
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = before;
    }
    expect(routeSwitchedOff(row!)).toBeNull();
  });

  it('a switch is refused at boot where it guards no served row, or names no switch', () => {
    const entry = { pattern: '/api/dev-tools/queue-approval', methods: ['POST'] };
    expect(
      buildRoutePolicy([{ ...entry, switches: { POST: 'not-production' } }], { standIn: true })
        .size,
    ).toBe(1);
    // A method the route does not export (a HEAD the GET answers included).
    expect(() =>
      buildRoutePolicy([{ ...entry, switches: { GET: 'not-production' } }], { standIn: true }),
    ).toThrow(/declares a switch for GET, which it does not serve/);
    const stream = { pattern: '/api/assistant/turn/:turnId/stream', methods: ['GET'] };
    expect(() =>
      buildRoutePolicy([{ ...stream, switches: { HEAD: 'turn-streaming' } }], { standIn: true }),
    ).toThrow(/declares a switch for HEAD, which it does not serve/);
    expect(() =>
      buildRoutePolicy(
        [{ ...entry, switches: { POST: 'nightly' as unknown as 'not-production' } }],
        { standIn: true },
      ),
    ).toThrow(/served under nightly, which is no switch/);
  });

  it("M3, the owner's decision 2a (2026-10-14): a HEAD row has its GET's logins", () => {
    // HEAD is answered by the GET handler: it has the GET's class and the
    // GET's logins, so a login outside Admin that may GET a row of the
    // any-login, chat, Telegram or member lists may HEAD it under the same
    // rule (before, such a HEAD row had logins null and was open to Admin
    // only: the any-login guard ran it on the system pool, login-self).
    const byGet = new Map<string, number>();
    for (const row of table.values()) {
      if (row.method !== 'HEAD') continue;
      const get = table.get(`GET ${row.pattern}`)!;
      expect(row.class, row.key).toBe(get.class);
      expect(row.logins, row.key).toBe(get.logins);
      expect(row.open, row.key).toBe(get.open);
      expect(anyLoginRow(row), row.key).toBe(anyLoginRow(get));
      if (get.logins) byGet.set(get.logins, (byGet.get(get.logins) ?? 0) + 1);
    }
    for (const logins of ['owner', 'any', 'chat', 'telegram', 'member']) {
      expect(byGet.get(logins), logins).toBeGreaterThan(0);
    }
    // The audit's case: an any-login GET of class 'self' and its HEAD.
    const head = table.get('HEAD /api/access-keys')!;
    expect(head).toMatchObject({ class: 'self', logins: 'any', open: 'login' });
  });

  it("a HEAD row takes its GET's logins and switch only where the GET handler answers it (fix round 1, L3)", () => {
    // No route of the app exports its own HEAD today: every HEAD row is
    // its GET's.
    for (const e of manifest) {
      expect(e.methods, e.pattern).not.toContain('HEAD');
    }
    const threads = '/api/assistant/threads';
    const stream = '/api/assistant/turn/:turnId/stream';
    const byGet = buildRoutePolicy(
      [
        { pattern: threads, methods: ['GET'], reads: { GET: 'chat' } },
        { pattern: stream, methods: ['GET'], switches: { GET: 'turn-streaming' } },
      ],
      { standIn: true },
    );
    expect(byGet.get(`HEAD ${threads}`)).toMatchObject({
      logins: 'chat',
      open: 'login',
      caller: 'chat',
    });
    expect(byGet.get(`HEAD ${stream}`)?.switch).toBe('turn-streaming');
    // A route that exports its own HEAD: the HEAD row is that handler's,
    // as the lists name it (none name a HEAD), with no switch, no read and
    // no logins of its GET's.
    const own = buildRoutePolicy(
      [
        { pattern: threads, methods: ['GET', 'HEAD'], reads: { GET: 'chat' } },
        { pattern: stream, methods: ['GET', 'HEAD'], switches: { GET: 'turn-streaming' } },
      ],
      { standIn: true },
    );
    expect(own.get(`GET ${threads}`)).toMatchObject({ logins: 'chat', open: 'login' });
    expect(own.get(`HEAD ${threads}`)).toMatchObject({
      logins: null,
      open: 'admin',
      caller: null,
    });
    expect(own.get(`GET ${stream}`)?.switch).toBe('turn-streaming');
    expect(own.get(`HEAD ${stream}`)?.switch).toBeNull();
    // Its own HEAD declares its own switch.
    const switched = buildRoutePolicy(
      [
        {
          pattern: stream,
          methods: ['GET', 'HEAD'],
          switches: { GET: 'turn-streaming', HEAD: 'turn-streaming' },
        },
      ],
      { standIn: true },
    );
    expect(switched.get(`HEAD ${stream}`)?.switch).toBe('turn-streaming');
    // An own HEAD on a row only a login list classes has no class of its
    // own: refused at boot, until a list names it.
    expect(() =>
      buildRoutePolicy([{ pattern: '/api/access-keys', methods: ['GET', 'HEAD'] }], {
        standIn: true,
      }),
    ).toThrow(/HEAD \/api\/access-keys has no class/);
    expect(
      buildRoutePolicy([{ pattern: '/api/access-keys', methods: ['GET'] }], { standIn: true }).get(
        'HEAD /api/access-keys',
      ),
    ).toMatchObject({ logins: 'any', open: 'login' });
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

/**
 * Every v1 row's base route (D3, the A8 finding F1), written by hand from
 * the route files and docs/actors.md, so the check above compares the code
 * with an independent answer (fix round 1, finding 8): the route the file
 * re-exports, else the key table's `base`; null for a row with neither
 * (whoami answers the key itself; the table row writes stay Admin only).
 */
const V1_BASES: Readonly<Record<string, string | null>> = {
  'GET /api/v1/whoami': null,
  'GET /api/v1/search': 'GET /api/search',
  'GET /api/v1/nodes/:id': 'GET /api/nodes/:id',
  'GET /api/v1/pages': 'GET /api/pages',
  'POST /api/v1/pages': 'POST /api/pages',
  'GET /api/v1/pages/:id': 'GET /api/pages/:id',
  'PATCH /api/v1/pages/:id': 'PATCH /api/pages/:id',
  'GET /api/v1/notes': 'GET /api/notes',
  'POST /api/v1/notes': 'POST /api/notes',
  'GET /api/v1/notes/:id': 'GET /api/notes/:id',
  'GET /api/v1/tasks': 'GET /api/tasks',
  'POST /api/v1/tasks': 'POST /api/tasks',
  'GET /api/v1/tasks/:id': 'GET /api/tasks/:id',
  'PATCH /api/v1/tasks/:id': 'PATCH /api/tasks/:id',
  'GET /api/v1/tables': 'GET /api/tables',
  'GET /api/v1/tables/:id': 'GET /api/tables/:id',
  'GET /api/v1/tables/:id/rows': 'GET /api/tables/:id/rows',
  'POST /api/v1/tables/:id/rows': null,
  'PATCH /api/v1/tables/:id/rows/:rowId': null,
  'POST /api/v1/tables/:id/commit': 'POST /api/tables/:id/commit',
  'GET /api/v1/files': 'GET /api/files/files',
  'POST /api/v1/files': 'POST /api/files/files',
  'GET /api/v1/files/:id': 'GET /api/files/files/:id',
  'GET /api/v1/files/:id/download': 'GET /api/files/files/:id',
  'GET /api/v1/events': 'GET /api/events',
  'POST /api/v1/events': 'POST /api/events',
  'GET /api/v1/contacts': 'GET /api/contacts',
  'GET /api/v1/contacts/:id': 'GET /api/contacts/:id',
  'GET /api/v1/journal': 'GET /api/journal',
  'POST /api/v1/journal': 'POST /api/journal',
};

/** The v1 rows a login outside Admin reaches (docs/actors.md, F1's changed
 *  cells): every other v1 row answers it 403 member-login. */
const V1_MEMBER_REACH: readonly string[] = [
  'GET /api/v1/search',
  'GET /api/v1/nodes/:id',
  'GET /api/v1/pages',
  'POST /api/v1/pages',
  'GET /api/v1/pages/:id',
  'PATCH /api/v1/pages/:id',
  'GET /api/v1/notes',
  'POST /api/v1/notes',
  'GET /api/v1/notes/:id',
  'GET /api/v1/tasks',
  'POST /api/v1/tasks',
  'GET /api/v1/tasks/:id',
  'PATCH /api/v1/tasks/:id',
  'GET /api/v1/tables',
  'GET /api/v1/tables/:id',
  'GET /api/v1/tables/:id/rows',
  'POST /api/v1/tables/:id/commit',
  'GET /api/v1/files',
  'POST /api/v1/files',
  'GET /api/v1/files/:id',
  'GET /api/v1/files/:id/download',
  'GET /api/v1/events',
  'POST /api/v1/events',
];

/** The v1 creates that read ?ws= as their base does (A8 fix round 1, L3). */
const V1_CREATES: readonly string[] = [
  'POST /api/v1/pages',
  'POST /api/v1/notes',
  'POST /api/v1/tasks',
  'POST /api/v1/files',
  'POST /api/v1/events',
];
