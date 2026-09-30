/**
 * Migration 0210 (folder phase 7, pages in folders) on a real Postgres: every
 * page that had child pages becomes a page next to a folder of its name, the
 * children move into that folder, nothing nests past three folders, no page
 * keeps a page as its parent, stray `pages.<id>` paths land at a folder, and
 * a second run writes nothing. The SQL slug helper the migration uses is
 * pinned to the TypeScript one (folderSlugOf).
 *
 * Runs on a scratch database of its own (migrated from scratch, dropped
 * after): the migration walks EVERY owner's pages, and other test files seed
 * nested pages of their own on the shared database.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/pages-in-folders.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dashToLtree, folderSlugOf } from '@mantle/files';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const MIGRATIONS = join(__dirname, '..', '..', '..', 'db', 'migrations');

const statementsOf = (file: string) =>
  readFileSync(join(MIGRATIONS, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);

type PageRow = { id: string; path: string; parent_id: string | null };
type FolderRow = { id: string; path: string; title: string; slug: string; owner_id: string };

describe.skipIf(!URL)('migration 0210: pages in folders', () => {
  type Ts = typeof import('@mantle/db/test-support');
  type Db = typeof import('@mantle/db');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  /** One query on the scratch database, as rows. */
  const sql = async <T>(q: ReturnType<typeof import('drizzle-orm').sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const brain = randomUUID();
  const space = randomUUID();
  const member = randomUUID();
  const tag = `pages-folders-${brain.slice(0, 8)}`;
  const id = {
    a: randomUUID(),
    b: randomUUID(),
    c: randomUUID(),
    d: randomUUID(),
    e: randomUUID(),
    f: randomUUID(),
    plan1: randomUUID(),
    plan1Kid: randomUUID(),
    plan2: randomUUID(),
    plan2Kid: randomUUID(),
    cyr: randomUUID(),
    cyrKid: randomUUID(),
    stray: randomUUID(),
    flat: randomUUID(),
    mine: randomUUID(),
    mineKid: randomUUID(),
  };
  const label = (uuid: string) => uuid.replace(/-/g, '_');

  const run = async () => {
    for (const stmt of statementsOf('0210_pages_in_folders.sql')) {
      await m.systemDb.execute(sqlTag.raw(stmt));
    }
  };
  const pageOf = async (pageId: string) =>
    (
      await sql<PageRow>(
        sqlTag`select id, path::text as path, parent_id from nodes where id = ${pageId}`,
      )
    )[0]!;
  const folders = async (owner: string) =>
    sql<FolderRow>(sqlTag`
      select id, path::text as path, title, slug, owner_id from nodes
       where owner_id = ${owner} and type = 'branch' and path <@ 'pages'::ltree
       order by path`);
  const snapshot = async () =>
    sql<{ id: string; path: string; parent_id: string | null; type: string }>(sqlTag`
      select id, path::text as path, parent_id, type::text as type from nodes
       where owner_id in (${brain}, ${space}) order by id`);

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    const x = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
    await x(sqlTag`insert into auth.users (id, email, password_hash, is_owner, role)
              values (${brain}, ${`${tag}@example.invalid`}, 'x', true, 'admin')`);
    await x(sqlTag`insert into auth.users (id, email, password_hash, role)
              values (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member')`);
    // The owner login's brain space is made by a trigger on auth.users: keep it.
    await x(sqlTag`insert into spaces (id, kind, login_id) values (${brain}, 'brain', ${brain})
                   on conflict (id) do nothing`);
    await x(sqlTag`insert into spaces (id, kind, login_id) values (${space}, 'personal', ${member})
                   on conflict (id) do nothing`);

    // The old shape (no root row for the brain yet, as an old brain may
    // have): A > B > D > E > F (E's folder would be a fourth level), A > C,
    // two parents named "Plan", a Cyrillic parent, a stray id-label path
    // without a parent, a flat page, and a member's draft with a child.
    const page = (pid: string, title: string, path: string, parent: string | null, owner = brain) =>
      x(sqlTag`insert into nodes (id, owner_id, type, title, path, parent_id)
          values (${pid}, ${owner}, 'page', ${title}, ${path}::ltree, ${parent})`);
    await page(id.a, 'Alpha', 'pages', null);
    await page(id.b, 'Beta', `pages.${label(id.b)}`, id.a);
    await page(id.c, 'Gamma', `pages.${label(id.c)}`, id.a);
    await page(id.d, 'Delta', `pages.${label(id.b)}.${label(id.d)}`, id.b);
    await page(id.e, 'Epsilon', `pages.${label(id.b)}.${label(id.d)}.${label(id.e)}`, id.d);
    await page(
      id.f,
      'Zeta',
      `pages.${label(id.b)}.${label(id.d)}.${label(id.e)}.${label(id.f)}`,
      id.e,
    );
    await page(id.plan1, 'Plan', 'pages', null);
    await page(id.plan1Kid, 'Plan kid 1', `pages.${label(id.plan1Kid)}`, id.plan1);
    await page(id.plan2, 'plan!', 'pages', null);
    await page(id.plan2Kid, 'Plan kid 2', `pages.${label(id.plan2Kid)}`, id.plan2);
    await page(id.cyr, 'Планы', 'pages', null);
    await page(id.cyrKid, 'Кид', `pages.${label(id.cyrKid)}`, id.cyr);
    await page(id.stray, 'Stray', `pages.${label(randomUUID())}`, null);
    await page(id.flat, 'Flat', 'pages', null);
    await page(id.mine, 'Mine', 'pages', null, space);
    await page(id.mineKid, 'Mine kid', `pages.${label(id.mineKid)}`, id.mine, space);
    for (const pid of Object.values(id)) {
      await x(sqlTag`insert into pages (node_id, doc, doc_text)
                values (${pid}, '{"type":"doc","content":[]}'::jsonb, '')`);
    }
    await run();
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('pins the SQL slug to folderSlugOf', async () => {
    for (const name of [
      'Acme Corp',
      'Résumé 2026',
      '  spaced   out  ',
      'Планы',
      '---',
      'x'.repeat(80),
      'plan!',
      'Mixed CASE and_underscores',
    ]) {
      const [row] = await sql<{ l: string | null }>(
        sqlTag`select mantle_folder_label(${name}) as l`,
      );
      const expected = folderSlugOf(name);
      expect(row!.l, name).toBe(expected === null ? null : dashToLtree(expected));
    }
    const [blank] = await sql<{ l: string | null }>(sqlTag`select mantle_folder_label('   ') as l`);
    expect(blank!.l).toBeNull();
  });

  it('makes the brain its pages root, and none for the member space', async () => {
    const roots = await sql<{ owner_id: string }>(sqlTag`
      select owner_id from nodes where type = 'branch' and path = 'pages'::ltree
         and owner_id in (${brain}, ${space})`);
    expect(roots.map((r) => r.owner_id)).toEqual([brain]);
  });

  it('a parent page becomes a page next to a folder of its name; its children move in', async () => {
    const a = await pageOf(id.a);
    expect(a.path).toBe('pages.alpha');
    const [alpha] = await sql<FolderRow>(sqlTag`
      select id, path::text as path, title, slug, owner_id from nodes
       where owner_id = ${brain} and type = 'branch' and path = 'pages.alpha'::ltree`);
    expect(alpha).toMatchObject({ title: 'Alpha', slug: 'alpha' });
    expect((await pageOf(id.c)).path).toBe('pages.alpha');
    expect((await pageOf(id.b)).path).toBe('pages.alpha.beta');
    expect((await pageOf(id.d)).path).toBe('pages.alpha.beta.delta');
  });

  it('never nests past three folders: a fourth level flattens in next to its parent', async () => {
    expect((await pageOf(id.e)).path).toBe('pages.alpha.beta.delta');
    expect((await pageOf(id.f)).path).toBe('pages.alpha.beta.delta');
    const deep = await sql<{ n: number }>(sqlTag`
      select count(*)::int as n from nodes
       where owner_id = ${brain} and type = 'branch' and nlevel(path) > 4`);
    expect(deep[0]!.n).toBe(0);
  });

  it('two parents with the same slug get distinct folders', async () => {
    expect((await pageOf(id.plan1)).path).toBe('pages.plan');
    expect((await pageOf(id.plan1Kid)).path).toBe('pages.plan');
    expect((await pageOf(id.plan2)).path).toBe('pages.plan_2');
    expect((await pageOf(id.plan2Kid)).path).toBe('pages.plan_2');
    const plans = (await folders(brain)).filter((f) => f.path.startsWith('pages.plan'));
    expect(plans.map((f) => [f.path, f.title, f.slug])).toEqual([
      ['pages.plan', 'Plan', 'plan'],
      ['pages.plan_2', 'plan!', 'plan-2'],
    ]);
  });

  it('a title with no Latin letter gets the hashed slug and keeps its name', async () => {
    const cyr = await pageOf(id.cyr);
    expect(cyr.path).toMatch(/^pages\.f_[0-9a-f]{10}$/);
    expect(cyr.path).toBe(`pages.${dashToLtree(folderSlugOf('Планы')!)}`);
    expect((await pageOf(id.cyrKid)).path).toBe(cyr.path);
    const [f] = await sql<FolderRow>(sqlTag`
      select id, path::text as path, title, slug, owner_id from nodes
       where owner_id = ${brain} and type = 'branch' and path = ${cyr.path}::ltree`);
    expect(f!.title).toBe('Планы');
  });

  it('no page keeps a page as its parent; a stray path lands at the root; a flat page stays', async () => {
    const parented = await sql<{ n: number }>(sqlTag`
      select count(*)::int as n from nodes c
       where c.type = 'page' and c.owner_id in (${brain}, ${space})
         and exists (select 1 from nodes q where q.id = c.parent_id and q.type = 'page')`);
    expect(parented[0]!.n).toBe(0);
    expect((await pageOf(id.stray)).path).toBe('pages');
    expect((await pageOf(id.flat)).path).toBe('pages');
    // Every page sits at a folder row of its owner (or the brain's), or the root.
    const homeless = await sql<{ id: string }>(sqlTag`
      select p.id from nodes p
       where p.type = 'page' and p.owner_id in (${brain}, ${space}) and p.path <> 'pages'::ltree
         and not exists (select 1 from nodes b where b.type = 'branch' and b.path = p.path
                           and b.owner_id in (p.owner_id, ${brain}))`);
    expect(homeless).toEqual([]);
  });

  it("a member's nested draft becomes the member's own folder", async () => {
    expect((await pageOf(id.mine)).path).toBe('pages.mine');
    expect((await pageOf(id.mineKid)).path).toBe('pages.mine');
    const own = await folders(space);
    expect(own.map((f) => [f.path, f.title])).toEqual([['pages.mine', 'Mine']]);
  });

  it('keeps every page: same ids, same documents', async () => {
    const [n] = await sql<{ n: number }>(sqlTag`
      select count(*)::int as n from nodes p join pages d on d.node_id = p.id
       where p.owner_id in (${brain}, ${space}) and p.type = 'page'`);
    expect(n!.n).toBe(Object.keys(id).length);
  });

  it('a second run writes nothing', async () => {
    const before = await snapshot();
    await run();
    expect(await snapshot()).toEqual(before);
  });
});
