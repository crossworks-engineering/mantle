/**
 * mantle_graph_walk and mantle_graph_path (migration 0396) against a real,
 * migrated Postgres:
 *  - a cycle does not loop, and each entity comes once;
 *  - a retired edge (valid_to set) is not walked by default, and is when
 *    current_only is false;
 *  - directed against undirected, the relation filter, and edges that are
 *    not entity to entity (never walked);
 *  - the depth clamp (1..6) and the limit clamp (1..200), nearest first;
 *  - the path is a true shortest path, with the stated tie-break (the
 *    first path when hops are compared from the start, by verb, then id);
 *  - one owner's walk never uses another owner's edges, on the app's pool
 *    (the runtime role in `pnpm test:runtime-role`) and through graphPath;
 *  - both run as their caller, STABLE, with a pinned search_path, and run
 *    in a READ ONLY transaction;
 *  - on a random graph the reached set and the depths equal the old walk's
 *    (the recursive CTE graph_path sent as text before 0396, kept here
 *    only as the oracle), and every path is made of real edges.
 *
 * Fixtures go through a superuser client of this file's own (never the
 * app's pool, which logs in as the runtime role in that lane). Two fresh
 * logins own the rows; both are deleted after (the rows cascade).
 *   MANTLE_TEST_DATABASE_URL=postgres://... pnpm test packages/search/src/graph-functions.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type WalkRow = { entity_id: string; depth: number; path_ids: string[]; relations: string[] };
type Edge = { s: string; t: string; rel: string; retired?: boolean; kinds?: [string, string] };

/** The walk graph_path sent as text before 0396 (every simple path, then
 *  the shortest per entity), kept only as this file's oracle. It walks
 *  retired edges too. */
function oldWalkSql(o: {
  owner: string;
  from: string;
  maxDepth: number;
  directed: boolean;
  relations: string[] | null;
  limit: number;
}): string {
  const relCond = o.relations
    ? `and e.relation in (${o.relations.map((r) => `'${r}'`).join(',')})`
    : '';
  const reverseLeg = o.directed
    ? ''
    : `union all
       select e.source_id as other, e.relation
       from entity_edges e
       where e.owner_id = '${o.owner}'::uuid
         and e.source_kind = 'entity' and e.target_kind = 'entity'
         and e.target_id = w.node_id ${relCond}`;
  return `
    with recursive walk as (
      select s.id as node_id, array[s.id] as path_ids, '{}'::text[] as rels, 0 as depth
      from (select '${o.from}'::uuid as id) s
      union all
      select nxt.other, w.path_ids || nxt.other, w.rels || nxt.relation, w.depth + 1
      from walk w
      cross join lateral (
        select e.target_id as other, e.relation
        from entity_edges e
        where e.owner_id = '${o.owner}'::uuid
          and e.source_kind = 'entity' and e.target_kind = 'entity'
          and e.source_id = w.node_id ${relCond}
        ${reverseLeg}
      ) nxt
      where w.depth < ${o.maxDepth}
        and not (nxt.other = any(w.path_ids))
    )
    select distinct on (node_id) node_id::text as node_id, depth
    from walk
    where depth > 0
    order by node_id, depth asc
    limit ${o.limit}`;
}

/** A small seeded random source, so a failure repeats. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A postgres.js client (this package has no postgres dependency). */
type Pg = ReturnType<(typeof import('@mantle/db/test-support'))['superuserClient']>;

describe.skipIf(!URL)('mantle_graph_walk and mantle_graph_path', () => {
  type Db = typeof import('@mantle/db');
  type Search = typeof import('./entities');
  let m: Db;
  let s: Search;
  let su: Pg;
  /** The app's pool: the runtime role in `pnpm test:runtime-role`. */
  let app: Pg;
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const tag = `gfn${randomUUID().slice(0, 8)}`;
  /** name -> id, per owner. */
  const ids = new Map<string, string>();
  const id = (name: string) => {
    const v = ids.get(name);
    if (!v) throw new Error(`no entity ${name}`);
    return v;
  };

  /** Entities for `owner`, by name. */
  async function addEntities(owner: string, names: string[]): Promise<void> {
    const rows = names.map((n) => ({ id: randomUUID(), n }));
    for (const r of rows) ids.set(r.n, r.id);
    await su.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true),
                      set_config('mantle.write_mode', 'rw', true)`;
      await tx`insert into entities (id, owner_id, kind, name)
        select x.id, ${owner}::uuid, 'org', ${tag} || ' ' || x.n
          from unnest(${rows.map((r) => r.id)}::uuid[], ${rows.map((r) => r.n)}::text[]) as x(id, n)`;
    });
  }

  /** Edges for `owner`, ends by name (or an id when the name is unknown). */
  async function addEdges(owner: string, edges: Edge[]): Promise<void> {
    const end = (v: string) => ids.get(v) ?? v;
    await su.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true),
                      set_config('mantle.write_mode', 'rw', true)`;
      await tx`insert into entity_edges
          (owner_id, source_id, source_kind, target_id, target_kind, relation, valid_to)
        select ${owner}::uuid, x.s, x.sk, x.t, x.tk, x.rel,
               case when x.retired = 'y' then now() end
          from unnest(${edges.map((e) => end(e.s))}::uuid[], ${edges.map((e) => e.kinds?.[0] ?? 'entity')}::text[],
                      ${edges.map((e) => end(e.t))}::uuid[], ${edges.map((e) => e.kinds?.[1] ?? 'entity')}::text[],
                      ${edges.map((e) => e.rel)}::text[], ${edges.map((e) => (e.retired ? 'y' : 'n'))}::text[])
            as x(s, sk, t, tk, rel, retired)`;
    });
  }

  const walk = (
    c: Pg,
    o: {
      owner?: string;
      from: string;
      depth?: number | null;
      relations?: string[] | null;
      directed?: boolean;
      currentOnly?: boolean;
      limit?: number | null;
    },
  ) =>
    c<WalkRow[]>`
      select entity_id::text, depth, path_ids::text[], relations
        from mantle_graph_walk(${o.owner ?? ownerA}::uuid, ${o.from}::uuid, ${o.depth ?? 3}::int,
                               ${o.relations ?? null}::text[], ${o.directed ?? false},
                               ${o.currentOnly ?? true}, ${o.limit ?? 200}::int)`;

  const path = (
    c: Pg,
    o: {
      owner?: string;
      from: string;
      to: string | null;
      depth?: number;
      directed?: boolean;
      currentOnly?: boolean;
    },
  ) =>
    c<WalkRow[]>`
      select entity_id::text, depth, path_ids::text[], relations
        from mantle_graph_path(${o.owner ?? ownerA}::uuid, ${o.from}::uuid, ${o.to}::uuid,
                               ${o.depth ?? 3}::int, null::text[], ${o.directed ?? false},
                               ${o.currentOnly ?? true})`;

  /** name -> depth of a walk's rows. */
  const depths = (rows: WalkRow[]) => {
    const byId = new Map([...ids].map(([n, v]) => [v, n]));
    return Object.fromEntries(rows.map((r) => [byId.get(r.entity_id) ?? r.entity_id, r.depth]));
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    s = await import('./entities');
    su = (await import('@mantle/db/test-support')).superuserClient(URL!, 2);
    app = (m.systemDb as unknown as { $client: Pg }).$client;
    await su`insert into auth.users (id, email, password_hash, role) values
      (${ownerA}, ${`${tag}-a@example.invalid`}, 'x', 'member'),
      (${ownerB}, ${`${tag}-b@example.invalid`}, 'x', 'member')`;

    // A cycle a-b-c-a with a tail c-d-e-f-g-h-i (depth clamp), a diamond
    // for the tie-break, a retired shortcut, a node edge, and directions.
    await addEntities(ownerA, [
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
      'p',
      'q1',
      'q2',
      'r',
      'x',
      'y',
      'z',
      'u',
      'v',
      'w',
    ]);
    await addEdges(ownerA, [
      { s: 'a', t: 'b', rel: 'knows' },
      { s: 'b', t: 'c', rel: 'knows' },
      { s: 'c', t: 'a', rel: 'knows' },
      { s: 'c', t: 'd', rel: 'part_of' },
      { s: 'd', t: 'e', rel: 'part_of' },
      { s: 'e', t: 'f', rel: 'part_of' },
      { s: 'f', t: 'g', rel: 'part_of' },
      { s: 'g', t: 'h', rel: 'part_of' },
      { s: 'h', t: 'i', rel: 'part_of' },
      // Diamond: p -> q1 (supplies), p -> q2 (owns); both reach r.
      { s: 'p', t: 'q1', rel: 'supplies' },
      { s: 'p', t: 'q2', rel: 'owns' },
      { s: 'q1', t: 'r', rel: 'knows' },
      { s: 'q2', t: 'r', rel: 'knows' },
      // x -> y -> z, and a retired shortcut x -> z.
      { s: 'x', t: 'y', rel: 'works_at' },
      { s: 'y', t: 'z', rel: 'works_at' },
      { s: 'x', t: 'z', rel: 'works_at', retired: true },
      // u -> v and w -> u: directed from u reaches v only.
      { s: 'u', t: 'v', rel: 'owns' },
      { s: 'w', t: 'u', rel: 'owns' },
      // An entity to node edge from a: never walked.
      { s: 'a', t: randomUUID(), rel: 'mentioned_in', kinds: ['entity', 'node'] },
    ]);
    // Owner B's own edge between owner A's entities (A's walk never uses
    // it), and B's own small graph.
    await addEdges(ownerB, [{ s: 'u', t: 'x', rel: 'owns' }]);
    await addEntities(ownerB, ['bu', 'bx']);
    await addEdges(ownerB, [{ s: 'bu', t: 'bx', rel: 'owns' }]);
  }, 60_000);

  afterAll(async () => {
    if (su) {
      await su`delete from auth.users where id in (${ownerA}, ${ownerB})`;
      await su.end();
    }
    await m?.closeDb();
  });

  it('a cycle does not loop, and each entity comes once', async () => {
    const rows = await walk(app, { from: id('a'), depth: 6 });
    expect(depths(rows)).toEqual({ b: 1, c: 1, d: 2, e: 3, f: 4, g: 5, h: 6 });
    expect(new Set(rows.map((r) => r.entity_id)).size).toBe(rows.length);
    // Nearest first.
    expect(rows.map((r) => r.depth)).toEqual([...rows.map((r) => r.depth)].sort((x, y) => x - y));
  });

  it('skips a retired edge by default and walks it when asked', async () => {
    expect(depths(await walk(app, { from: id('x') }))).toEqual({ y: 1, z: 2 });
    expect(depths(await walk(app, { from: id('x'), currentOnly: false }))).toEqual({ y: 1, z: 1 });
    expect((await path(app, { from: id('x'), to: id('z') }))[0]!.depth).toBe(2);
    expect((await path(app, { from: id('x'), to: id('z'), currentOnly: false }))[0]!.depth).toBe(1);
  });

  it('directed follows subject to object only; undirected walks both ways', async () => {
    expect(depths(await walk(app, { from: id('u'), directed: true }))).toEqual({ v: 1 });
    expect(depths(await walk(app, { from: id('u') }))).toEqual({ v: 1, w: 1 });
    expect(await walk(app, { from: id('v'), directed: true })).toEqual([]);
  });

  it('the relation filter walks only the verbs named; an empty list is every verb', async () => {
    expect(depths(await walk(app, { from: id('a'), depth: 6, relations: ['knows'] }))).toEqual({
      b: 1,
      c: 1,
    });
    expect(depths(await walk(app, { from: id('p'), relations: ['owns', 'knows'] }))).toEqual({
      q2: 1,
      r: 2,
      // r to q1 by knows (undirected); p to q1 is supplies, left out.
      q1: 3,
    });
    expect(depths(await walk(app, { from: id('a'), relations: [] }))).toEqual({
      b: 1,
      c: 1,
      d: 2,
      e: 3,
    });
  });

  it('clamps the depth to 1..6 and the limit to 1..200', async () => {
    expect(depths(await walk(app, { from: id('c'), depth: 0, directed: true }))).toEqual({
      a: 1,
      d: 1,
    });
    const deep = await walk(app, { from: id('a'), depth: 99, directed: true });
    expect(Math.max(...deep.map((r) => r.depth))).toBe(6);
    expect(depths(await walk(app, { from: id('a'), depth: null }))).toEqual({
      b: 1,
      c: 1,
      d: 2,
      e: 3,
    });
    expect(await walk(app, { from: id('a'), depth: 6, limit: 0 })).toHaveLength(1);
    expect(await walk(app, { from: id('a'), depth: 6, limit: 2 })).toHaveLength(2);
    expect(await walk(app, { from: id('a'), depth: 6, limit: null })).toHaveLength(7);

    // A star of 250 leaves: the limit stops at 200, and the default is 50.
    const leaves = Array.from({ length: 250 }, (_, i) => `leaf${i}`);
    await addEntities(ownerA, ['star', ...leaves]);
    await addEdges(
      ownerA,
      leaves.map((l) => ({ s: 'star', t: l, rel: 'has' })),
    );
    expect(await walk(app, { from: id('star'), limit: 1000 })).toHaveLength(200);
    const dflt = await app<{ n: number }[]>`
      select count(*)::int as n from mantle_graph_walk(${ownerA}::uuid, ${id('star')}::uuid)`;
    expect(dflt[0]!.n).toBe(50);
  });

  it('the path is a shortest path, with the stated tie-break', async () => {
    const [r] = await path(app, { from: id('p'), to: id('r') });
    // q1 by supplies and q2 by owns both reach r in two: 'owns' < 'supplies'.
    expect(r).toEqual({
      entity_id: id('r'),
      depth: 2,
      path_ids: [id('p'), id('q2'), id('r')],
      relations: ['owns', 'knows'],
    });
    // The same verb both ways: the smaller entity id wins.
    const [k1, k2] = [randomUUID(), randomUUID()].sort();
    ids.set('k1', k1!);
    ids.set('k2', k2!);
    await addEntities(ownerA, ['k0', 'k3']);
    await su.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`insert into entities (id, owner_id, kind, name) values
        (${k1!}, ${ownerA}, 'org', ${`${tag} k1`}), (${k2!}, ${ownerA}, 'org', ${`${tag} k2`})`;
    });
    await addEdges(ownerA, [
      { s: 'k0', t: 'k2', rel: 'knows' },
      { s: 'k0', t: 'k1', rel: 'knows' },
      { s: 'k2', t: 'k3', rel: 'knows' },
      { s: 'k1', t: 'k3', rel: 'knows' },
    ]);
    const [t] = await path(app, { from: id('k0'), to: id('k3') });
    expect(t!.path_ids).toEqual([id('k0'), k1, id('k3')]);
    // And the walk agrees with the path.
    const viaWalk = (await walk(app, { from: id('k0') })).find((w) => w.entity_id === id('k3'));
    expect(viaWalk).toEqual(t);

    // The long way round a cycle is never kept: a to d is c then d.
    const [ad] = await path(app, { from: id('a'), to: id('d') });
    expect(ad!.path_ids).toEqual([id('a'), id('c'), id('d')]);
    // Out of reach, to itself, or no target: no row.
    expect(await path(app, { from: id('a'), to: id('h'), depth: 3 })).toEqual([]);
    expect((await path(app, { from: id('a'), to: id('h'), depth: 6 }))[0]!.depth).toBe(6);
    // i is seven steps away: past the clamp.
    expect(await path(app, { from: id('a'), to: id('i'), depth: 99 })).toEqual([]);
    expect(await path(app, { from: id('a'), to: id('a') })).toEqual([]);
    expect(await path(app, { from: id('a'), to: null })).toEqual([]);
    expect(await path(app, { from: id('a'), to: id('p') })).toEqual([]);
  });

  /** Entities with chosen ids (to set the id order a test needs). */
  async function addWithIds(owner: string, named: Record<string, string>): Promise<void> {
    for (const [n, v] of Object.entries(named)) ids.set(n, v);
    await su.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true),
                      set_config('mantle.write_mode', 'rw', true)`;
      await tx`insert into entities (id, owner_id, kind, name)
        select x.id, ${owner}::uuid, 'org', ${tag} || ' ' || x.n
          from unnest(${Object.values(named)}::uuid[], ${Object.keys(named)}::text[]) as x(id, n)`;
    });
  }
  /** n uuids, smallest first. */
  const sortedIds = (n: number) => Array.from({ length: n }, () => randomUUID()).sort();

  it('the limit keeps the nearest entities, not the smallest ids', async () => {
    // l2 (two steps away) has a smaller id than l1 (one step away). The old
    // walk kept the first N by id, so limit 1 gave l2.
    const [small, large] = sortedIds(2);
    await addEntities(ownerA, ['l0']);
    await addWithIds(ownerA, { l2: small!, l1: large! });
    await addEdges(ownerA, [
      { s: 'l0', t: 'l1', rel: 'knows' },
      { s: 'l1', t: 'l2', rel: 'knows' },
    ]);
    const one = await walk(app, { from: id('l0'), limit: 1 });
    expect(one.map((r) => [r.entity_id, r.depth])).toEqual([[id('l1'), 1]]);
    const viaTs = await s.graphPath({ ownerId: ownerA, fromId: id('l0'), limit: 1 });
    expect(viaTs.map((r) => r.entity.id)).toEqual([id('l1')]);
    // limit 2 takes the next level too, nearest first.
    expect((await walk(app, { from: id('l0'), limit: 2 })).map((r) => r.entity_id)).toEqual([
      id('l1'),
      id('l2'),
    ]);
  });

  it('the tie-break holds three steps deep (a double diamond)', async () => {
    // 1. The first hop ties on its verb and the ids decide it, though the
    //    other path's second verb is first: s -knows-> m1 (smaller id)
    //    -supplies-> n1 -knows-> t, against s -knows-> m2 -owns-> n2 -knows-> t.
    //    Hops compare from the start, so the path through m1 is kept.
    const [m1, m2] = sortedIds(2);
    await addEntities(ownerA, ['ds', 'dn1', 'dn2', 'dt']);
    await addWithIds(ownerA, { dm1: m1!, dm2: m2! });
    await addEdges(ownerA, [
      { s: 'ds', t: 'dm2', rel: 'knows' },
      { s: 'ds', t: 'dm1', rel: 'knows' },
      { s: 'dm1', t: 'dn1', rel: 'supplies' },
      { s: 'dm2', t: 'dn2', rel: 'owns' },
      { s: 'dn1', t: 'dt', rel: 'knows' },
      { s: 'dn2', t: 'dt', rel: 'knows' },
    ]);
    const [first] = await path(app, { from: id('ds'), to: id('dt') });
    expect(first).toEqual({
      entity_id: id('dt'),
      depth: 3,
      path_ids: [id('ds'), id('dm1'), id('dn1'), id('dt')],
      relations: ['knows', 'supplies', 'knows'],
    });
    const viaWalk = (await walk(app, { from: id('ds') })).find((w) => w.entity_id === id('dt'));
    expect(viaWalk).toEqual(first);

    // 2. The first hop is the same; the paths part at level 2, where the
    //    verb decides against the id order: es -knows-> em, then
    //    em -owns-> eb (larger id) against em -supplies-> ea (smaller id).
    const [ea, eb] = sortedIds(2);
    await addEntities(ownerA, ['es', 'em', 'et']);
    await addWithIds(ownerA, { ea: ea!, eb: eb! });
    await addEdges(ownerA, [
      { s: 'es', t: 'em', rel: 'knows' },
      { s: 'em', t: 'ea', rel: 'supplies' },
      { s: 'em', t: 'eb', rel: 'owns' },
      { s: 'ea', t: 'et', rel: 'knows' },
      { s: 'eb', t: 'et', rel: 'knows' },
    ]);
    const [second] = await path(app, { from: id('es'), to: id('et') });
    expect(second!.path_ids).toEqual([id('es'), id('em'), id('eb'), id('et')]);
    expect(second!.relations).toEqual(['knows', 'owns', 'knows']);
    const viaWalk2 = (await walk(app, { from: id('es') })).find((w) => w.entity_id === id('et'));
    expect(viaWalk2).toEqual(second);
  });

  it("never walks another owner's edges, nor an edge to a node", async () => {
    // Owner B's u -> x is not owner A's.
    expect(depths(await walk(app, { from: id('u') }))).toEqual({ v: 1, w: 1 });
    expect(depths(await walk(app, { owner: ownerB, from: id('u') }))).toEqual({ x: 1 });
    expect(await walk(app, { owner: ownerB, from: id('a') })).toEqual([]);
    expect(await path(app, { from: id('u'), to: id('x') })).toEqual([]);
    // graphPath reads the same way.
    const viaTs = await s.graphPath({ ownerId: ownerB, fromId: id('bu') });
    expect(viaTs.map((r) => [r.entity.id, r.depth])).toEqual([[id('bx'), 1]]);
    expect(await s.graphPath({ ownerId: ownerA, fromId: id('bu') })).toEqual([]);
    expect(await s.graphPath({ ownerId: ownerA, fromId: id('u'), toId: id('x') })).toEqual([]);
    // a's mentioned_in edge to a node is not walked.
    expect((await walk(app, { from: id('a'), depth: 1 })).map((r) => r.entity_id).sort()).toEqual(
      [id('b'), id('c')].sort(),
    );
  });

  it('graphPath normalises the verbs as before: case and stray marks; none left is no filter', async () => {
    const reach = async (relations: string[]) =>
      Object.fromEntries(
        (await s.graphPath({ ownerId: ownerA, fromId: id('p'), relations })).map((r) => [
          r.entity.name.slice(tag.length + 1),
          r.depth,
        ]),
      );
    expect(await reach(['Owns', ' KNOWS!'])).toEqual({ q2: 1, r: 2, q1: 3 });
    expect(await reach(['OWNS'])).toEqual({ q2: 1 });
    // Every verb reduces to nothing: no filter, every verb.
    expect(await reach(['!!', ''])).toEqual({ q1: 1, q2: 1, r: 2 });
    expect(await reach([])).toEqual({ q1: 1, q2: 1, r: 2 });
  });

  it('graphPath keeps its result shape', async () => {
    const out = await s.graphPath({ ownerId: ownerA, fromId: id('p'), toId: id('r') });
    expect(out).toHaveLength(1);
    expect(out[0]!.entity.name).toBe(`${tag} r`);
    expect(out[0]!.depth).toBe(2);
    expect(out[0]!.path).toEqual([
      { name: `${tag} q2`, kind: 'org', relation: 'owns' },
      { name: `${tag} r`, kind: 'org', relation: 'knows' },
    ]);
    const near = await s.graphPath({ ownerId: ownerA, fromId: id('x'), currentOnly: false });
    expect(near.map((r) => r.depth)).toEqual([1, 1]);
    await expect(s.graphPath({ ownerId: ownerA, fromId: 'nope' })).rejects.toThrow(
      'graphPath: fromId is not a uuid',
    );
  });

  it('graphPath clamps depth and limit before Postgres sees them (no 22003 past 2^31)', async () => {
    const reach = async (o: { maxDepth?: number; limit?: number; toId?: string }) =>
      (await s.graphPath({ ownerId: ownerA, fromId: id('a'), ...o })).map((r) => r.depth);
    // Past an int: clamped to 6 steps and 200 rows, not an error.
    expect(await reach({ maxDepth: 3_000_000_000, limit: 3_000_000_000 })).toEqual([
      1, 1, 2, 3, 4, 5, 6,
    ]);
    expect(await reach({ maxDepth: 3_000_000_000, toId: id('h') })).toEqual([6]);
    expect(await reach({ maxDepth: Infinity })).toHaveLength(7);
    expect(await reach({ maxDepth: -3_000_000_000, limit: -3_000_000_000 })).toEqual([1]);
    // Not a number: the default (3 steps, 50 rows).
    expect(await reach({ maxDepth: Number.NaN, limit: Number.NaN })).toEqual([1, 1, 2, 3]);
    expect(await reach({ maxDepth: 'x' as unknown as number })).toEqual([1, 1, 2, 3]);
    expect(await reach({ maxDepth: 2.9 })).toEqual([1, 1, 2]);
  });

  it('both run as their caller, STABLE, with search_path pinned, open to every app role', async () => {
    const rows = await su<{ fn: string; vol: string; definer: boolean; config: string[] }[]>`
      select p.oid::regprocedure::text as fn, p.provolatile::text as vol,
             p.prosecdef as definer, p.proconfig as config
        from pg_proc p
       where p.oid in ('public.mantle_graph_walk(uuid,uuid,integer,text[],boolean,boolean,integer,uuid)'::regprocedure,
                       'public.mantle_graph_path(uuid,uuid,uuid,integer,text[],boolean,boolean)'::regprocedure)
       order by 1`;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.vol, r.fn).toBe('s');
      expect(r.definer, r.fn).toBe(false);
      expect(r.config, r.fn).toHaveLength(1);
      expect(r.config[0], r.fn).toMatch(/^search_path="?public"?, pg_temp$/);
    }
    // Temporary test roles of other files come and go; they are no app roles.
    const roles = await su<{ r: string; ok: boolean }[]>`
      select r.rolname::text as r,
             has_function_privilege(r.oid, 'public.mantle_graph_walk(uuid,uuid,integer,text[],boolean,boolean,integer,uuid)', 'EXECUTE')
             and has_function_privilege(r.oid, 'public.mantle_graph_path(uuid,uuid,uuid,integer,text[],boolean,boolean)', 'EXECUTE') as ok
        from pg_roles r where r.rolname like 'mantle\\_%'
         and r.rolname not like 'mantle\\_test\\_%'`;
    expect(roles.filter((r) => !r.ok)).toEqual([]);
  });

  it("as each app role that reads entity_edges: runs both, and never uses another owner's edges", async () => {
    // Temporary test roles of other files come and go; they are no app roles.
    const roles = (
      await su<{ r: string }[]>`
        select r.rolname::text as r from pg_roles r
         where r.rolname like 'mantle\\_%' and not r.rolsuper
           and r.rolname not like 'mantle\\_test\\_%'
           and has_table_privilege(r.oid, 'public.entity_edges', 'SELECT')
         order by 1`
    ).map((x) => x.r);
    expect(roles).toContain('mantle_runtime');
    expect(roles).toContain('mantle_system_narrow');
    for (const role of roles) {
      const got = await su.begin(async (tx) => {
        await tx`select set_config('role', ${role}, true)`;
        const a = await tx<{ e: string }[]>`
          select entity_id::text as e from mantle_graph_walk(${ownerA}::uuid, ${id('u')}::uuid)`;
        const b = await tx<{ e: string }[]>`
          select entity_id::text as e from mantle_graph_walk(${ownerB}::uuid, ${id('u')}::uuid)`;
        const p = await tx<{ e: string }[]>`
          select entity_id::text as e
            from mantle_graph_path(${ownerA}::uuid, ${id('u')}::uuid, ${id('x')}::uuid)`;
        return { a: a.map((r) => r.e), b: b.map((r) => r.e), p: p.length };
      });
      // Row rules may hide rows from a role with no scope; another owner's
      // edge is never walked, whatever the role sees.
      expect(got.a, role).not.toContain(id('x'));
      for (const e of got.b) expect([id('x')], role).toContain(e);
      expect(got.p, role).toBe(0);
      if (role === 'mantle_runtime' || role === 'mantle_system_narrow') {
        expect(got.a.sort(), role).toEqual([id('v'), id('w')].sort());
        expect(got.b, role).toEqual([id('x')]);
      }
    }
  });

  it('runs inside a READ ONLY transaction, and the transaction refuses a write', async () => {
    const got = await su.begin(async (tx) => {
      await tx`set transaction read only`;
      const w = await tx<WalkRow[]>`
        select entity_id::text, depth from mantle_graph_walk(${ownerA}::uuid, ${id('a')}::uuid, 6)`;
      const p = await tx<WalkRow[]>`
        select depth from mantle_graph_path(${ownerA}::uuid, ${id('a')}::uuid, ${id('h')}::uuid, 6)`;
      const err = await tx
        .savepoint(
          (sp) => sp`insert into entities (owner_id, kind, name)
        values (${ownerA}, 'org', ${`${tag} written`})`,
        )
        .then(
          () => null,
          (e: { code?: string }) => e.code,
        );
      return { w: w.length, p: p[0]?.depth, err };
    });
    expect(got).toEqual({ w: 7, p: 6, err: '25006' });
  });

  it('on a random graph: the same reached set and depths as the old walk, and real paths', async () => {
    const R = rng(20261121);
    const names = Array.from({ length: 90 }, (_, i) => `n${i}`);
    await addEntities(ownerA, names);
    const verbs = ['knows', 'owns', 'supplies'];
    const edges: Edge[] = [];
    for (let i = 0; i < 200; i++) {
      const a = names[Math.floor(R() * names.length)]!;
      const b = names[Math.floor(R() * names.length)]!;
      edges.push({ s: a, t: b, rel: verbs[Math.floor(R() * verbs.length)]!, retired: R() < 0.1 });
    }
    // A self loop and a duplicate edge.
    edges.push(
      { s: 'n0', t: 'n0', rel: 'knows' },
      { s: 'n1', t: 'n2', rel: 'knows' },
      { s: 'n1', t: 'n2', rel: 'knows' },
    );
    await addEdges(ownerA, edges);

    const edgeSet = new Set<string>();
    for (const e of edges) {
      edgeSet.add(`${id(e.s)}>${id(e.t)}>${e.rel}`);
    }
    let compared = 0;
    for (const start of ['n0', 'n1', 'n7', 'n42']) {
      for (const directed of [false, true]) {
        for (const relations of [null, ['owns'], ['knows', 'supplies']]) {
          for (const depth of [1, 2, 3, 4]) {
            const old = (await su
              .unsafe(
                oldWalkSql({
                  owner: ownerA,
                  from: id(start),
                  maxDepth: depth,
                  directed,
                  relations,
                  limit: 200,
                }),
              )
              .simple()) as unknown as { node_id: string; depth: number }[];
            const neu = await walk(app, {
              from: id(start),
              depth,
              directed,
              relations,
              currentOnly: false,
            });
            const want = Object.fromEntries(old.map((r) => [r.node_id, Number(r.depth)]));
            const got = Object.fromEntries(neu.map((r) => [r.entity_id, r.depth]));
            const label = `${start} directed=${directed} rels=${relations} depth=${depth}`;
            expect(got, label).toEqual(want);
            for (const r of neu) {
              expect(r.path_ids[0], label).toBe(id(start));
              expect(r.path_ids.at(-1), label).toBe(r.entity_id);
              expect(r.path_ids.length - 1, label).toBe(r.depth);
              expect(r.relations.length, label).toBe(r.depth);
              for (let i = 0; i < r.depth; i++) {
                const [a, b, v] = [r.path_ids[i]!, r.path_ids[i + 1]!, r.relations[i]!];
                const real =
                  edgeSet.has(`${a}>${b}>${v}`) || (!directed && edgeSet.has(`${b}>${a}>${v}`));
                expect(real, `${label}: ${a} ${v} ${b}`).toBe(true);
                if (relations) expect(relations, label).toContain(v);
              }
            }
            compared += neu.length;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(500);
  }, 120_000);
});
