/**
 * Migration 0210 (folder phase 7, pages in folders) on a real Postgres: every
 * page that had child pages stays where it is and gets a folder of its name
 * next to it, the children move into that folder, nothing nests past three
 * folders, no page keeps a page as its parent, stray `pages.<id>` paths land
 * at a folder, the old "share sub-pages" links are revoked, everything else
 * on the rows survives, and a second run writes nothing. The SQL slug helper
 * the migration uses is pinned to the TypeScript one (folderSlugOf).
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
type Snap = {
  id: string;
  type: string;
  path: string;
  parent_id: string | null;
  title: string;
  slug: string | null;
  data: unknown;
  tags: string[];
  audience: string;
  share_level: string | null;
  inherited_level: string | null;
  embedded_level: string | null;
};

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
  const member = randomUUID();
  /** The member's personal space, made by the login trigger; read in setup. */
  let space = '';
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
    shared: randomUUID(),
    casc: randomUUID(),
    cascKid: randomUUID(),
  };
  const sharedFolder = randomUUID();
  const image = randomUUID();
  const links = { casc: randomUUID(), cascKid: randomUUID(), flat: randomUUID() };
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
    sql<Snap>(sqlTag`
      select id, type::text as type, path::text as path, parent_id, title, slug, data, tags,
             audience, share_level, inherited_level, embedded_level
        from nodes where owner_id in (${brain}, ${space}) order by id`);
  const link = async (linkId: string) =>
    (
      await sql<{ revoked: boolean; settings: Record<string, unknown> }>(sqlTag`
        select revoked_at is not null as revoked, settings from shares where id = ${linkId}`)
    )[0]!;

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
    // Spaces are made by the login trigger on auth.users: the owner's brain
    // space (its id is the login's) and the member's personal space.
    await x(sqlTag`insert into spaces (id, kind, login_id) values (${brain}, 'brain', ${brain})
                   on conflict (id) do nothing`);
    const [personal] = await sql<{ id: string }>(
      sqlTag`select id from spaces where login_id = ${member} and kind = 'personal'`,
    );
    if (!personal) throw new Error('the member login has no personal space');
    space = personal.id;

    // The old shape (no root row for the brain yet, as an old brain may
    // have): A > B > D > E > F (E's folder would be a fourth level), A > C,
    // two parents named "Plan", a Cyrillic parent, a stray id-label path
    // without a parent, a flat page with its own link, a member's draft with
    // a child, a page in a client-shared folder embedding an image, and a
    // parent whose link shares its sub-page (the retired cascade).
    const page = (
      pid: string,
      title: string,
      path: string,
      parent: string | null,
      owner: string = brain,
      extra: { tags?: string[]; audience?: string } = {},
    ) =>
      x(sqlTag`insert into nodes (id, owner_id, type, title, path, parent_id, tags, audience)
          values (${pid}, ${owner}, 'page', ${title}, ${path}::ltree, ${parent},
                  ${JSON.stringify(extra.tags ?? [])
                    .replace(/^\[/, '{')
                    .replace(/\]$/, '}')}::text[],
                  ${extra.audience ?? 'admin'})`);
    await page(id.a, 'Alpha', 'pages', null, brain, { tags: ['plans', 'q3'] });
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
    await page(id.flat, 'Flat', 'pages', null, brain, { audience: 'public' });
    await page(id.mine, 'Mine', 'pages', null, space);
    await page(id.mineKid, 'Mine kid', `pages.${label(id.mineKid)}`, id.mine, space);
    // A client-shared folder holding a page that embeds an image (0208).
    await x(sqlTag`insert into nodes (id, owner_id, type, title, slug, path, share_level)
              values (${sharedFolder}, ${brain}, 'branch', 'Shared', 'shared', 'pages.shared'::ltree, 'client')`);
    await x(sqlTag`insert into nodes (id, owner_id, type, title, path)
              values (${image}, ${brain}, 'file', 'pic.png', 'files'::ltree)`);
    await page(id.shared, 'In shared', 'pages.shared', null);
    // The retired cascade: a public parent whose link shares its sub-page,
    // and the sub-page's own live link.
    await page(id.casc, 'Cascading parent', 'pages', null, brain, { audience: 'public' });
    await page(id.cascKid, 'Cascaded kid', `pages.${label(id.cascKid)}`, id.casc, brain, {
      audience: 'public',
    });
    for (const pid of Object.values(id)) {
      const doc =
        pid === id.shared
          ? { type: 'doc', content: [{ type: 'image', attrs: { nodeId: image, src: 'x' } }] }
          : { type: 'doc', content: [] };
      await x(sqlTag`insert into pages (node_id, doc, doc_text)
                values (${pid}, ${JSON.stringify(doc)}::jsonb, '')`);
    }
    await x(sqlTag`insert into shares (id, owner_id, node_id, node_type, token, settings) values
      (${links.casc}, ${brain}, ${id.casc}, 'page', ${`t-${links.casc}`}, '{"cascade": true}'::jsonb),
      (${links.cascKid}, ${brain}, ${id.cascKid}, 'page', ${`t-${links.cascKid}`}, '{}'::jsonb),
      (${links.flat}, ${brain}, ${id.flat}, 'page', ${`t-${links.flat}`}, '{"cascade": false}'::jsonb)`);
    // The 0208 triggers made the edge and the image's embedded level.
    const [edge] = await sql<{ n: number }>(sqlTag`
      select count(*)::int as n from node_embeds where from_id = ${id.shared} and to_id = ${image}`);
    if (edge!.n !== 1) throw new Error('setup: the embed edge was not made');
    await run();
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  }, 120_000);

  it('pins the SQL slug to folderSlugOf, step for step', async () => {
    for (const name of [
      'Acme Corp',
      'Résumé 2026',
      'ÉCOLE',
      '  spaced   out  ',
      '--plan--',
      'Планы',
      '---',
      'x'.repeat(80),
      `${'a'.repeat(63)} b`,
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

  it('makes the brain its pages root (as pages/tree.ts does), and none for the member space', async () => {
    const roots = await sql<{ owner_id: string; data: Record<string, unknown> }>(sqlTag`
      select owner_id, data from nodes where type = 'branch' and path = 'pages'::ltree
         and owner_id in (${brain}, ${space})`);
    expect(roots.map((r) => r.owner_id)).toEqual([brain]);
    expect(typeof roots[0]!.data.description).toBe('string');
  });

  it('a parent page stays where it is, next to a folder of its name; its children move in', async () => {
    expect((await pageOf(id.a)).path).toBe('pages');
    const [alpha] = await sql<FolderRow>(sqlTag`
      select id, path::text as path, title, slug, owner_id from nodes
       where owner_id = ${brain} and type = 'branch' and path = 'pages.alpha'::ltree`);
    expect(alpha).toMatchObject({ title: 'Alpha', slug: 'alpha' });
    expect((await pageOf(id.c)).path).toBe('pages.alpha');
    expect((await pageOf(id.b)).path).toBe('pages.alpha');
    expect((await pageOf(id.d)).path).toBe('pages.alpha.beta');
    // No page sits inside its own folder: the index page shape is gone.
    const alphaHolds = await sql<{ n: number }>(sqlTag`
      select count(*)::int as n from nodes where id = ${id.a} and path = 'pages.alpha'::ltree`);
    expect(alphaHolds[0]!.n).toBe(0);
  });

  it('never nests past three folders: a fourth level lands next to its parent', async () => {
    expect((await pageOf(id.e)).path).toBe('pages.alpha.beta.delta');
    expect((await pageOf(id.f)).path).toBe('pages.alpha.beta.delta');
    const deep = await sql<{ n: number }>(sqlTag`
      select count(*)::int as n from nodes
       where owner_id = ${brain} and type = 'branch' and nlevel(path) > 4`);
    expect(deep[0]!.n).toBe(0);
  });

  it('two parents with the same slug get distinct folders', async () => {
    // Which of the two gets the plain slug follows the title order of the
    // database's collation ("Plan" against "plan!"), so only the pairing is
    // pinned: each parent stays at the top, its child in its own folder,
    // and the folders are `plan` and `plan-2`, each named after its page.
    expect((await pageOf(id.plan1)).path).toBe('pages');
    expect((await pageOf(id.plan2)).path).toBe('pages');
    const one = (await pageOf(id.plan1Kid)).path;
    const two = (await pageOf(id.plan2Kid)).path;
    expect([one, two].sort()).toEqual(['pages.plan', 'pages.plan_2']);
    const plans = (await folders(brain)).filter((f) => f.path.startsWith('pages.plan'));
    expect(plans.map((f) => [f.path, f.slug]).sort()).toEqual([
      ['pages.plan', 'plan'],
      ['pages.plan_2', 'plan-2'],
    ]);
    expect(plans.find((f) => f.path === one)?.title).toBe('Plan');
    expect(plans.find((f) => f.path === two)?.title).toBe('plan!');
  });

  it('a title with no Latin letter gets the hashed slug and keeps its name', async () => {
    expect((await pageOf(id.cyr)).path).toBe('pages');
    const kid = await pageOf(id.cyrKid);
    expect(kid.path).toMatch(/^pages\.f_[0-9a-f]{10}$/);
    expect(kid.path).toBe(`pages.${dashToLtree(folderSlugOf('Планы')!)}`);
    const [f] = await sql<FolderRow>(sqlTag`
      select id, path::text as path, title, slug, owner_id from nodes
       where owner_id = ${brain} and type = 'branch' and path = ${kid.path}::ltree`);
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

  it("a member's nested draft stays put; its child goes into the member's own folder", async () => {
    expect((await pageOf(id.mine)).path).toBe('pages');
    expect((await pageOf(id.mineKid)).path).toBe('pages.mine');
    const own = await folders(space);
    expect(own.map((f) => [f.path, f.title])).toEqual([['pages.mine', 'Mine']]);
  });

  it('keeps tags, levels, the shared folder, its inherited share and the embed edge', async () => {
    const [a] = await sql<Snap>(sqlTag`select tags, audience from nodes where id = ${id.a}`);
    expect(a).toMatchObject({ tags: ['plans', 'q3'], audience: 'admin' });
    const [shared] = await sql<Snap>(sqlTag`
      select path::text as path, share_level, inherited_level from nodes where id = ${sharedFolder}`);
    expect(shared).toMatchObject({ path: 'pages.shared', share_level: 'client' });
    const [inShared] = await sql<Snap>(sqlTag`
      select path::text as path, inherited_level from nodes where id = ${id.shared}`);
    expect(inShared).toMatchObject({ path: 'pages.shared', inherited_level: 'client' });
    const [pic] = await sql<Snap>(sqlTag`select embedded_level from nodes where id = ${image}`);
    expect(pic!.embedded_level).toBe('client');
    const [edge] = await sql<{ n: number }>(sqlTag`
      select count(*)::int as n from node_embeds where from_id = ${id.shared} and to_id = ${image}`);
    expect(edge!.n).toBe(1);
    // The flat page's own link is untouched; its stale cascade flag is gone.
    expect(await link(links.flat)).toMatchObject({ revoked: false, settings: {} });
  });

  it('revokes the links a "share sub-pages" parent opened for its children, and puts them back to admin', async () => {
    expect(await link(links.cascKid)).toMatchObject({
      revoked: true,
      settings: { retired: 'cascade' },
    });
    const [kid] = await sql<Snap>(sqlTag`select audience from nodes where id = ${id.cascKid}`);
    expect(kid!.audience).toBe('admin');
    // The parent keeps its own link, without the flag; its page stays public.
    expect(await link(links.casc)).toMatchObject({ revoked: false, settings: {} });
    const [parent] = await sql<Snap>(sqlTag`select audience from nodes where id = ${id.casc}`);
    expect(parent!.audience).toBe('public');
  });

  it('keeps every page: same ids, same documents', async () => {
    const [n] = await sql<{ n: number }>(sqlTag`
      select count(*)::int as n from nodes p join pages d on d.node_id = p.id
       where p.owner_id in (${brain}, ${space}) and p.type = 'page'`);
    expect(n!.n).toBe(Object.keys(id).length);
    const [doc] = await sql<{ doc: unknown }>(
      sqlTag`select doc from pages where node_id = ${id.shared}`,
    );
    expect(doc!.doc).toEqual({
      type: 'doc',
      content: [{ type: 'image', attrs: { nodeId: image, src: 'x' } }],
    });
  });

  it('a second run writes nothing', async () => {
    const before = await snapshot();
    const linksBefore = await sql<unknown>(sqlTag`
      select id, revoked_at, settings from shares where owner_id = ${brain} order by id`);
    await run();
    expect(await snapshot()).toEqual(before);
    expect(
      await sql<unknown>(sqlTag`
        select id, revoked_at, settings from shares where owner_id = ${brain} order by id`),
    ).toEqual(linksBefore);
  });
});
