/**
 * Plan v3.2 S9: the route lists folded into a declaration in each route
 * file (route-declaration.ts). Part 0 builds the tooling; the lists stay
 * the source (ROUTE_POLICY_SOURCE) until part 2.
 *
 * Pinned here, on every run:
 *  - the declarations the codemod derives from the lists
 *    (scripts/route-declarations.ts) build every row equal, field for
 *    field, to the lists' row (buildRoutePolicy, source 'declarations');
 *  - a manifest that carries declarations (after part 1's codemod run, or
 *    on its dry-run tree) carries one for every route file, each the one
 *    the lists say, and its rows are the lists' rows;
 *  - every row, every field, against the snapshot
 *    (__snapshots__/route-policy.rows.json): the rows parts 2 and 3 hold
 *    byte-equal while the lists go;
 *  - a declaration that cannot hold is refused at boot.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkLoadedPolicy } from '../../server/route-loader';
import { entryDeclaration } from '../../scripts/route-declarations';
import type { MethodPolicy, RoutePolicyDeclaration } from './route-declaration';
import {
  ROUTE_POLICY_SOURCE,
  buildRoutePolicy,
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
  let lists: ReadonlyMap<string, RouteRow>;

  beforeAll(async () => {
    manifest = (await import('../../server/route-manifest.gen')).routeManifest;
    lists = buildRoutePolicy(manifest, { source: 'lists' });
  });

  it('the declarations derived from the lists build every row equal to the lists', () => {
    const derived = manifest.map((e) => ({ ...e, policy: entryDeclaration(lists, e) }));
    const declared = buildRoutePolicy(derived, { source: 'declarations' });
    const diffs: string[] = [];
    for (const [key, row] of lists) {
      const got = declared.get(key);
      if (JSON.stringify(got) !== JSON.stringify(row)) {
        diffs.push(`${key}: ${JSON.stringify(got)} != ${JSON.stringify(row)}`);
      }
    }
    expect(diffs).toEqual([]);
    expect(declared.size).toBe(lists.size);
    // The numbers of the handover (part 0, on main v0.300.132): 418 route
    // files, 819 rows, 572 methods declared. They move with the routes;
    // the floor only says the walk saw them.
    const methods = derived.reduce((n, e) => n + Object.keys(e.policy).length, 0);
    expect(manifest.length).toBeGreaterThan(400);
    expect(methods).toBeGreaterThan(550);
    expect(lists.size).toBeGreaterThan(methods);
  });

  it("a manifest's declarations: one for every route file or none, each the lists' own", () => {
    const withPolicy = manifest.filter((e) => e.policy !== undefined);
    if (withPolicy.length === 0) {
      // Part 0: no route file declares yet, and the rows are the lists'.
      expect(ROUTE_POLICY_SOURCE).toBe('lists');
      return;
    }
    expect(manifest.filter((e) => e.policy === undefined).map((e) => e.pattern)).toEqual([]);
    for (const e of manifest) {
      expect(e.policy, e.pattern).toEqual(entryDeclaration(lists, e));
    }
    const declared = buildRoutePolicy(manifest, { source: 'declarations' });
    expect([...declared.values()].map((r) => JSON.stringify(r))).toEqual(
      [...lists.values()].map((r) => JSON.stringify(r)),
    );
  });

  it('every row, every field, as the snapshot says', async () => {
    const lines = [...lists.values()].map(snapshotLine).sort();
    await expect(`{\n${lines.join(',\n')}\n}\n`).toMatchFileSnapshot(
      './__snapshots__/route-policy.rows.json',
    );
  });
});

describe('S9: a declaration that cannot hold is refused at boot', () => {
  const entry = (pattern: string, methods: string[], policy: RoutePolicyDeclaration) => ({
    pattern,
    methods,
    reads: Object.fromEntries(methods.map((m) => [m, 'owner' as const])),
    policy,
  });
  const build = (...entries: RouteManifestEntry[]) =>
    buildRoutePolicy(entries, { source: 'declarations' });
  const read: MethodPolicy = { class: 'content', effect: 'read' };

  it('builds the rows a declaration says; a HEAD takes its GET’s', () => {
    const rows = build(
      entry('/api/notes', ['GET', 'POST'], {
        GET: { ...read, open: 'owner' },
        POST: { class: 'content', effect: 'write', open: 'owner', creates: true },
      }),
    );
    expect(rows.get('GET /api/notes')).toMatchObject({ class: 'content', logins: 'owner' });
    expect(rows.get('HEAD /api/notes')).toMatchObject({ effect: 'read', creates: false });
    expect(rows.get('POST /api/notes')).toMatchObject({ creates: true, makesItems: true });
  });

  it('refuses a route file that declares no policy, or one for a method it does not serve', () => {
    expect(() =>
      build({ pattern: '/api/notes', methods: ['GET'], reads: { GET: 'owner' } }),
    ).toThrow(/declares no policy for GET/);
    expect(() => build(entry('/api/notes', ['GET'], { GET: read, POST: read }))).toThrow(
      /policy for POST, which it does not serve/,
    );
    // The lists' rows read no declaration, but a stray one is still refused.
    expect(() =>
      buildRoutePolicy([entry('/api/notes', ['GET'], { GET: read, PUT: read })], {
        source: 'lists',
      }),
    ).toThrow(/policy for PUT/);
  });

  it('refuses each value that cannot hold', () => {
    const bad = (pattern: string, d: Record<string, unknown>, why: RegExp) =>
      expect(() => build(entry(pattern, ['POST'], { POST: d as MethodPolicy }))).toThrow(why);
    bad('/api/notes', { class: 'link', effect: 'read' }, /link row is an \/s route/);
    bad('/api/notes', { class: 'nope', effect: 'read' }, /class nope/);
    bad('/api/notes', { class: 'area', effect: 'write' }, /area on a row/);
    bad('/api/notes', { class: 'area', area: 'bogus', effect: 'write' }, /area bogus/);
    bad('/api/notes', { class: 'content', effect: 'write', public: true }, /public: only/);
    bad('/api/notes', { class: 'content', effect: 'write', scope: null }, /scope: only/);
    bad('/api/x', { class: 'self', effect: 'write', scope: null }, /no list opens/);
    bad('/api/notes', { class: 'content', effect: 'read', creates: true }, /creates/);
    bad('/api/notes', { class: 'content', effect: 'read', makesItems: false }, /makesItems/);
    bad('/api/notes', { class: 'content', effect: 'write', open: 'all' }, /open all/);
    bad('/api/notes', { class: 'content', effect: 'write', wat: 1 }, /wat, which no row has/);
    bad(
      '/api/notes/:id',
      { class: 'content', effect: 'write', item: { param: 'nodeId', need: 'edit' } },
      /no param/,
    );
    bad('/api/notes', { class: 'content', effect: 'write', keyArea: 'notes' }, /off \/api\/v1/);
    bad('/api/v1/notes', { class: 'content', effect: 'write', keyArea: 'bogus' }, /key area bogus/);
    bad(
      '/api/v1/notes',
      { class: 'content', effect: 'write', aliasOf: 'POST /api/notes' },
      /does not serve/,
    );
    bad(
      '/api/v1/notes',
      { class: 'content', effect: 'write', aliasOf: 'GET /api/notes' },
      /same method of its base/,
    );
    bad(
      '/api/notes',
      { class: 'content', effect: 'write', limits: { rateLimit: ['bogus'] } },
      /takes bogus, no limit/,
    );
  });

  it('an item a write names: its param is the segment the gate reads', () => {
    const rows = build(
      entry('/api/notes/:id', ['PATCH'], {
        PATCH: { class: 'content', effect: 'write', item: { param: 'id', need: 'edit' } },
      }),
    );
    expect(rows.get('PATCH /api/notes/:id')?.item).toEqual({ need: 'edit', ref: 'node', seg: 3 });
  });
});

describe('S9: the loader asks a loaded module for the policy its rows were built from', () => {
  const policy = { GET: { class: 'content', effect: 'read' } } as const;
  it('passes the same declaration, refuses another, and asks nothing of the lists', () => {
    const e = { pattern: '/api/notes', policy };
    expect(() =>
      checkLoadedPolicy(
        e,
        { policy: { GET: { effect: 'read', class: 'content' } } },
        'declarations',
      ),
    ).not.toThrow();
    expect(() => checkLoadedPolicy(e, { policy: { GET: read2() } }, 'declarations')).toThrow(
      /not the one the manifest read/,
    );
    expect(() => checkLoadedPolicy(e, {}, 'declarations')).toThrow(/not the one/);
    expect(() => checkLoadedPolicy(e, {}, 'lists')).not.toThrow();
  });
  const read2 = () => ({ class: 'content', effect: 'write' });
});
