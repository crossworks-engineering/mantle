/**
 * Passage windows (migration 0229) against a real, migrated Postgres: a
 * chunk whose OWN vector is far from the question but one of whose windows
 * is close is found by the window arm, first, with the window's distance;
 * without `windows` the search is the hybrid as before; the windows go with
 * their chunk (FK cascade). Seeds its own rows on the shared anchor, scoped
 * by node id, and removes them after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/search/src/chunk-windows.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('passage windows: the window arm', () => {
  type Db = typeof import('@mantle/db');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  type Search = typeof import('./index');
  let m: Db;
  let s: Search;
  let admin: Admin;
  let anchor = '';
  const tag = `chunkwin${randomUUID().slice(0, 8)}`;
  const axis = (k: number) => Array.from({ length: 768 }, (_, i) => (i === k ? 1 : 0));
  const lit = (v: number[]) => `[${v.join(',')}]`;
  const near = randomUUID(); // chunk vector close to the question
  const deep = randomUUID(); // chunk vector far, one window close
  let deepChunk = '';

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    s = await import('./index');
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    anchor = await ensureTestAnchor(admin);
    // The question is axis 0. `near` sits at 60 degrees from it, `deep` at
    // 90; one window of `deep` sits on the question itself.
    const sixty = Array.from({ length: 768 }, (_, i) => (i === 0 ? 0.5 : i === 1 ? 0.866 : 0));
    for (const [id, v] of [
      [near, sixty],
      [deep, axis(2)],
    ] as const) {
      await admin`insert into nodes (id, owner_id, type, title, path)
        values (${id}, ${anchor}, 'note', ${`${tag} ${id === near ? 'near' : 'deep'}`}, 'notes')`;
      await admin`insert into content_chunks (owner_id, node_id, ordinal, text, embedding)
        values (${anchor}, ${id}, 0, ${`${tag} passage`}, ${lit(v)}::vector)`;
    }
    const [row] = await admin<
      { id: string }[]
    >`select id from content_chunks where node_id = ${deep}`;
    deepChunk = row!.id;
    await admin`insert into content_chunk_windows (chunk_id, j, owner_id, node_id, embedding) values
      (${deepChunk}, 0, ${anchor}, ${deep}, ${lit(axis(3))}::halfvec),
      (${deepChunk}, 1, ${anchor}, ${deep}, ${lit(axis(0))}::halfvec)`;
  });

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from nodes where title like ${`${tag}%`}`;
    await m?.closeDb();
  });

  const search = (windows: boolean) =>
    s.searchChunksExplained({
      ownerId: anchor,
      embedding: axis(0),
      q: 'zzqqxx',
      limit: 10,
      nodeIds: [near, deep],
      windows,
    });

  it('without windows: the chunk vectors decide, as before', async () => {
    const { hits, search: meta } = await search(false);
    expect(hits.map((h) => h.nodeId)).toEqual([near, deep]);
    expect(meta.windowPool).toBeUndefined();
  });

  it('with windows: a close window brings its chunk in, with the window distance', async () => {
    const { hits, search: meta } = await search(true);
    // Hybrid first, then the window arm, by turns: `near` leads the hybrid
    // list, `deep` leads the window list.
    expect(hits.map((h) => h.nodeId)).toEqual([near, deep]);
    const d = hits.find((h) => h.nodeId === deep)!;
    expect(d.distance).toBeLessThan(0.01);
    expect(d.arms.wr).toBe(1);
    expect(meta.windowPool).toBe(1);
  });

  it('the windows go with their chunk', async () => {
    await admin`delete from content_chunks where id = ${deepChunk}`;
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from content_chunk_windows where chunk_id = ${deepChunk}`;
    expect(row?.n).toBe(0);
  });
});
