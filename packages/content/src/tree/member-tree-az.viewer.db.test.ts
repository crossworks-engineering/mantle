/**
 * A member's tree by name (search and the A to Z view, ./member-tree.ts
 * `searchMemberTree`): its own drafts, teammates' shared drafts and the
 * brain's items are ONE list in one order, by name, paged by one keyset
 * cursor. Before, drafts were put first in the order they were last changed
 * (Beta before Alpha) and only the first page carried any, so a member with
 * more drafts than a page never saw the rest.
 *
 * Fixture, on the shared test anchor: a notes folder shared with the team
 * that holds brain notes; member A's drafts and teammate B's shared draft.
 * Reads run as the real roles (inside the module).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/member-tree-az.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TreeSearchResult } from '@mantle/client-types/tree';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('a member’s tree by name: drafts and brain items in one order', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let tree: typeof import('./index');
  let sp: typeof import('../member-space');
  let sqlTag: typeof import('drizzle-orm').sql;
  let brain = '';
  const L = `az${randomUUID().slice(0, 8)}`;
  const a = randomUUID();
  const b = randomUUID();
  const spaceOf: Record<string, string> = {};
  const folderId = randomUUID();
  const keeperId = randomUUID();
  const folderPath = `notes.${L}_team`;
  let scopeA: import('./member-tree').MemberTreeScope;

  const brainNote = (title: string) =>
    m.systemDb.execute(sqlTag`
      insert into nodes (owner_id, type, title, path, audience, data, tags)
      values (${brain}, 'note', ${`${L} ${title}`}, ${folderPath}::ltree, 'admin',
              '{"content":"x"}'::jsonb, '{}')`);
  const draft = async (login: string, title: string) => {
    const S = spaceOf[login]!;
    const row = await m.withSpace({ spaceId: S, loginId: login }, () =>
      sp.createMineItem(S, { type: 'note', title: `${L} ${title}`, content: 'x' }, {}, {}),
    );
    return row.id;
  };
  /** Every page of a by-name read, as the member pages it. */
  const readAll = async (q: string, limit: number) => {
    const pages: TreeSearchResult[] = [];
    let cursor: string | null = null;
    do {
      const p: TreeSearchResult = await tree.searchMemberTree(scopeA, 'notes', q, {
        cursor,
        limit,
      });
      pages.push(p);
      cursor = p.nextCursor;
    } while (cursor && pages.length < 400);
    return pages;
  };
  const ours = (pages: TreeSearchResult[]) =>
    pages
      .flatMap((p) => p.items)
      .filter((i) => i.title.startsWith(`${L} `))
      .map((i) => i.title.slice(L.length + 1));

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tree = await import('./index');
    sp = await import('../member-space');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    brain = await ensureTestAnchor(admin);
    await tree.ensureKindRoot(brain, 'notes');
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${a}, ${`${L}-a@example.invalid`}, 'x', 'member', 'Ann'),
        (${b}, ${`${L}-b@example.invalid`}, 'x', 'member', 'Ben')`);
    const rows = (await m.systemDb.execute(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${a}, ${b})`)) as unknown as { id: string; login_id: string }[];
    for (const r of rows) spaceOf[r.login_id] = r.id;
    scopeA = { anchorId: brain, spaceId: spaceOf[a]!, loginId: a };

    // The folder and a note that keeps it from ever being empty, in one
    // statement: this file runs next to others on the shared anchor, and a
    // folder with nothing in it yet could be taken by another file's cleanup
    // of empty folders (it happened to app-folders.viewer.db.test). The
    // keeper's title ("zz keeper") matches none of the reads below, whether
    // or not a member reads it.
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, slug, path, audience, data, tags, share_level)
      values (${folderId}, ${brain}, 'branch', ${`${L} team`}, ${`${L}_team`},
              ${folderPath}::ltree, 'admin', '{}'::jsonb, '{}', 'team'),
             (${keeperId}, ${brain}, 'note', ${`${L} zz keeper`}, null,
              ${folderPath}::ltree, 'admin', '{"content":"x"}'::jsonb, '{}', null)`);
  }, 60_000);

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${brain}
      and path <@ ${folderPath}::ltree`);
    for (const l of [a, b]) {
      await m.systemDb.execute(sqlTag`delete from nodes where owner_id in
        (select id from spaces where login_id = ${l})`);
      await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${l}`);
      await m.systemDb.execute(sqlTag`delete from auth.users where id = ${l}`);
    }
  }, 60_000);

  it('lists Alpha before Beta whatever the order they were written in, with the brain’s items between', async () => {
    // Written Alpha first, Beta last: by last change Beta came first.
    await draft(a, 'kk alpha');
    await brainNote('kk bravo brain');
    const shared = await draft(b, 'kk charlie from ben');
    await m.systemDb.execute(
      sqlTag`update space_items set sharing = 'team' where node_id = ${shared}`,
    );
    await brainNote('kk delta brain');
    await draft(a, 'kk Beta');

    const expected = [
      'kk alpha',
      'kk Beta',
      'kk bravo brain',
      'kk charlie from ben',
      'kk delta brain',
    ];
    // The search by name, and the A to Z view (an empty search): the same
    // order. A to Z holds every note of the anchor, so only ours are read.
    expect(ours(await readAll(`${L} kk`, 50))).toEqual(expected);
    expect(ours(await readAll('', 100)).filter((t) => t.startsWith('kk '))).toEqual(expected);
    // Each kind of row keeps what it is.
    const [page] = await readAll(`${L} kk`, 50);
    const by = (t: string) => page!.items.find((i) => i.title === `${L} ${t}`);
    expect(by('kk alpha')).toMatchObject({ source: 'own', state: 'private' });
    expect(by('kk charlie from ben')).toMatchObject({ source: 'team', author: 'Ben' });
    expect(by('kk bravo brain')?.source).toBeUndefined();
    expect(by('kk bravo brain')?.crumbs.map((c) => c.id)).toEqual([folderId]);
  });

  it('pages 60 drafts and the brain’s items fully, in order, with no draft lost or repeated', async () => {
    const pad = (n: number) => String(n).padStart(3, '0');
    for (let n = 60; n >= 1; n--) await draft(a, `pg ${pad(n)}`);
    for (const n of [10, 20, 30, 40, 50]) await brainNote(`pg ${pad(n)} brain`);
    const expected: string[] = [];
    for (let n = 1; n <= 60; n++) {
      expected.push(`pg ${pad(n)}`);
      if (n % 10 === 0 && n <= 50) expected.push(`pg ${pad(n)} brain`);
    }

    const pages = await readAll(`${L} pg`, 25);
    // 65 items at 25 a page: three pages, none over the limit, the last
    // with no cursor.
    expect(pages.map((p) => p.items.length)).toEqual([25, 25, 15]);
    expect(pages.at(-1)!.nextCursor).toBeNull();
    const titles = ours(pages);
    expect(titles).toEqual(expected);
    expect(new Set(titles).size).toBe(65);

    // The default page (50) reaches the drafts past the first page too.
    const byDefault = await readAll(`${L} pg`, 50);
    expect(byDefault.map((p) => p.items.length)).toEqual([50, 15]);
    expect(ours(byDefault)).toEqual(expected);
  }, 120_000);

  it('answers the matching folders on the first page only', async () => {
    const pages = await readAll(`${L}`, 25);
    expect(pages[0]!.folders.map((f) => f.id)).toEqual([folderId]);
    expect(pages.slice(1).every((p) => p.folders.length === 0)).toBe(true);
  }, 60_000);
});
