/**
 * The pre-check removal's proof, part 2: the HTTP entries (docs/actors.md,
 * "Pre-check removal Part 2 (HTTP)"). The sibling of
 * precheck-removal.db.test.ts (the tool entries, part 1), in its own file so
 * the two parts' cells land without touching each other's.
 *
 * Each cell sends a real request through the full HTTP pipeline (runRoute:
 * the gate, the route's ROUTE_POLICY row, the session guard, the handler)
 * on a migrated scratch database, in the database's checks `on` and in
 * `warn`, as a member (a Moderator of H, a user of R and of W) and as an
 * Admin user (a user and Moderator of Admin, in no other workspace; not the
 * owner). Each item is placed so the login:
 *
 *   allowed   may manage it (the member: homed in H; the Admin user: in
 *             Admin)
 *   editOnly  may edit, not manage (homed in X, granted to W or to Admin
 *             with Write on)
 *   noEdit    reads it, may not edit (the member: homed in R; the Admin
 *             user: homed in X, granted to Admin with Write off)
 *   noRead    does not read it (the member: homed in O; the Admin user:
 *             homed in X, no grant to Admin)
 *
 * and one more request names a random uuid (no row at all). Every cell runs
 * twice on fresh items: with the HTTP item pre-check (`was`: itemWriteGate
 * on the item the route names, routeItemTarget) and with it bypassed
 * (`now`: only the database and the handler stand). What `now` must answer:
 *
 *   - an allowed write is made (2xx);
 *   - in on, a refused one is the database's refusal (403
 *     `item-workspace`, the mapper's words, never the database's own) and
 *     leaves the item as it was (pch_probe: its rows, content rows, links,
 *     grants, history);
 *   - in warn, the write the database would refuse in on is made and logged
 *     as an actor miss (named in docs/actors.md: a box below on is an
 *     emergency, the checks' floor of migration 0301);
 *   - an item the scope does not read answers byte for byte what the random
 *     uuid answers (one 404: the refusal does not tell a hidden item from
 *     none), and is not written, in on and in warn.
 *
 * A family whose entry is gone (`removed`) also pins that the bypass
 * changes nothing: `was` answers as `now`. Every answer is printed at the
 * end (the old answers of each family were recorded by its first run, on
 * the code before its removal).
 *
 * It sets both checks itself, so it runs in `pnpm test` only (not again in
 * `pnpm test:edit-on`).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/precheck-removal-http.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

/** The HTTP item pre-check (the item the route names), bypassed while `on`
 *  is false. */
const pre = vi.hoisted(() => ({ on: true }));
vi.mock('../lib/auth/route-policy', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/auth/route-policy')>();
  return {
    ...real,
    routeItemTarget: (...args: Parameters<typeof real.routeItemTarget>) =>
      pre.on ? real.routeItemTarget(...args) : null,
  };
});

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));

/** The database's or the runtime's own words: never in a reply. */
const RAW =
  /Failed query|withSystemTx|runInSystemTx|SQLSTATE|DrizzleQueryError|drizzle-orm|permission denied for|violates|duplicate key|does not exist|\n\s+at \S/i;

type Mode = 'warn' | 'on';
type Who = 'member' | 'admin';
type Place = 'allowed' | 'editOnly' | 'noEdit' | 'noRead';
type Need = 'edit' | 'manage';

/** What a need lets each placement do. */
const ALLOWED: Record<Need, Place[]> = {
  edit: ['allowed', 'editOnly'],
  manage: ['allowed'],
};
const PLACES: readonly Place[] = ['noRead', 'noEdit', 'editOnly', 'allowed'];
const MODES: readonly Mode[] = ['on', 'warn'];

describe.skipIf(!DB_URL)('the pre-check removal, part 2: the HTTP entries', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let actorMode: typeof import('../../../packages/db/src/actor');
  let runRoute: typeof import('./run-route').runRoute;
  let dir = '';
  const tag = `pch${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  const L: Record<Who, string> = { member: randomUUID(), admin: randomUUID() };
  const keyOf: Partial<Record<Who, string>> = {};
  const ws = { admin: '', H: '', R: '', W: '', X: '', O: '' };
  const recorded: string[] = [];

  // ── the fixture ───────────────────────────────────────────────────────────

  const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:pch', fn) as Promise<T>;

  /** A builtin called as the owner with no scope: the fixture's own makes. */
  const sysTool = async (slug: string, input: Record<string, unknown>): Promise<unknown> => {
    const row = { slug, handler: { kind: 'builtin', ref: slug } } as never;
    const res = await sys(() =>
      t.dispatchTool(row, input, {
        ownerId: owner,
        surface: { kind: 'owner', via: 'api' },
        caller: t.apiV1Caller(),
      }),
    );
    if (!res.ok) throw new Error(`fixture ${slug}: ${String(res.error)}`);
    return res.output;
  };
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
  const idIn = (out: unknown): string => {
    const m0 = UUID.exec(typeof out === 'string' ? out : JSON.stringify(out));
    if (!m0) throw new Error(`no id in ${JSON.stringify(out).slice(0, 200)}`);
    return m0[0];
  };
  const n = () => randomUUID().slice(0, 8);

  /** The grants of `who`'s `place` (see the header). */
  const grantsOf = (who: Who, place: Place): [string, boolean, boolean][] => {
    if (who === 'member') {
      if (place === 'allowed') return [[ws.H, true, false]];
      if (place === 'noEdit') return [[ws.R, true, false]];
      if (place === 'editOnly')
        return [
          [ws.X, true, false],
          [ws.W, false, true],
        ];
      return [[ws.O, true, false]];
    }
    if (place === 'allowed') return [[ws.admin, true, false]];
    if (place === 'noEdit')
      return [
        [ws.X, true, false],
        [ws.admin, false, false],
      ];
    if (place === 'editOnly')
      return [
        [ws.X, true, false],
        [ws.admin, false, true],
      ];
    return [[ws.X, true, false]];
  };

  /** Give `id` exactly these grants (its own; none inherited). */
  const grant = async (id: string, grants: [string, boolean, boolean][]) => {
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${id}`;
      for (const [w, home, write] of grants) {
        await tx`insert into item_grants (node_id, workspace_id, is_home, write)
                 values (${id}, ${w}, ${home}, ${write})`;
      }
    });
  };
  const place = (who: Who, p: Place) => (id: string) => grant(id, grantsOf(who, p));

  /** Everything a refused write must leave as it was. */
  const probe = async (id: string) =>
    (await raw<{ p: string }[]>`select pch_probe(${id}::uuid) as p`)[0]!.p;

  /** The box's checks and the process's, together. */
  const setMode = async (mode: Mode) => {
    await raw`select mantle_set_actor_check(${mode}, 50, 'test')`;
    await raw`select mantle_set_edit_check(${mode}, 50, 'test')`;
    process.env.MANTLE_ACTOR_CHECK = mode;
    actorMode.noteBoxActorCheckMode(mode);
    expect(m.actorCheckMode()).toBe(mode);
  };

  // ── the routes ────────────────────────────────────────────────────────────

  /** One request: the method, the path for an item id, its body, and
   *  whether it goes with the login's API key (an /api/v1 route). */
  type Route = {
    name: string;
    need: Need;
    method: string;
    path: (id: string) => string;
    body?: () => unknown;
    viaKey?: true;
    /** Make a fresh item for `who` placed at `p` (place it last). */
    make: (who: Who, p: Place) => Promise<string>;
  };
  type Family = {
    name: string;
    /** Its entry is gone: the bypass changes nothing. */
    removed: boolean;
    routes: Route[];
  };

  /** A node made by its create tool, then placed. */
  const viaCreate =
    (slug: string, input: () => Record<string, unknown>) => async (who: Who, p: Place) => {
      const id = idIn(await sysTool(slug, input()));
      await place(who, p)(id);
      return id;
    };
  const task = viaCreate('task_create', () => ({ title: `${tag} task ${n()}` }));
  const event = viaCreate('event_create', () => ({
    title: `${tag} event ${n()}`,
    startsAt: '2030-01-01T10:00:00Z',
  }));
  const formula = viaCreate('formula_create', () => ({
    title: `${tag} formula ${n()}`,
    spec: {
      id: `f${n()}`,
      name: 'F',
      source: { standard: 'none' },
      variables: [],
      expressions: [],
      piecewise: [],
      lookups: [],
      classifications: [],
    },
  }));
  const retitle = () => ({ title: `${tag} retitled ${n()}` });

  /** The node kinds' edit (PATCH) and delete (DELETE): one statement each,
   *  the write check (0278) and the delete check (0266). */
  const nodeRoutes = (base: string, make: Route['make'], opts: { viaKey?: true } = {}) => [
    {
      name: `PATCH ${base}/:id`,
      need: 'edit' as const,
      method: 'PATCH',
      path: (id: string) => `${base}/${id}`,
      body: retitle,
      make,
      ...opts,
    },
    {
      name: `DELETE ${base}/:id`,
      need: 'manage' as const,
      method: 'DELETE',
      path: (id: string) => `${base}/${id}`,
      make,
      ...opts,
    },
  ];

  const FAMILIES: Family[] = [
    {
      name: 'node kinds (formulas, tasks, events, v1 tasks)',
      removed: false,
      routes: [
        ...nodeRoutes('/api/formulas', formula),
        ...nodeRoutes('/api/tasks', task),
        ...nodeRoutes('/api/events', event),
        // v1 serves a task's GET and PATCH only.
        nodeRoutes('/api/v1/tasks', task, { viaKey: true })[0]!,
      ],
    },
  ];

  // ── the cells ─────────────────────────────────────────────────────────────

  type Answer = { status: number; text: string; changed: boolean; misses: string[] };

  /** One request as `who` on `id` (a random uuid when `id` is null). */
  const send = async (route: Route, who: Who, id: string, precheck: boolean) => {
    pre.on = precheck;
    try {
      const login = route.viaKey ? { key: keyOf[who]! } : L[who];
      return await runRoute(login, route.method, route.path(id), route.body?.());
    } finally {
      pre.on = true;
    }
  };

  /** One cell on a fresh item: what it answered, whether the item changed,
   *  and the actor misses. */
  const once = async (route: Route, who: Who, p: Place, precheck: boolean): Promise<Answer> => {
    const id = await route.make(who, p);
    const before = await probe(id);
    m.takeActorMisses();
    const res = await send(route, who, id, precheck);
    const text = await res.text();
    const misses = m.takeActorMisses().map((x) => x.check);
    return { status: res.status, text, changed: (await probe(id)) !== before, misses };
  };

  /** A reply without what each run makes up. */
  const plain = (text: string) =>
    text
      .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T')
      .replace(new RegExp(UUID.source, 'g'), 'ID')
      .replace(new RegExp(`${tag}\\w*( \\w+)*`, 'g'), 'TAG');

  const line = (a: Answer) =>
    `${a.status}${a.changed ? ' changed' : ''}${a.misses.length ? ` misses=${a.misses.length}` : ''}: ${a.text
      .slice(0, 170)
      .replace(/\s+/g, ' ')}`;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'precheck-removal-http-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'precheck-removal-http-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the pre-check removal test', { status: 503 })),
    );
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    actorMode = await import('../../../packages/db/src/actor');
    runRoute = (await import('./run-route')).runRoute;
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });

    await raw`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-owner@example.invalid`}, 'x', true, 'admin', 'Owner'),
             (${L.admin}, ${`${tag}-admin@example.invalid`}, 'x', false, 'admin', 'Admin'),
             (${L.member}, ${`${tag}-member@example.invalid`}, 'x', false, 'member', 'Member')`;
    await raw`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`;
    await raw`select * from mantle_ws_migrate()`;
    ws.admin = (
      await raw<{ id: string }[]>`select id::text as id from workspaces
                                    where owner_id = ${owner} and is_admin`
    )[0]!.id;
    for (const key of ['H', 'R', 'W', 'X', 'O'] as const) {
      ws[key] = (
        await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
          values (${owner}, ${`${tag} ${key}`}) returning id::text as id`
      )[0]!.id;
    }
    await raw`delete from workspace_users u using workspaces w
               where w.id = u.workspace_id and not w.is_admin
                 and u.login_id in (${owner}, ${L.admin}, ${L.member})`;
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.H}, ${L.member}, true), (${ws.R}, ${L.member}, false),
             (${ws.W}, ${L.member}, false), (${ws.admin}, ${L.admin}, true)
      on conflict (workspace_id, login_id) do update set moderator = excluded.moderator`;
    await m.asSystem(() => t.seedBuiltinTools(owner), 'test');
    const keys = await import('../lib/access-keys');
    for (const who of ['member', 'admin'] as const) {
      const minted = await m.asSystem(
        () =>
          keys.mintAccessKey({
            name: `${tag} ${who}`,
            loginId: L[who],
            access: 'read_write',
            areas: null,
            riskyTools: [],
            expiresAt: new Date(Date.now() + 30 * 86_400_000),
            createdBy: L[who],
            maxLive: 50,
          }),
        'test',
      );
      keyOf[who] = minted!.key;
    }
    // The probe: a definer, so it sees the rows whoever sent the request.
    await raw.unsafe(`
      create or replace function pch_probe(i uuid) returns text
        language sql stable security definer set search_path = public, pg_temp as $$
        select coalesce((select md5(concat_ws(' | ',
          row_to_json(n)::text,
          (select row_to_json(p)::text from pages p where p.node_id = i),
          (select row_to_json(t)::text from tables t where t.node_id = i),
          (select row_to_json(a)::text from apps a where a.node_id = i),
          (select row_to_json(r)::text from recall_maps r where r.node_id = i),
          (select string_agg(row_to_json(c)::text, ',' order by c.id)
             from recall_nodes c join recall_maps r on r.id = c.map_id where r.node_id = i),
          (select count(*)::text from recall_revisions v join recall_maps r on r.id = v.map_id
            where r.node_id = i),
          (select string_agg(row_to_json(s)::text, ',' order by s.token)
             from shares s where s.node_id = i),
          (select string_agg(row_to_json(x)::text, ',' order by x.id)
             from node_snapshots x where x.node_id = i),
          (select string_agg(row_to_json(g)::text, ',' order by g.workspace_id)
             from item_grants g where g.node_id = i),
          (select string_agg(row_to_json(c)::text, ',' order by c.id)
             from nodes c where c.path <@ n.path and c.id <> n.id and n.type = 'branch')))
          from nodes n where n.id = i), 'gone')
      $$;
      revoke all on function pch_probe(uuid) from public;`);
    m.takeActorMisses();
  }, 300_000);

  afterAll(async () => {
    console.log(
      ['pre-check removal (HTTP), each cell (was: the pre-check; now: bypassed):', ...recorded].join(
        '\n  ',
      ),
    );
    pre.on = true;
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    vi.unstubAllGlobals();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  for (const family of FAMILIES) {
    describe(family.name, () => {
      for (const route of family.routes) {
        for (const mode of MODES) {
          for (const who of ['member', 'admin'] as const) {
            it(`${route.name} (${route.need}) as ${who}, ${mode}: the database and the handler answer`, async () => {
              await setMode(mode);
              // An id no row has: the answer a hidden item must give.
              const none = randomUUID();
              const noneNow = await send(route, who, none, false);
              const noneNowText = await noneNow.text();
              const noneWas = await send(route, who, none, true);
              const noneWasText = await noneWas.text();
              recorded.push(
                `${family.name} | ${route.name} ${mode} ${who}/none\n      was ${noneWas.status}: ${noneWasText}\n      now ${noneNow.status}: ${noneNowText}`,
              );
              expect(noneNow.status, noneNowText).toBe(404);
              expect(noneNowText).not.toMatch(RAW);
              for (const p of PLACES) {
                const name = `${route.name} ${mode} ${who}/${p}`;
                const was = await once(route, who, p, true);
                const now = await once(route, who, p, false);
                recorded.push(
                  `${family.name} | ${name}\n      was ${line(was)}\n      now ${line(now)}`,
                );
                expect(now.text, name).not.toMatch(RAW);
                if (p === 'noRead') {
                  // One 404: a hidden item is answered as no item at all.
                  expect({ status: now.status, text: now.text }, name).toEqual({
                    status: noneNow.status,
                    text: noneNowText,
                  });
                  expect(now.changed, `${name} changed the item`).toBe(false);
                } else if (ALLOWED[route.need].includes(p)) {
                  expect(now.status, `${name}: ${now.text}`).toBeLessThan(300);
                  expect(now.changed, `${name} made no write`).toBe(true);
                  expect(now.misses, name).toEqual([]);
                } else if (mode === 'on') {
                  expect(now.status, `${name}: ${now.text}`).toBe(403);
                  expect(now.text, name).toContain('item-workspace');
                  expect(now.changed, `${name} changed the item`).toBe(false);
                } else {
                  // warn: the database makes the write and logs it.
                  expect(now.status, `${name}: ${now.text}`).toBeLessThan(300);
                  expect(now.changed, `${name} made no write`).toBe(true);
                  expect(now.misses.length, name).toBeGreaterThan(0);
                }
                if (family.removed) {
                  // The entry is gone: the bypass changes nothing.
                  expect(
                    { status: was.status, changed: was.changed, text: plain(was.text) },
                    name,
                  ).toEqual({ status: now.status, changed: now.changed, text: plain(now.text) });
                }
              }
              if (family.removed) {
                expect({ status: noneWas.status, text: noneWasText }).toEqual({
                  status: noneNow.status,
                  text: noneNowText,
                });
              }
            }, 300_000);
          }
        }
      }
    });
  }
});
