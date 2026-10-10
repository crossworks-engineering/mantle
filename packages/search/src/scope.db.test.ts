/**
 * Workspaces W3, speed (plan section 3; migration 0249), on a real migrated
 * Postgres:
 *
 *  - chunks and windows hold no access copy: the workspace role reads one
 *    when it reads its node, and a grant change writes no chunk or window
 *    row (their xmin stays);
 *  - a per-login node's chunks reach its login only, through the node;
 *  - the small-scope exact path: a workspace scope that holds few items is
 *    counted on the GIN index (nodes_read_ws_gin, built CONCURRENTLY after
 *    the migrations) and searched exactly; its results equal an exact
 *    search of the scope's rows. Over the threshold the HNSW path still
 *    returns only the scope's rows.
 *  - ensureConcurrentIndexes rebuilds an index left INVALID, and gives up
 *    at its lock limit without leaving an index behind.
 *
 * Seeds its own rows on the shared anchor and removes them after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/search/src/scope.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('W3: chunks follow their node; small scopes search exactly', () => {
  type Db = typeof import('@mantle/db');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  type Search = typeof import('./index');
  let m: Db;
  let s: Search;
  let admin: Admin;
  let sqlTag: typeof import('drizzle-orm').sql;
  let anchor = '';
  const tag = `wsw3${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const login = randomUUID();
  const other = randomUUID();
  const ws = { team: randomUUID(), small: randomUUID(), none: randomUUID() };
  // Six items: four granted to Team, two of those also to Small. Each has two
  // chunks and one window per chunk; every chunk has its own vector, at its
  // own distance from the query, so the order is real.
  const items = Array.from({ length: 6 }, () => randomUUID());
  const inTeam = items.slice(0, 4);
  const inSmall = items.slice(0, 2);
  const vec = (k: number) =>
    Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : i === k + 1 ? 0.3 * k : 0));
  const lit = (v: number[]) => `[${v.join(',')}]`;
  const query = vec(1);

  const scope = (wsIds: string[], loginId: string | null = login) =>
    ({ kind: 'user', loginId, ws: wsIds, modWs: [] }) as const;
  const visibleChunks = (wsIds: string[], loginId: string | null = login) =>
    m.withScope(scope(wsIds, loginId), async () => {
      const rows = (await m.db.execute(sqlTag`
        select c.node_id::text as n, count(*)::int as c
          from content_chunks c where c.owner_id = ${anchor} and c.node_id = any(${`{${items.join(',')}}`}::uuid[])
         group by 1`)) as unknown as Array<{ n: string; c: number }>;
      const wins = (await m.db.execute(sqlTag`
        select count(*)::int as c from content_chunk_windows w
         where w.node_id = any(${`{${items.join(',')}}`}::uuid[])`)) as unknown as Array<{
        c: number;
      }>;
      return {
        nodes: rows.map((r) => r.n).sort(),
        chunks: rows.reduce((a, r) => a + r.c, 0),
        windows: wins[0]!.c,
      };
    });
  const grant = (nodeId: string, wsId: string) =>
    m.withHeads([nodeId], 'update', (tx) =>
      tx.execute(
        sqlTag`insert into item_grants (node_id, workspace_id) values (${nodeId}, ${wsId})`,
      ),
    );
  const ungrant = (nodeId: string, wsId: string) =>
    m.withHeads([nodeId], 'update', (tx) =>
      tx.execute(
        sqlTag`delete from item_grants where node_id = ${nodeId} and workspace_id = ${wsId}`,
      ),
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    s = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    anchor = await ensureTestAnchor(admin);
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${login}, ${`${tag}-a@example.invalid`}, 'x', 'member'),
      (${other}, ${`${tag}-b@example.invalid`}, 'x', 'member')`;
    await admin`insert into workspaces (id, owner_id, name) values
      (${ws.team}, ${anchor}, ${`${tag} team`}), (${ws.small}, ${anchor}, ${`${tag} small`}),
      (${ws.none}, ${anchor}, ${`${tag} none`})`;
    for (const [k, id] of items.entries()) {
      await admin`insert into nodes (id, owner_id, type, title, path, embedding)
        values (${id}, ${anchor}, 'page', ${`${tag} item ${k}`}, 'pages', ${lit(vec(k))}::vector)`;
      for (const ord of [0, 1]) {
        const [c] = await admin<{ id: string }[]>`
          insert into content_chunks (owner_id, node_id, ordinal, text, embedding)
          values (${anchor}, ${id}, ${ord}, ${`${tag} passage ${k} ${ord}`}, ${lit(vec(2 * k + ord))}::vector)
          returning id`;
        await admin`insert into content_chunk_windows (chunk_id, j, owner_id, node_id, embedding)
          values (${c!.id}, 0, ${anchor}, ${id}, ${lit(vec(2 * k + ord))}::halfvec)`;
      }
    }
    for (const id of inTeam) await grant(id, ws.team);
    for (const id of inSmall) await grant(id, ws.small);
  }, 60_000);

  afterEach(() => {
    delete process.env.MANTLE_SCOPE_EXACT_MAX_ROWS;
  });

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from item_grants where node_id = any(${`{${items.join(',')}}`}::uuid[])`;
    await admin`delete from nodes where id = any(${`{${items.join(',')}}`}::uuid[])`;
    await admin`delete from workspaces where id in (${ws.team}, ${ws.small}, ${ws.none})`;
    await admin`delete from spaces where login_id in (${login}, ${other})`;
    await admin`delete from auth.users where id in (${login}, ${other})`;
    await m?.closeDb();
  });

  it('chunks and windows carry no access copy in the schema; the old columns only take defaults', async () => {
    // The drizzle schema no longer lists the copies, so this release never
    // names them; the columns stay one release so the previous code (which
    // names every schema column in an insert) keeps inserting during a roll.
    const { getTableColumns } = await import('drizzle-orm');
    for (const t of [m.contentChunks, m.contentChunkWindows]) {
      const cols = Object.values(getTableColumns(t)).map((c) => c.name);
      expect(cols).not.toContain('read_ws');
      expect(cols).not.toContain('login_id');
    }
    const cols = await admin<{ t: string; c: string; d: string | null }[]>`
      select table_name as t, column_name as c, column_default as d from information_schema.columns
       where table_schema = 'public' and table_name in ('content_chunks', 'content_chunk_windows')
         and column_name in ('read_ws', 'login_id') order by 1, 2`;
    expect(cols.map((r) => `${r.t}.${r.c}`)).toEqual([
      'content_chunk_windows.login_id',
      'content_chunk_windows.read_ws',
      'content_chunks.login_id',
      'content_chunks.read_ws',
    ]);
    // An insert in the previous release's shape (every column named, the
    // copies as DEFAULT) still works, and a grant change never touches them.
    const x = items[4]!;
    const [c] = await admin<{ id: string; r: string; l: string | null }[]>`
      insert into content_chunks (owner_id, node_id, ordinal, text, embedding, read_ws, login_id)
      values (${anchor}, ${x}, 9, ${`${tag} old shape`}, ${lit(vec(20))}::vector, default, default)
      returning id, read_ws::text as r, login_id as l`;
    expect(c).toMatchObject({ r: '{}', l: null });
    await admin`insert into content_chunk_windows (chunk_id, j, owner_id, node_id, embedding, read_ws, login_id)
      values (${c!.id}, 0, ${anchor}, ${x}, ${lit(vec(20))}::halfvec, default, default)`;
    await admin`delete from content_chunks where id = ${c!.id}`;
  });

  it('a scope reads the chunks and windows of the nodes it reads, and no others', async () => {
    expect(await visibleChunks([ws.team])).toEqual({
      nodes: [...inTeam].sort(),
      chunks: 8,
      windows: 8,
    });
    expect(await visibleChunks([ws.small])).toEqual({
      nodes: [...inSmall].sort(),
      chunks: 4,
      windows: 4,
    });
    expect(await visibleChunks([ws.none])).toEqual({ nodes: [], chunks: 0, windows: 0 });
  });

  it('a grant change writes no chunk or window row, and the scope follows it at once', async () => {
    const x = items[5]!;
    const xmin = async () =>
      (
        await admin<{ x: string }[]>`
          select string_agg(xmin::text, ',' order by id) as x from (
            select id, xmin from content_chunks where node_id = ${x}
            union all select chunk_id, xmin from content_chunk_windows where node_id = ${x}) r`
      )[0]!.x;
    const before = await xmin();
    await grant(x, ws.small);
    expect((await visibleChunks([ws.small])).nodes).toContain(x);
    await ungrant(x, ws.small);
    expect((await visibleChunks([ws.small])).nodes).not.toContain(x);
    expect(await xmin()).toBe(before);
  });

  it("a per-login node's chunks reach its login only, through the node", async () => {
    const x = items[3]!; // in Team
    await m.withHeads([x], 'update', (tx) =>
      tx.execute(sqlTag`update nodes set login_id = ${login} where id = ${x}`),
    );
    try {
      expect((await visibleChunks([ws.team], login)).nodes).toContain(x);
      expect((await visibleChunks([ws.team], other)).nodes).not.toContain(x);
    } finally {
      await m.withHeads([x], 'update', (tx) =>
        tx.execute(sqlTag`update nodes set login_id = null where id = ${x}`),
      );
    }
  });

  it('a deleted node takes its chunks and windows with it; nothing is left to read', async () => {
    const gone = randomUUID();
    await admin`insert into nodes (id, owner_id, type, title, path)
      values (${gone}, ${anchor}, 'page', ${`${tag} gone`}, 'pages')`;
    const [c] = await admin<{ id: string }[]>`
      insert into content_chunks (owner_id, node_id, ordinal, text, embedding)
      values (${anchor}, ${gone}, 0, ${`${tag} gone`}, ${lit(query)}::vector) returning id`;
    await admin`insert into content_chunk_windows (chunk_id, j, owner_id, node_id, embedding)
      values (${c!.id}, 0, ${anchor}, ${gone}, ${lit(query)}::halfvec)`;
    await grant(gone, ws.none);
    const count = () =>
      m.withScope(scope([ws.none]), async () => {
        const r = (await m.db.execute(sqlTag`
          select (select count(*) from content_chunks where node_id = ${gone})::int as c,
                 (select count(*) from content_chunk_windows where node_id = ${gone})::int as w`)) as unknown as Array<{
          c: number;
          w: number;
        }>;
        return r[0];
      });
    expect(await count()).toEqual({ c: 1, w: 1 });
    await m.withHeads([gone], 'update', (tx) =>
      tx.execute(sqlTag`delete from nodes where id = ${gone}`),
    );
    expect(await count()).toEqual({ c: 0, w: 0 });
    const [left] = await admin<{ n: number }[]>`
      select (select count(*) from content_chunks where node_id = ${gone})
           + (select count(*) from content_chunk_windows where node_id = ${gone}) as n`;
    expect(Number(left!.n)).toBe(0);
  });

  it('the GIN index on nodes.read_ws is built and valid', async () => {
    const [r] = await admin<{ valid: boolean; def: string }[]>`
      select i.indisvalid as valid, pg_get_indexdef(i.indexrelid) as def
        from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = 'nodes_read_ws_gin'`;
    expect(r?.valid).toBe(true);
    expect(r?.def).toMatch(/USING gin \(read_ws\)/);
  });

  it('a small scope is counted on the index and searched exactly; a big one is not', async () => {
    process.env.MANTLE_SCOPE_EXACT_MAX_ROWS = '3';
    expect(await m.withScope(scope([ws.small]), () => s.smallScope())).toBe(true); // 2 items
    expect(await m.withScope(scope([ws.team]), () => s.smallScope())).toBe(false); // 4 items
    expect(await s.smallScope()).toBe(false); // no workspace scope
    // Rows are counted in the searched table, not guessed from an average:
    // Small holds 2 items but 4 chunks.
    expect(await m.withScope(scope([ws.small]), () => s.smallScope('content_chunks'))).toBe(false);
    process.env.MANTLE_SCOPE_EXACT_MAX_ROWS = '4';
    expect(await m.withScope(scope([ws.small]), () => s.smallScope('content_chunks'))).toBe(true);
    expect(await m.withScope(scope([ws.small]), () => s.smallScope('content_chunk_windows'))).toBe(
      true,
    );
    process.env.MANTLE_SCOPE_EXACT_MAX_ROWS = '0';
    expect(await m.withScope(scope([ws.small]), () => s.smallScope())).toBe(false); // off
  });

  it('the exact path returns what an exact search of the scope returns, in order', async () => {
    const exact = async (wsId: string) =>
      (
        await admin<{ n: string; o: number }[]>`
          select c.node_id::text as n, c.ordinal as o from content_chunks c
            join nodes n on n.id = c.node_id
           where c.node_id = any(${`{${items.join(',')}}`}::uuid[]) and n.read_ws && ${`{${wsId}}`}::uuid[]
           order by c.embedding <=> ${lit(query)}::vector, c.id limit 10`
      ).map((r) => `${r.n}:${r.o}`);
    for (const [wsId, max] of [
      [ws.small, '8000'], // exact path
      [ws.team, '1'], // over the threshold: HNSW with iterative scan
    ] as const) {
      process.env.MANTLE_SCOPE_EXACT_MAX_ROWS = max;
      // The decision is made once per scope and table and cached on the
      // scope, so the search in the same scope took the path read here.
      const { path, hits } = await m.withScope(scope([wsId]), async () => ({
        path: (await s.smallScope('content_chunks')) ? 'exact' : 'hnsw',
        hits: await s.searchChunks({
          ownerId: anchor,
          embedding: query,
          limit: 10,
          nodeIds: items,
        }),
      }));
      expect(path).toBe(wsId === ws.small ? 'exact' : 'hnsw');
      const got = hits.map((h) => `${h.nodeId}:${h.ordinal}`);
      // Every chunk is at its own distance: the order is the exact order.
      expect(got).toEqual(await exact(wsId));
      for (const h of hits) expect(wsId === ws.small ? inSmall : inTeam).toContain(h.nodeId);
    }
    process.env.MANTLE_SCOPE_EXACT_MAX_ROWS = '8000';
    const nodesHit = await m.withScope(scope([ws.small]), () =>
      s.searchNodes({ ownerId: anchor, queryEmbedding: query, ids: items, limit: 10 }),
    );
    expect(nodesHit.map((n) => n.id).sort()).toEqual([...inSmall].sort());
  });

  it('hnswFirst: a failing query surfaces its own error, and the setting is back after', async () => {
    const out = await m.withScope(scope([ws.team]), async () => {
      const err = await s
        .withHnswPool(10, (tx) => tx.execute(sqlTag`select 1 / 0`), { hnswFirst: true })
        .then(
          () => null,
          (e: unknown) => e,
        );
      const r = (await m.db.execute(
        sqlTag`select current_setting('enable_sort') as v`,
      )) as unknown as Array<{ v: string }>;
      return { err, sort: r[0]!.v };
    });
    // division_by_zero, not 25P02 (in_failed_sql_transaction) from a restore.
    const code = (e: unknown): string | undefined =>
      (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
    expect(code(out.err)).toBe('22012');
    expect(out.sort).toBe('on');
  });

  it('keyword search keeps its text index under row security (ts_match_vq LEAKPROOF)', async () => {
    expect(await m.tsMatchLeakproof(admin)).toBe(true);
    expect(await m.ensureTsMatchLeakproof(admin)).toBe('present');
    const plan = await m.withScope(scope([ws.team]), async () => {
      await m.db.execute(sqlTag`select set_config('enable_seqscan', 'off', true)`);
      const rows = (await m.db.execute(sqlTag`
        explain select c.id from content_chunks c
         where c.search_tsv @@ to_tsquery('english', 'passage')`)) as unknown as Array<
        Record<string, string>
      >;
      return rows.map((r) => Object.values(r)[0]).join('\n');
    });
    expect(plan).toMatch(/content_chunks_tsv_idx/);
  });

  it('ensureConcurrentIndexes builds a missing index and rebuilds an INVALID one', async () => {
    const t = `${tag}_cix`;
    await admin.unsafe(`create table public.${t} (a int)`);
    try {
      const list = [
        {
          name: `${t}_a`,
          create: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${t}_a" ON public.${t} (a)`,
        },
      ];
      expect(await m.ensureConcurrentIndexes(admin, list)).toEqual({ [`${t}_a`]: 'built' });
      expect(await m.ensureConcurrentIndexes(admin, list)).toEqual({ [`${t}_a`]: 'present' });
      await admin.unsafe(
        `update pg_index set indisvalid = false where indexrelid = '"${t}_a"'::regclass`,
      );
      expect(await m.ensureConcurrentIndexes(admin, list)).toEqual({ [`${t}_a`]: 'rebuilt' });
      const [r] = await admin<{ v: boolean }[]>`
        select indisvalid as v from pg_index where indexrelid = ${`"${t}_a"`}::regclass`;
      expect(r!.v).toBe(true);
      // A build that waits on a lock gives up at the lock limit, reports it,
      // and leaves no index behind (the runner warns and boots on).
      await admin.unsafe(`drop index "${t}_a"`);
      const holder = await admin.reserve();
      try {
        await holder`begin`;
        await holder.unsafe(`lock table public.${t} in access exclusive mode`);
        const errs: string[] = [];
        const t0 = Date.now();
        expect(
          await m.ensureConcurrentIndexes(admin, list, {
            lockTimeoutMs: 200,
            onError: (name) => errs.push(name),
          }),
        ).toEqual({ [`${t}_a`]: 'failed' });
        expect(errs).toEqual([`${t}_a`]);
        expect(Date.now() - t0).toBeLessThan(10_000);
        await holder`rollback`;
      } finally {
        holder.release();
      }
      const [gone] = await admin<{ n: number }[]>`
        select count(*)::int as n from pg_class where relname = ${`${t}_a`}`;
      expect(gone!.n).toBe(0);
      // Without onError the failure is thrown.
      const holder2 = await admin.reserve();
      try {
        await holder2`begin`;
        await holder2.unsafe(`lock table public.${t} in access exclusive mode`);
        await expect(
          m.ensureConcurrentIndexes(admin, list, { lockTimeoutMs: 200 }),
        ).rejects.toThrow();
        await holder2`rollback`;
      } finally {
        holder2.release();
      }
    } finally {
      await admin.unsafe(`drop table if exists public.${t}`);
    }
  });
});
