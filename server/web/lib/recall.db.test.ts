/**
 * The owner API's map summaries carry the map's folder, against a real,
 * migrated Postgres. `folder` was always null on GET /api/recall/maps and
 * GET /api/recall/maps/:id, because the summary was never given the crumbs;
 * the owner catalog and the agent catalog (recall_index) disagreed about
 * where every filed map lived. Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/recall.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('Recall owner API: map folders, on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let lib: typeof import('./recall');
  let sqlTag: typeof import('drizzle-orm').sql;

  const owner = randomUUID();
  const tag = `recall-lib-${owner.slice(0, 8)}`;
  const OWNER = { kind: 'owner' as const, id: owner, name: 'Owner' };
  const v1Id = randomUUID();
  let filed: { mapId: string };
  let unsorted: { mapId: string };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    ({ sql: sqlTag } = await import('drizzle-orm'));
    lib = await import('./recall');
    const content = await import('@mantle/content');
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await content.ensureRecallRoot(owner);
    // Two nested folders. The crumbs are their TITLES, not their labels.
    await m.db.execute(sqlTag`
      insert into nodes (owner_id, type, title, slug, path)
      values (${owner}, 'branch', 'Mantle', 'mantle', 'recall.mantle'),
             (${owner}, 'branch', 'Fleet boxes', 'fleet', 'recall.mantle.fleet')`);
    filed = await content.createRecallMap(
      owner,
      { title: 'Filed map', enterWhen: 'Working on the fleet', folder: 'Mantle / Fleet boxes' },
      OWNER,
    );
    unsorted = await content.createRecallMap(
      owner,
      { title: 'Unsorted map', enterWhen: 'Anything else' },
      OWNER,
    );
    // A leftover page-built (v1) row: no item. Retired in R5, never served.
    await m.db.execute(sqlTag`
      insert into recall_maps (id, owner_id, slug, title, node_count)
      values (${v1Id}, ${owner}, ${`v1-${tag}`}, 'Page built', 1)`);
  });

  afterAll(async () => {
    if (!URL) return;
    await m.db.execute(sqlTag`delete from recall_revisions where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from recall_nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from recall_maps where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
  });

  it('the catalog names each map’s folder, and null where there is none', async () => {
    const maps = await lib.listRecallMaps(owner);
    const folderOf = new Map(maps.map((x) => [x.id, x.folder]));
    expect(folderOf.get(filed.mapId)).toBe('Mantle / Fleet boxes');
    expect(folderOf.get(unsorted.mapId)).toBeNull();
  });

  it('never lists or opens a leftover page-built row', async () => {
    const maps = await lib.listRecallMaps(owner);
    expect(maps.map((x) => x.id)).not.toContain(v1Id);
    expect(await lib.countRecallMaps(owner)).toBe(maps.length);
    expect(await lib.getRecallMapDetail(owner, v1Id)).toBeNull();
  });

  it('the map detail carries the same folder', async () => {
    expect((await lib.getRecallMapDetail(owner, filed.mapId))!.folder).toBe('Mantle / Fleet boxes');
    expect((await lib.getRecallMapDetail(owner, unsorted.mapId))!.folder).toBeNull();
  });
});
