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
 *   - in warn, an edit the database would refuse in on is made and logged
 *     as an actor miss (named in docs/actors.md: a box below on is an
 *     emergency, the checks' floor of migration 0301); a delete is refused
 *     there too (the delete check, 0266, asks in every mode);
 *   - an item the scope does not read answers byte for byte what the random
 *     uuid answers (one 404: the refusal does not tell a hidden item from
 *     none), and is not written, in on and in warn; so does an id that is
 *     not a uuid (the route's params gateway).
 *
 * `was` is the old answer: the pre-check as the lists named it before part 2
 * (OLD_TARGET, emulated for a removed entry). In on, `now` refuses where
 * `was` refused and makes what `was` made (never looser); a family whose
 * entry is gone (`removed`) pins that the lists name no item for its
 * routes. Every answer is printed at the end, old and new.
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
import { READ_ONLY_COPY_MESSAGE } from '@mantle/std';
import { itemWriteTarget } from '../lib/auth/route-scope';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

/**
 * The HTTP item pre-check (the item the route names), bypassed while `on`
 * is false. While it is on, a route whose entry part 2 removed gets the
 * target the lists named before part 2 (`old`, OLD_TARGET below), so `was`
 * is the old answer in every run, and the file records old and new side by
 * side.
 */
type OldTarget = { id: string; need: 'read' | 'edit' | 'manage'; ref: 'node' };
const pre = vi.hoisted(() => ({
  on: true,
  old: null as null | ((key: string, path: string) => OldTarget | null),
}));
vi.mock('../lib/auth/route-policy', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/auth/route-policy')>();
  return {
    ...real,
    routeItemTarget: (...args: Parameters<typeof real.routeItemTarget>) =>
      pre.on ? (real.routeItemTarget(...args) ?? pre.old?.(args[0].key, args[1]) ?? null) : null,
  };
});

/** The lists of server/web/lib/auth/route-scope.ts before part 2 (main
 *  v0.300.82), less ITEM_REF_PREFIXES (their entries stay or are proven by
 *  their own cells): what itemWriteTarget named for a node route. */
const OLD_PREFIXES: readonly string[] = [
  '/api/pages',
  '/api/notes',
  '/api/draws',
  '/api/tables',
  '/api/apps',
  '/api/files/files',
  '/api/files/folders',
  '/api/tree/:kind/folders',
  '/api/tree/items',
  '/api/v1/pages',
  '/api/v1/tables',
  '/api/formulas',
  '/api/tasks',
  '/api/events',
  '/api/v1/tasks',
  '/api/recall/maps',
];
const OLD_READ_WRITES: ReadonlySet<string> = new Set([
  'POST /api/apps/:id/opened',
  'POST /api/apps/:id/frame-ticket',
  'POST /api/apps/:id/db-broker',
  'POST /api/apps/:id/tool-broker',
  'POST /api/apps/:id/duplicate',
  'POST /api/tree/items/:id/opened',
  'PUT /api/tree/items/:id/pin',
]);
const OLD_MANAGE_WRITES: ReadonlySet<string> = new Set(['POST /api/pages/:id/move']);
function OLD_TARGET(key: string, path: string): OldTarget | null {
  const m = key.slice(0, key.indexOf(' '));
  const pattern = key.slice(key.indexOf(' ') + 1);
  for (const prefix of OLD_PREFIXES) {
    const head = `${prefix}/:id`;
    if (pattern !== head && !pattern.startsWith(`${head}/`)) continue;
    const id = path.split('?')[0]!.split('/')[prefix.split('/').length];
    if (!id) return null;
    const need = OLD_READ_WRITES.has(key)
      ? 'read'
      : OLD_MANAGE_WRITES.has(key) || (m === 'DELETE' && pattern === head)
        ? 'manage'
        : 'edit';
    return { id, need, ref: 'node' };
  }
  return null;
}

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
  let c: typeof import('@mantle/content');
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
    /** Its body, for the item `id` (a random uuid for none). */
    body?: (id: string) => unknown;
    viaKey?: true;
    /** An owner's act (Recall): the handler refuses it to a login outside
     *  Admin (403 `*_is_owners`), 'first' before it reads the map (every id
     *  alike), 'after' once it found the map. */
    ownerAct?: 'first' | 'after';
    /** An id that is not a uuid gets the route's own 404 (`{"error":"not
     *  found"}`), where an id no row has gets the handler's, which names
     *  the id (Recall: map_not_found). Both 404, neither tells a hidden
     *  item from none. */
    badIdOwn?: true;
    /** Make a fresh item for `who` placed at `p` (place it last). */
    make: (who: Who, p: Place) => Promise<string>;
    /** In warn, a write the database refuses in on is made (logged as a
     *  miss): an edit's. A delete's check asks in every mode. */
    warnMade: boolean;
  };
  type Family = {
    name: string;
    /** Its entry is gone: the lists name no item for its routes. */
    removed: boolean;
    /** Why no snapshot copy of it exists (its copy cell is skipped). */
    noCopy?: string;
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
  const note = viaCreate('note_create', () => ({ title: `${tag} note ${n()}`, content: 'body' }));
  /** A drawing, made by its create route as the owner (no draw tool makes
   *  one), with a draft when `draft`, then placed. */
  const scene = () => ({ elements: [], appState: { pch: n() } });
  const drawing =
    (draft = false) =>
    async (who: Who, p: Place) => {
      const res = await runRoute(owner, 'POST', '/api/draws', { title: `${tag} draw ${n()}` });
      const id = idIn(await res.text());
      if (draft) {
        const d = await runRoute(owner, 'PUT', `/api/draws/${id}/draft`, { scene: scene() });
        expect(d.status, await d.text()).toBe(200);
      }
      await place(who, p)(id);
      return id;
    };
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
      warnMade: true,
      ...opts,
    },
    {
      name: `DELETE ${base}/:id`,
      need: 'manage' as const,
      method: 'DELETE',
      path: (id: string) => `${base}/${id}`,
      make,
      warnMade: false,
      ...opts,
    },
  ];

  /** A Recall map made as the owner, with `cards` cards (the first a
   *  prompt an agent asked for when `prompt`; edited once when `revision`,
   *  so its log holds a card edit to restore), then placed. Its version,
   *  card slugs and that revision are kept for the route's path and body. */
  const verOf = new Map<string, number>();
  const cardsOf = new Map<string, string[]>();
  const revOf = new Map<string, string>();
  const OWNER_ACTOR = { kind: 'owner', id: null, name: 'test' } as const;
  const AGENT_ACTOR = { kind: 'agent', id: null, name: 'test' } as const;
  const recallMap =
    (opts: { cards?: number; prompt?: true; revision?: true } = {}) =>
    async (who: Who, p: Place) => {
      const made = await sys(() =>
        c.createRecallMap(owner, { title: `${tag} map ${n()}`, enterWhen: 'a test' }, OWNER_ACTOR),
      );
      const id = made.mapId;
      let version = made.version;
      const slugs: string[] = [];
      for (let i = 0; i < (opts.cards ?? 1); i += 1) {
        const r = await sys(() =>
          c.putRecallCard(
            owner,
            id,
            null,
            {
              title: `${tag} card ${n()}`,
              bodyMd: 'body',
              useWhen: 'When the pre-check removal test asks.',
              ...(opts.prompt ? { prompt: true } : {}),
            },
            opts.prompt ? AGENT_ACTOR : OWNER_ACTOR,
            version,
          ),
        );
        version = r.version;
        slugs.push(r.cardSlug!);
      }
      if (opts.revision) {
        const r = await sys(() =>
          c.putRecallCard(
            owner,
            id,
            slugs[0]!,
            { title: `${tag} card edited ${n()}`, bodyMd: 'edited' },
            OWNER_ACTOR,
            version,
          ),
        );
        version = r.version;
        revOf.set(id, (await sys(() => c.listRecallRevisions(owner, id)))[0]!.id);
      }
      verOf.set(id, version);
      cardsOf.set(id, slugs);
      await place(who, p)(id);
      return id;
    };
  const ver = (id: string) => verOf.get(id) ?? 0;
  const card = (id: string, i = 0) => cardsOf.get(id)?.[i] ?? 'c1';

  const FAMILIES: Family[] = [
    {
      name: 'node kinds (formulas, tasks, events, v1 tasks)',
      removed: true,
      routes: [
        ...nodeRoutes('/api/formulas', formula),
        ...nodeRoutes('/api/tasks', task),
        ...nodeRoutes('/api/events', event),
        // v1 serves a task's GET and PATCH only.
        nodeRoutes('/api/v1/tasks', task, { viaKey: true })[0]!,
      ],
    },
    {
      name: 'notes',
      removed: true,
      routes: nodeRoutes('/api/notes', note),
    },
    {
      // The draft, commit and discard ask the caller's right first
      // (assertItemRight, in every mode): a scope that reads the drawing and
      // may not edit it reads no draft.
      name: 'drawings',
      removed: true,
      routes: [
        ...nodeRoutes('/api/draws', drawing()),
        {
          name: 'PUT /api/draws/:id/draft',
          need: 'edit',
          method: 'PUT',
          path: (id) => `/api/draws/${id}/draft`,
          body: () => ({ scene: scene() }),
          make: drawing(),
          warnMade: false,
        },
        {
          name: 'POST /api/draws/:id/commit',
          need: 'edit',
          method: 'POST',
          path: (id) => `/api/draws/${id}/commit`,
          body: () => ({ scene: scene() }),
          make: drawing(true),
          warnMade: false,
        },
        {
          name: 'POST /api/draws/:id/discard-draft',
          need: 'edit',
          method: 'POST',
          path: (id) => `/api/draws/${id}/discard-draft`,
          make: drawing(true),
          warnMade: false,
        },
      ],
    },
    {
      // Every map and card write locks the map in the login's scope first
      // (mapOr404: a map it does not read is map_not_found, as none); the
      // edit check (0281) asks edit of the map's node for its rows, manage
      // for its delete (and the delete check, 0266, in every mode). A
      // revision restore reads the revision in the scope first. The owner's
      // acts are refused to a member by the handler once it read the map (a
      // hidden one is the 404 of none, as the gate answered). In warn the
      // edit check still refuses these writes, as the gate did.
      name: 'recall maps and revisions',
      removed: true,
      noCopy: 'no snapshot copy of a Recall map is made (only an accepted item kinds)',
      routes: [
        {
          name: 'PATCH /api/recall/maps/:id',
          need: 'edit',
          method: 'PATCH',
          path: (id) => `/api/recall/maps/${id}`,
          body: (id) => ({ title: `${tag} retitled ${n()}`, version: ver(id) }),
          make: recallMap(),
          warnMade: false,
          badIdOwn: true,
        },
        {
          name: 'DELETE /api/recall/maps/:id',
          need: 'manage',
          method: 'DELETE',
          path: (id) => `/api/recall/maps/${id}`,
          make: recallMap(),
          warnMade: false,
          ownerAct: 'after',
          badIdOwn: true,
        },
        {
          name: 'POST /api/recall/maps/:id/cards',
          need: 'edit',
          method: 'POST',
          path: (id) => `/api/recall/maps/${id}/cards`,
          body: (id) => ({ title: `${tag} new card ${n()}`, bodyMd: 'new', version: ver(id) }),
          make: recallMap(),
          warnMade: false,
          badIdOwn: true,
        },
        {
          name: 'PUT /api/recall/maps/:id/cards/:card',
          need: 'edit',
          method: 'PUT',
          path: (id) => `/api/recall/maps/${id}/cards/${card(id)}`,
          body: (id) => ({ title: `${tag} card put ${n()}`, bodyMd: 'put', version: ver(id) }),
          make: recallMap(),
          warnMade: false,
          badIdOwn: true,
        },
        {
          name: 'DELETE /api/recall/maps/:id/cards/:card',
          need: 'edit',
          method: 'DELETE',
          path: (id) => `/api/recall/maps/${id}/cards/${card(id)}?version=${ver(id)}`,
          make: recallMap(),
          warnMade: false,
          badIdOwn: true,
        },
        {
          name: 'POST /api/recall/maps/:id/cards/reorder',
          need: 'edit',
          method: 'POST',
          path: (id) => `/api/recall/maps/${id}/cards/reorder`,
          body: (id) => ({ slugs: [card(id, 1), card(id, 0)], version: ver(id) }),
          make: recallMap({ cards: 2 }),
          warnMade: false,
          ownerAct: 'after',
          badIdOwn: true,
        },
        {
          name: 'POST /api/recall/maps/:id/cards/:card/prompt',
          need: 'edit',
          method: 'POST',
          path: (id) => `/api/recall/maps/${id}/cards/${card(id)}/prompt`,
          body: (id) => ({ confirm: true, version: ver(id) }),
          make: recallMap({ prompt: true }),
          warnMade: false,
          ownerAct: 'after',
          badIdOwn: true,
        },
        {
          name: 'POST /api/recall/revisions/:id/restore',
          need: 'edit',
          method: 'POST',
          path: (id) => `/api/recall/revisions/${revOf.get(id) ?? id}/restore`,
          make: recallMap({ revision: true }),
          warnMade: false,
          ownerAct: 'after',
          badIdOwn: true,
        },
      ],
    },
  ];

  // ── the cells ─────────────────────────────────────────────────────────────

  type Answer = { status: number; text: string; changed: boolean; misses: string[] };

  /** A reply with every uuid in it as <id>: a handler's 404 may name the id
   *  it was asked (Recall's map_not_found), the same words for each. */
  const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const ids = (text: string) => text.replace(UUID_G, '<id>');

  /** One request as `who` on `id` (a random uuid when `id` is null). */
  const send = async (route: Route, who: Who, id: string, precheck: boolean) => {
    pre.on = precheck;
    try {
      const login = route.viaKey ? { key: keyOf[who]! } : L[who];
      return await runRoute(login, route.method, route.path(id), route.body?.(id));
    } finally {
      pre.on = true;
    }
  };

  /** One cell on a fresh item: what it answered, whether the item changed,
   *  and the actor misses. */
  const once = async (
    route: Route,
    who: Who,
    p: Place,
    precheck: boolean,
    copy = false,
  ): Promise<Answer> => {
    const id = await route.make(who, p);
    // A read-only snapshot copy of an accepted item (data.snapshot_of):
    // nobody edits it (0267's triggers), its author may delete it.
    if (copy) {
      await raw.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true)`;
        await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
        await tx`update nodes set data = coalesce(data, '{}'::jsonb)
                   || jsonb_build_object('snapshot_of', ${randomUUID()}::text) where id = ${id}`;
      });
    }
    const before = await probe(id);
    m.takeActorMisses();
    const res = await send(route, who, id, precheck);
    const text = await res.text();
    const misses = m.takeActorMisses().map((x) => x.check);
    return { status: res.status, text, changed: (await probe(id)) !== before, misses };
  };

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
    c = await import('@mantle/content');
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
          (select row_to_json(d)::text from draws d where d.node_id = i),
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
    pre.old = OLD_TARGET;
  }, 300_000);

  afterAll(async () => {
    console.log(
      [
        'pre-check removal (HTTP), each cell (was: the pre-check; now: bypassed):',
        ...recorded,
      ].join('\n  '),
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
              // A member asking an owner's act the handler refuses first:
              // its 403 for every id (it tells nothing about any map).
              const ownerFirst = who === 'member' && route.ownerAct === 'first';
              const ownerAct = who === 'member' && route.ownerAct !== undefined;
              expect(noneNow.status, noneNowText).toBe(ownerFirst ? 403 : 404);
              expect(noneNowText).not.toMatch(RAW);
              // An id that is not a uuid names nothing either: the same 404
              // (or the route's own, see badIdOwn).
              const bad = await send(route, who, 'not-an-id', false);
              const badText = await bad.text();
              recorded.push(
                `${family.name} | ${route.name} ${mode} ${who}/not-an-id: ${bad.status}: ${badText}`,
              );
              if (ownerFirst) expect(bad.status, badText).toBe(403);
              else if (route.badIdOwn) {
                expect({ status: bad.status, text: badText }).toEqual({
                  status: 404,
                  text: '{"error":"not found"}',
                });
              } else {
                expect({ status: bad.status, text: badText }).toEqual({
                  status: noneNow.status,
                  text: noneNowText,
                });
              }
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
                  expect({ status: now.status, text: ids(now.text) }, name).toEqual({
                    status: noneNow.status,
                    text: ids(noneNowText),
                  });
                  expect(now.changed, `${name} changed the item`).toBe(false);
                } else if (ownerAct) {
                  // The owner's act, refused to a member by the handler.
                  expect(now.status, `${name}: ${now.text}`).toBe(403);
                  expect(now.text, name).toMatch(/_is_owners/);
                  expect(now.changed, `${name} changed the item`).toBe(false);
                } else if (ALLOWED[route.need].includes(p)) {
                  expect(now.status, `${name}: ${now.text}`).toBeLessThan(300);
                  expect(now.changed, `${name} made no write`).toBe(true);
                  expect(now.misses, name).toEqual([]);
                } else if (mode === 'on' || !route.warnMade) {
                  expect(now.status, `${name}: ${now.text}`).toBe(403);
                  expect(now.text, name).toContain('item-workspace');
                  expect(now.changed, `${name} changed the item`).toBe(false);
                } else {
                  // warn: the database makes the write and logs it.
                  expect(now.status, `${name}: ${now.text}`).toBeLessThan(300);
                  expect(now.changed, `${name} made no write`).toBe(true);
                  expect(now.misses.length, name).toBeGreaterThan(0);
                }
                // Never looser than the pre-check in on: the same writes made,
                // the same refused (warn: the named change above).
                if (mode === 'on' || p === 'noRead' || !route.warnMade) {
                  expect(
                    { ok: now.status < 300, changed: now.changed },
                    `${name}: was ${line(was)}`,
                  ).toEqual({ ok: was.status < 300, changed: was.changed });
                }
              }
              if (route.need === 'edit' && !family.noCopy) {
                // A read-only copy the login may manage: the pre-check's
                // read-only answer, now the database's (every mode).
                const name = `${route.name} ${mode} ${who}/copy`;
                const was = await once(route, who, 'allowed', true, true);
                const now = await once(route, who, 'allowed', false, true);
                recorded.push(
                  `${family.name} | ${name}\n      was ${line(was)}\n      now ${line(now)}`,
                );
                expect(now.text, name).not.toMatch(RAW);
                // The copy's answer is kept (the CEO's decision, round 2):
                // the one mapper says it in the copy's words, with readOnly
                // (jackdaw shows its copy note by it), as the gate did.
                expect(now.status, `${name}: ${now.text}`).toBe(403);
                const copyBody = {
                  error: 'forbidden',
                  reason: 'item-workspace',
                  message: READ_ONLY_COPY_MESSAGE,
                  readOnly: true,
                };
                expect(JSON.parse(now.text), name).toEqual({ ...copyBody, code: 'forbidden' });
                expect(was.status, `${name}: ${was.text}`).toBe(403);
                expect(JSON.parse(was.text), name).toMatchObject(copyBody);
                expect(now.changed, `${name} changed the copy`).toBe(false);
                expect(was.changed).toBe(false);
              }
              const pattern = route.name.slice(route.name.indexOf(' ') + 1);
              const target = itemWriteTarget(route.method, pattern, route.path(none));
              if (family.removed) expect(target, route.name).toBeNull();
              else expect(target, route.name).not.toBeNull();
            }, 300_000);
          }
        }
      }
    });
  }
});
