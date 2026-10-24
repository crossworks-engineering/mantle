/**
 * Plan v3.2 S9: the route lists folded into a declaration in each route
 * file (route-declaration.ts). Part 1 wrote every route file's declaration,
 * part 2 read the rows from them, part 3 deleted the lists: the
 * declarations are the rows' one source.
 *
 * Pinned here, on every run:
 *  - every row, every field, against the snapshot
 *    (__snapshots__/route-policy.rows.json), byte for byte the rows the
 *    lists built before they went;
 *  - the manifest carries a declaration for every route file, and every
 *    route module exports the one its entry carries;
 *  - a row's `public` is the gate's answer for its path (PUBLIC_PATHS, the
 *    kept list for a request no row answers), so the two cannot drift;
 *  - a declaration that cannot hold is refused at boot.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkLoadedPolicy, type RouteModule } from '../../server/route-loader';
import { isPublicPath, PUBLIC_PATHS } from '../auth-constants';
import {
  ALIAS_COPIES,
  ALIAS_OWN,
  DECLARED_KEYS,
  type RoutePolicyDeclaration,
} from './route-declaration';
import {
  buildRoutePolicy,
  findsNoLogin,
  requireRouteDeclarations,
  type RouteCaller,
  type RouteManifestEntry,
  type RouteRow,
} from './route-policy';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hasManifest = existsSync(join(webRoot, 'server/route-manifest.gen.ts'));

/** The fields a row has by default: the snapshot leaves them out, so a
 *  line says what is particular to its row. A field not named here is
 *  always written, so a new field is pinned from its first row. */
const DEFAULTS: Readonly<Record<string, unknown>> = {
  area: null,
  public: false,
  open: 'admin',
  logins: null,
  creates: false,
  makesItems: true,
  item: null,
  audit: null,
  aliasOf: null,
  cors: false,
  renderCookie: false,
  page: false,
  caller: null,
  gone: false,
  switch: null,
  crossSite: null,
  rateLimit: [],
  startsAs: 'http:no-login',
  actor: null,
};

/** A row for the snapshot: its key, then each field that is not its
 *  default (key, method and pattern are the key). */
function snapshotLine(row: RouteRow): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'key' || k === 'method' || k === 'pattern') continue;
    if (Object.hasOwn(DEFAULTS, k) && JSON.stringify(DEFAULTS[k]) === JSON.stringify(v)) continue;
    out[k] = v;
  }
  return `${JSON.stringify(row.key)}: ${JSON.stringify(out)}`;
}

describe.skipIf(!hasManifest)('S9: route declarations', () => {
  let manifest: readonly RouteManifestEntry[];
  let rows: ReadonlyMap<string, RouteRow>;

  beforeAll(async () => {
    manifest = (await import('../../server/route-manifest.gen')).routeManifest;
    rows = buildRoutePolicy(manifest);
  });

  it('every route file declares, one policy for each method it exports', () => {
    expect(manifest.filter((e) => e.policy === undefined).map((e) => e.pattern)).toEqual([]);
    // The numbers of the handover (part 1, main v0.300.139): 418 route
    // files, 819 rows, 572 methods declared. They move with the routes;
    // the floor only says the walk saw them.
    const methods = manifest.reduce((n, e) => n + Object.keys(e.policy ?? {}).length, 0);
    expect(manifest.length).toBeGreaterThan(400);
    expect(methods).toBeGreaterThan(550);
    expect(rows.size).toBeGreaterThan(methods);
  });

  it('a frame document finds no login, and only it (INFO)', () => {
    const noLogin = [...rows.values()].filter((r) => findsNoLogin(r)).map((r) => r.key);
    expect(noLogin.sort()).toEqual([
      'GET /api/apps/:id/frame',
      'GET /api/presents/:id/frame',
      'HEAD /api/apps/:id/frame',
      'HEAD /api/presents/:id/frame',
    ]);
  });

  it("a row's public is the gate's answer for its path (PUBLIC_PATHS)", () => {
    // The gate answers a request no row answers by the path (isPublicPath,
    // gate.ts gateRouteView); a routed one by its row. The same answer for
    // every path a pattern spells, so neither can drift from the other.
    const marked = (pattern: string) =>
      pattern.replace(/:[A-Za-z0-9_]+/g, (_m) => 'p').replace(/\*$/, 'rest');
    const differ = [...rows.values()]
      .filter((r) => r.public !== isPublicPath(marked(r.pattern)))
      .map((r) => r.key);
    expect(differ).toEqual([]);
  });

  it('PUBLIC_PATHS: the paths no manifest pattern is under', () => {
    // The rows' `public` is declared; the list answers a request no row
    // answers (gate.ts gateRouteView), the two entries below only so: the
    // sign-in page and the app runtime's assets. Pinned, so a route under
    // one of them is seen first.
    const under = (path: string, p: string) => path === p || path.startsWith(`${p}/`);
    const routed = (p: string) =>
      manifest.some((e) => {
        const marked = e.pattern.replace(/:[A-Za-z0-9_]+/g, '{p}');
        // A param could spell any segment of the prefix: compare by segment.
        const segs = marked.split('/');
        const want = p.split('/');
        return (
          under(marked, p) ||
          (segs.length >= want.length &&
            want.every((w, i) => segs[i] === w || segs[i] === '{p}' || segs[i] === '*'))
        );
      });
    expect(PUBLIC_PATHS.filter((p) => !routed(p))).toEqual(['/login', '/app-runtime']);
  });

  it("a row open to a member's item (logins 'owner') is a served content row (S9 part 3 MED-1)", () => {
    // The guarantee the deleted list cells gave (every member read and
    // write a served content route), now the validator's: open: 'owner'
    // only on a content row. Each such row is of the class content, and
    // the manifest serves its method (a HEAD through its GET).
    const served = (r: RouteRow) =>
      manifest.some(
        (e) =>
          e.pattern === r.pattern &&
          (e.methods.includes(r.method) || (r.method === 'HEAD' && e.methods.includes('GET'))),
      );
    const owner = [...rows.values()].filter((r) => r.logins === 'owner');
    expect(owner.filter((r) => r.class !== 'content' || !served(r)).map((r) => r.key)).toEqual([]);
    // 185 on main v0.300.148: the floor only says the walk saw them.
    expect(owner.length).toBeGreaterThan(150);
  });

  it("the app's manifest passes the boot's declaration check (requireRouteDeclarations)", () => {
    expect(() => requireRouteDeclarations(manifest)).not.toThrow();
  });

  it('every route module loads and exports the policy its manifest entry carries (L1)', async () => {
    const refused: string[] = [];
    for (const e of manifest as ReadonlyArray<
      RouteManifestEntry & { load: () => Promise<RouteModule> }
    >) {
      try {
        checkLoadedPolicy(e, await e.load());
      } catch (err) {
        refused.push(`${e.pattern}: ${String(err)}`);
      }
    }
    expect(refused).toEqual([]);
  }, 120_000);

  it("the rows the route files' declarations build, every field, as the snapshot says", async () => {
    const lines = [...rows.values()].map(snapshotLine).sort();
    await expect(`{\n${lines.join(',\n')}\n}\n`).toMatchFileSnapshot(
      './__snapshots__/route-policy.rows.json',
    );
  });
});

describe('S9: a declaration that cannot hold is refused at boot', () => {
  const entry = (
    pattern: string,
    methods: string[],
    policy: RoutePolicyDeclaration,
    reads: Readonly<Record<string, RouteCaller>> = Object.fromEntries(
      methods.map((m) => [m, 'owner' as const]),
    ),
  ) => ({ pattern, methods, reads, policy });
  const build = (...entries: RouteManifestEntry[]) => buildRoutePolicy(entries);
  const none = { none: 'a test row' } as const;

  it('builds the rows a declaration says; the effect is the method’s; a HEAD takes its GET’s', () => {
    const rows = build(
      entry('/api/notes', ['GET', 'POST'], {
        GET: { class: 'content', open: 'owner' },
        POST: { class: 'content', open: 'owner', creates: true, item: none },
      }),
    );
    expect(rows.get('GET /api/notes')).toMatchObject({ class: 'content', logins: 'owner' });
    expect(rows.get('HEAD /api/notes')).toMatchObject({ effect: 'read', creates: false });
    expect(rows.get('POST /api/notes')).toMatchObject({
      effect: 'write',
      creates: true,
      makesItems: true,
      item: null,
    });
  });

  it('an effect exception, stated with its reason, is the row’s effect (and its HEAD’s)', () => {
    const rows = build(
      entry('/api/calc', ['POST'], {
        POST: { class: 'content', effect: { read: 'evaluates only' } },
      }),
      entry('/api/cb', ['GET'], {
        GET: { class: 'content', effect: { write: 'stores tokens' }, item: none },
      }),
    );
    expect(rows.get('POST /api/calc')?.effect).toBe('read');
    expect(rows.get('GET /api/cb')?.effect).toBe('write');
    expect(rows.get('HEAD /api/cb')?.effect).toBe('write');
  });

  it("the app's boot refuses a route file that declares no policy, whatever the source (part 1)", () => {
    const declared = entry('/api/notes', ['GET', 'POST'], {
      GET: { class: 'content', open: 'owner' },
      POST: { class: 'content', open: 'owner', item: none },
    });
    expect(() => requireRouteDeclarations([declared])).not.toThrow();
    expect(() =>
      requireRouteDeclarations([
        declared,
        { pattern: '/api/new', methods: ['GET', 'DELETE'], reads: { GET: 'owner' } },
      ]),
    ).toThrow(/declares no policy for GET \/api\/new, DELETE \/api\/new/);
    expect(() =>
      requireRouteDeclarations([
        entry('/api/notes', ['GET', 'POST'], { GET: { class: 'content', open: 'owner' } }),
      ]),
    ).toThrow(/declares no policy for POST \/api\/notes/);
    // A declaration that does not hold (a write with no item) is refused
    // there too.
    const noItem = { POST: { class: 'content', open: 'owner' } } as RoutePolicyDeclaration;
    expect(() => requireRouteDeclarations([entry('/api/notes', ['POST'], noItem)])).toThrow(/item/);
  });

  it('refuses a route file that declares no policy, or one for a method it does not serve', () => {
    expect(() =>
      build({ pattern: '/api/notes', methods: ['GET'], reads: { GET: 'owner' } }),
    ).toThrow(/declares no policy for GET/);
    const stray = { GET: { class: 'content' }, POST: { class: 'content', item: none } } as const;
    expect(() => build(entry('/api/notes', ['GET'], stray))).toThrow(
      /policy for POST, which it does not serve/,
    );
  });

  it('refuses each value that cannot hold (validateMethodPolicy, at boot)', () => {
    const bad = (pattern: string, d: Record<string, unknown>, why: RegExp, method = 'POST') =>
      expect(() =>
        build(entry(pattern, [method], { [method]: d } as RoutePolicyDeclaration)),
      ).toThrow(why);
    const w = { item: none };
    bad('/api/notes', { class: 'link', ...w }, /link row is an \/s route/);
    bad('/api/notes', { class: 'nope', ...w }, /class nope/);
    bad('/api/notes', { class: 'area', ...w }, /area on a row/);
    bad('/api/notes', { class: 'area', area: 'bogus', ...w }, /area bogus/);
    bad('/api/notes', { class: 'content', public: true, ...w }, /public: only/);
    bad('/api/notes', { class: 'content', scope: null, ...w }, /scope: only/);
    bad('/api/x', { class: 'self', scope: null, ...w }, /no list opens/);
    bad('/api/notes', { class: 'content', open: 'all', ...w }, /open all/);
    // MED-1: open: 'owner' only on a content row, whatever else it says.
    bad(
      '/api/users',
      { class: 'area', area: 'settings', open: 'owner' },
      /open owner on the class area/,
      'GET',
    );
    bad('/api/x', { class: 'self', open: 'owner' }, /open owner on the class self/, 'GET');
    bad('/api/x', { class: 'self', open: 'owner', ...w }, /open owner on the class self/);
    bad('/api/x', { class: 'public', open: 'owner' }, /open owner on the class public/, 'GET');
    bad('/api/notes', { class: 'content', wat: 1, ...w }, /the key wat/);
    // M2: the effect is the method's; only an exception, with its reason.
    bad('/api/notes', { class: 'content', effect: 'write', ...w }, /effect that is not/);
    bad(
      '/api/notes',
      { class: 'content', effect: { write: 'x' }, ...w },
      /state only an exception/,
    );
    bad('/api/notes', { class: 'content', effect: { read: '' } }, /with no reason/);
    bad(
      '/api/notes',
      { class: 'content', effect: { read: 'x', write: 'y' } },
      /effect that is not/,
    );
    bad('/api/notes', { class: 'content', effect: { write: 'x' } }, /no item: a write/, 'GET');
    bad(
      '/api/notes',
      { class: 'content', effect: { read: 'x' } },
      /effect that is not|state only/,
      'GET',
    );
    // S11b: every write says its item; a read says none.
    bad('/api/notes', { class: 'content' }, /no item: a write/);
    bad('/api/notes', { class: 'content', item: none }, /an item on a read/, 'GET');
    bad('/api/notes', { class: 'content', effect: { read: 'x' }, item: none }, /an item on a read/);
    bad('/api/notes', { class: 'content', creates: true }, /creates/, 'GET');
    bad('/api/notes', { class: 'content', makesItems: false }, /makesItems/, 'GET');
    // M1: the item and the limits are exact, and objects.
    bad(
      '/api/notes/:id',
      { class: 'content', item: { param: 'nodeId', need: 'edit' } },
      /no param/,
    );
    bad('/api/notes/:id', { class: 'content', item: { param: 'id', need: 'edit', x: 1 } }, /key x/);
    bad('/api/notes/:id', { class: 'content', item: { none: 'x', param: 'id' } }, /key param/);
    bad('/api/notes/:id', { class: 'content', item: { none: '' } }, /none with no reason/);
    bad('/api/notes/:id', { class: 'content', item: null }, /item that is no object/);
    bad('/api/notes/:id', { class: 'content', item: ['id'] }, /item that is no object/);
    bad('/api/notes', { class: 'content', limits: null, ...w }, /limits that is no object/);
    bad('/api/notes', { class: 'content', limits: { rateLimits: [] }, ...w }, /key rateLimits/);
    bad('/api/notes', { class: 'content', limits: { crossSite: 'any' }, ...w }, /cross-site/);
    bad(
      '/api/notes',
      { class: 'content', limits: { rateLimit: 'authLogin' }, ...w },
      /list of names/,
    );
    bad(
      '/api/notes',
      { class: 'content', limits: { rateLimit: ['bogus'] }, ...w },
      /takes bogus, no limit/,
    );
    // L2: no prototype key, wherever it is.
    bad(
      '/api/notes',
      JSON.parse('{"class":"content","item":{"none":"x"},"__proto__":{"open":"any"}}'),
      /key __proto__/,
    );
    bad('/api/notes', { class: 'content', ...w, keyArea: 'notes' }, /off \/api\/v1/);
    bad('/api/v1/notes', { class: 'content', ...w, keyArea: 'bogus' }, /key area bogus/);
    bad('/api/notes', { class: 'content', audit: 'own' }, /audit/, 'GET');
    bad('/api/notes', { class: 'content', ...w, audit: 'theirs' }, /audit/);
    bad('/api/notes', { class: 'content', caller: 'owner' }, /no named kind/, 'GET');
    bad('/api/notes', { class: 'content', caller: 'publicLogin' }, /public kind/, 'GET');
    bad('/api/notes', { class: 'public', caller: 'session' }, /public kind/, 'GET');
  });

  it('M3: an alias and a v1 row with a base take open, creates (and limits) from the base', () => {
    const base = entry('/api/notes', ['GET', 'POST'], {
      GET: { class: 'content', open: 'owner' },
      POST: {
        class: 'content',
        open: 'owner',
        creates: true,
        item: none,
        limits: { rateLimit: ['memberBytes'] },
      },
    });
    const rows = build(
      base,
      entry('/api/v1/notes', ['GET', 'POST'], {
        GET: { class: 'content', keyArea: 'notes', aliasOf: 'GET /api/notes' },
        POST: { class: 'content', item: none, keyArea: 'notes', aliasOf: 'POST /api/notes' },
      }),
      // A v1 file with a handler of its own declares its base.
      entry('/api/pages/:id', ['PATCH'], {
        PATCH: {
          class: 'content',
          open: 'owner',
          creates: true,
          item: none,
          limits: { rateLimit: ['memberBytes'] },
        },
      }),
      entry('/api/v1/pages/:id', ['PATCH'], {
        PATCH: { class: 'content', item: none, keyArea: 'pages', base: 'PATCH /api/pages/:id' },
      }),
    );
    expect(rows.get('POST /api/v1/notes')).toMatchObject({
      logins: 'owner',
      creates: true,
      aliasOf: 'POST /api/notes',
      rateLimit: ['memberBytes'],
    });
    expect(rows.get('HEAD /api/v1/notes')).toMatchObject({
      logins: 'owner',
      aliasOf: 'HEAD /api/notes',
    });
    // A base: open and creates; its limits are its own handler's.
    expect(rows.get('PATCH /api/v1/pages/:id')).toMatchObject({
      logins: 'owner',
      creates: true,
      aliasOf: null,
      rateLimit: [],
    });
    const v1 = (d: Record<string, unknown>) =>
      build(base, entry('/api/v1/notes', ['POST'], { POST: d } as RoutePolicyDeclaration));
    const alias = { class: 'content', item: none, aliasOf: 'POST /api/notes' };
    expect(() => v1({ ...alias, open: 'owner' })).toThrow(/open beside aliasOf/);
    expect(() => v1({ ...alias, creates: true })).toThrow(/creates beside aliasOf/);
    expect(() => v1({ ...alias, limits: {} })).toThrow(/limits beside aliasOf/);
    expect(() =>
      v1({ class: 'content', item: none, base: 'POST /api/notes', open: 'owner' }),
    ).toThrow(/open beside base/);
    expect(() => v1({ ...alias, aliasOf: 'GET /api/notes' })).toThrow(/same method/);
    expect(() => v1({ ...alias, aliasOf: 'POST /api/v1/x' })).toThrow(
      /same method of a route off it/,
    );
    expect(() => v1({ ...alias, base: 'POST /api/notes' })).toThrow(/beside aliasOf|both aliasOf/);
    expect(() =>
      build(entry('/api/v1/notes', ['POST'], { POST: alias } as RoutePolicyDeclaration)),
    ).toThrow(/does not serve/);
    // Since the key table went (S9 part 3) a declared base is the one
    // source: served and declared, it is the row's base.
    expect(
      v1({ class: 'content', item: none, base: 'POST /api/notes' }).get('POST /api/v1/notes'),
    ).toMatchObject({ logins: 'owner', creates: true, aliasOf: null });
    // A base that opens to members opens a content row only: a self, area or
    // public v1 row that takes `open: 'owner'` from its base is refused.
    for (const d of [
      { class: 'self', item: none, base: 'POST /api/notes' },
      { class: 'area', area: 'settings', item: none, base: 'POST /api/notes' },
      { class: 'public', item: none, base: 'POST /api/notes' },
    ]) {
      expect(() => v1(d)).toThrow(/open to members through its base/);
    }
  });

  it("an alias is its base's row in class, area, effect and item", () => {
    // Each field the handler decides, one at a time: refused.
    const keyed = (d: Record<string, unknown>) =>
      build(
        entry('/api/notes', ['POST'], { POST: { class: 'content', open: 'owner', item: none } }),
        entry('/api/v1/notes', ['POST'], { POST: d } as RoutePolicyDeclaration),
      );
    const ok = { class: 'content', item: none, keyArea: 'notes', aliasOf: 'POST /api/notes' };
    expect(keyed(ok).get('POST /api/v1/notes')).toMatchObject({ aliasOf: 'POST /api/notes' });
    expect(() => keyed({ ...ok, class: 'self' })).toThrow(/the class self on an alias/);
    expect(() => keyed({ ...ok, class: 'area', area: 'settings' })).toThrow(
      /the class area on an alias/,
    );
    expect(() => keyed({ ...ok, item: { none: 'another reason' } })).toThrow(
      /the item none: another reason on an alias of POST \/api\/notes, whose item is none: a test row/,
    );
    const readOnly = { ...ok } as Record<string, unknown>;
    delete readOnly.item;
    expect(() => keyed({ ...readOnly, effect: { read: 'reads only' } })).toThrow(
      /the effect read on an alias of POST \/api\/notes, whose effect is write/,
    );
    // An area alias whose area is not its base's.
    const areaBase = entry('/api/notes', ['POST'], {
      POST: { class: 'area', area: 'settings', item: none },
    });
    expect(() =>
      build(
        areaBase,
        entry('/api/v1/notes', ['POST'], {
          POST: { ...ok, class: 'area', area: 'users' },
        } as RoutePolicyDeclaration),
      ),
    ).toThrow(/the area users on an alias of POST \/api\/notes, whose area is settings/);
  });

  it('an alias says every key its base declares, but its own and the copied', () => {
    // Each key of the shape an alias may declare, one at a time: on the
    // base and not the alias, or on the alias and not the base, refused.
    // A key added to DECLARED_KEYS is held by default; this list is
    // checked against the shape below, so it gets a cell too.
    const aliasOf = 'POST /api/notes';
    const cases: [
      key: string,
      onBase: Record<string, unknown>,
      onAlias: Record<string, unknown>,
    ][] = [
      ['class', { class: 'content' }, { class: 'self' }],
      ['area', { class: 'area', area: 'settings' }, { class: 'area', area: 'users' }],
      ['public', { class: 'self' }, { class: 'self', public: true }],
      ['scope', { class: 'self' }, { class: 'self', scope: null }],
      ['effect', { class: 'content', item: none }, { class: 'content', effect: { read: 'r' } }],
      ['item', { class: 'content', item: none }, { class: 'content', item: { none: 'other' } }],
      ['makesItems', { class: 'content', item: none, makesItems: false }, { class: 'content' }],
      ['audit', { class: 'content', item: none }, { class: 'content', audit: 'own' }],
      ['caller', { class: 'self' }, { class: 'self', caller: 'session' }],
      ['base', { class: 'content', item: none }, { class: 'content', base: aliasOf }],
    ];
    const run = (onBase: Record<string, unknown>, onAlias: Record<string, unknown>) => {
      const baseDecl = { item: none, ...onBase };
      const mine = { item: none, ...onAlias } as Record<string, unknown>;
      if (Object.hasOwn(mine, 'effect')) delete mine.item;
      return build(
        entry('/api/notes', ['POST'], { POST: baseDecl } as RoutePolicyDeclaration),
        entry('/api/v1/notes', ['POST'], {
          POST: { ...mine, keyArea: 'notes', aliasOf },
        } as RoutePolicyDeclaration),
      );
    };
    for (const [key, onBase, onAlias] of cases) {
      const refusal =
        key === 'base'
          ? /both aliasOf and base/
          : new RegExp(`the ${key} .* on an alias of POST /api/notes, whose ${key} is `);
      expect(() => run(onBase, onAlias), key).toThrow(refusal);
    }
    // The base's own value said on the alias builds the row.
    expect(
      run(
        { class: 'content', item: none, makesItems: false, audit: 'own' },
        { class: 'content', makesItems: false, audit: 'own' },
      ).get('POST /api/v1/notes'),
    ).toMatchObject({ aliasOf, makesItems: false, audit: 'own' });
    // Every key of the shape has a cell, but the alias's own and the copied
    // (which an alias may not declare: the test above).
    expect(cases.map(([k]) => k).sort()).toEqual(
      DECLARED_KEYS.filter(
        (k) =>
          !(ALIAS_OWN as readonly string[]).includes(k) &&
          !(ALIAS_COPIES as readonly string[]).includes(k),
      ).sort(),
    );
  });

  it('a v1 row has the key area it declares, the one source (S9 part 3)', () => {
    const base = entry('/api/notes', ['GET'], { GET: { class: 'content', open: 'owner' } });
    const v1 = (pattern: string, d: Record<string, unknown>) =>
      build(base, entry(pattern, ['GET'], { GET: d } as RoutePolicyDeclaration));
    const alias = { class: 'content', aliasOf: 'GET /api/notes' };
    for (const keyArea of ['notes', 'tasks', null] as const) {
      expect(
        v1('/api/v1/notes', { ...alias, keyArea }).get('GET /api/v1/notes'),
        String(keyArea),
      ).toMatchObject({ keyArea, keySelf: false });
    }
    // None declared: not in the API (a key gets 'not-in-api').
    expect(v1('/api/v1/notes', alias).get('GET /api/v1/notes')?.keyArea).toBeUndefined();
    // Off /api/v1: refused (validateMethodPolicy).
    expect(() =>
      build(entry('/api/x', ['GET'], { GET: { class: 'content', keyArea: 'notes' } })),
    ).toThrow(/a key area off \/api\/v1/);
    // whoami: the key itself.
    const whoami = (d: Record<string, unknown>) =>
      build(
        entry('/api/v1/whoami', ['GET'], { GET: d } as RoutePolicyDeclaration, { GET: 'login' }),
      );
    expect(
      whoami({ class: 'content', open: 'any', keyArea: 'self' }).get('GET /api/v1/whoami'),
    ).toMatchObject({ keyArea: null, keySelf: true });
  });

  it('the named caller is read from the checked copy, once', () => {
    // A getter that answers publicLogin to the first read and another kind
    // after: the checked copy holds the first answer, and the row is built
    // from it alone.
    let reads = 0;
    const d = {
      class: 'public',
      get caller() {
        reads += 1;
        return reads === 1 ? 'publicLogin' : 'cookieUpgrade';
      },
    };
    const rows = build(
      entry('/api/auth/x', ['GET'], { GET: d } as unknown as RoutePolicyDeclaration, {
        GET: 'publicLogin',
      }),
    );
    expect(rows.get('GET /api/auth/x')).toMatchObject({ caller: 'publicLogin' });
  });

  it('a named caller is the one the code reads, both ways', () => {
    const pub = (caller: RouteCaller | null, d: Record<string, unknown>) =>
      build(
        entry(
          '/api/auth/x',
          ['GET'],
          { GET: d } as RoutePolicyDeclaration,
          caller ? { GET: caller } : {},
        ),
      );
    expect(
      pub('publicLogin', { class: 'public', caller: 'publicLogin' }).get('GET /api/auth/x'),
    ).toMatchObject({
      caller: 'publicLogin',
    });
    expect(() => pub(null, { class: 'public', caller: 'publicLogin' })).toThrow(/reads none/);
    expect(() => pub('cookieUpgrade', { class: 'public', caller: 'publicLogin' })).toThrow(
      /reads cookieUpgrade/,
    );
    expect(() => pub('publicLogin', { class: 'public' })).toThrow(/does not serve its row/);
  });

  it('an item a write names: its param is the segment the gate reads', () => {
    const rows = build(
      entry('/api/notes/:id', ['PATCH'], {
        PATCH: { class: 'content', item: { param: 'id', need: 'edit' } },
      }),
    );
    expect(rows.get('PATCH /api/notes/:id')?.item).toEqual({ need: 'edit', ref: 'node', seg: 3 });
  });
});

describe('S9: the loader asks a loaded module for the policy its rows were built from', () => {
  const policy = { GET: { class: 'content' } } as const;
  it('passes the same declaration, refuses another or none, and asks nothing of a stand-in', () => {
    const e = { pattern: '/api/notes', policy };
    expect(() => checkLoadedPolicy(e, { policy: { GET: { class: 'content' } } })).not.toThrow();
    expect(() => checkLoadedPolicy(e, { policy: { GET: { class: 'self' } } })).toThrow(
      /not the one the manifest read/,
    );
    expect(() => checkLoadedPolicy({ pattern: '/api/x' }, { policy })).toThrow(/not the one/);
    // L1: the manifest carries one the module does not export.
    expect(() => checkLoadedPolicy(e, { GET: () => null })).toThrow(/does not export/);
    // A test's stand-in routes opt out by name; neither carries one: nothing to ask.
    expect(() => checkLoadedPolicy(e, { GET: () => null }, { standIn: true })).not.toThrow();
    expect(() => checkLoadedPolicy({ pattern: '/api/x' }, { GET: () => null })).not.toThrow();
  });
});
