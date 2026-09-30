/**
 * A member's tree (folder plan phase 5): the brain's items the member reads,
 * its own folders and drafts, and teammates' shared drafts, merged per path;
 * and the member's writes (its own folders, filing its own drafts). Reads run
 * as the real roles (withSpace, withTeamDrafts, withViewer inside the module).
 *
 * Fixture, under folders of this run's own on the shared test anchor:
 *   notes.<L>_team    shared with the team, holds an admin note
 *   notes.<L>_hidden  not shared, holds an admin note; the member's draft or
 *                     own folder there never reveals it (audit S4)
 *   notes.<L>_closed  not shared, holds only an admin note: never shows
 * Member A browses; member B is the teammate.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/member-tree.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('a member’s tree: own folders, drafts in place, teammates’ drafts', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let tree: typeof import('./index');
  let sp: typeof import('../member-space');
  let sqlTag: typeof import('drizzle-orm').sql;
  let brain = '';
  const L = `mt${randomUUID().slice(0, 8)}`;
  const a = randomUUID();
  const b = randomUUID();
  const spaceOf: Record<string, string> = {};
  const ids = {
    teamF: randomUUID(),
    hiddenF: randomUUID(),
    closedF: randomUUID(),
    inTeam: randomUUID(),
    inHidden: randomUUID(),
    inClosed: randomUUID(),
  };
  let scopeA: import('./member-tree').MemberTreeScope;

  const brainRow = (id: string, type: string, path: string) =>
    m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, slug, path, audience, data, tags)
      values (${id}, ${brain}, ${type}::node_type, ${`${L} ${path}`},
              ${type === 'branch' ? path.split('.').at(-1)! : null}, ${path}::ltree, 'admin',
              ${type === 'note' ? JSON.stringify({ content: 'x' }) : '{}'}::jsonb, '{}')`);
  const draft = async (login: string, title: string, path?: string) => {
    const S = spaceOf[login]!;
    const row = await m.withSpace({ spaceId: S, loginId: login }, () =>
      sp.createMineItem(S, { type: 'note', title: `${L} ${title}`, content: 'x' }, {}, { path }),
    );
    return row.id;
  };
  const pathOf = async (id: string) =>
    (
      (await m.systemDb.execute(
        sqlTag`select path::text as path from nodes where id = ${id}`,
      )) as unknown as { path: string }[]
    )[0]?.path ?? null;
  const page = (folderId: string | null) =>
    tree.loadMemberTreeFolder(scopeA, 'notes', { folderId });
  const titles = (items: { title: string }[]) => items.map((i) => i.title.replace(`${L} `, ''));
  const ourFolders = (fs: { name: string; path: string }[]) =>
    fs.filter((f) => f.path.includes(L)).map((f) => f.name);

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

    await brainRow(ids.teamF, 'branch', `notes.${L}_team`);
    await brainRow(ids.hiddenF, 'branch', `notes.${L}_hidden`);
    await brainRow(ids.closedF, 'branch', `notes.${L}_closed`);
    await brainRow(ids.inTeam, 'note', `notes.${L}_team`);
    await brainRow(ids.inHidden, 'note', `notes.${L}_hidden`);
    await brainRow(ids.inClosed, 'note', `notes.${L}_closed`);
    await m.systemDb.execute(sqlTag`update nodes set share_level = 'team' where id = ${ids.teamF}`);
  }, 60_000);

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${brain}
      and (path::text like ${`notes.${L}%`})`);
    for (const l of [a, b]) {
      await m.systemDb.execute(sqlTag`delete from nodes where owner_id in
        (select id from spaces where login_id = ${l})`);
      await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${l}`);
      await m.systemDb.execute(sqlTag`delete from auth.users where id = ${l}`);
    }
    await m.closeDb();
  });

  it('shows the shared folder, not a closed one; a member creates its own folder in it', async () => {
    const top = (await page(null))!;
    expect(ourFolders(top.folders)).toEqual([`${L} notes.${L}_team`]);
    expect(top.folders.some((f) => f.id === ids.closedF)).toBe(false);
    const mine = await tree.createMemberFolder(scopeA, 'notes', {
      parentId: ids.teamF,
      name: 'Mine',
    });
    expect(mine).toMatchObject({ own: true, path: `notes.${L}_team.mine`, parentId: ids.teamF });
    const inTeam = (await page(ids.teamF))!;
    expect(inTeam.folders.map((f) => f.name)).toEqual(['Mine']);
    expect(titles(inTeam.items)).toEqual([`notes.${L}_team`]);
  });

  it('refuses a folder where the member sees nothing, a duplicate name, and a fourth level', async () => {
    await expect(
      tree.createMemberFolder(scopeA, 'notes', { parentId: ids.closedF, name: 'Sneak' }),
    ).rejects.toThrow(/not found/);
    await expect(
      tree.createMemberFolder(scopeA, 'notes', { parentId: ids.teamF, name: 'mine' }),
    ).rejects.toThrow(/already exists/);
    const top = (await page(ids.teamF))!;
    const mine = top.folders.find((f) => f.name === 'Mine')!;
    const two = await tree.createMemberFolder(scopeA, 'notes', { parentId: mine.id, name: 'Two' });
    await expect(
      tree.createMemberFolder(scopeA, 'notes', { parentId: two.id, name: 'Four' }),
    ).rejects.toThrow(/at most 3/);
    await tree.deleteMemberFolder(scopeA, 'notes', two.id);
  });

  it('files a new draft in a folder; its drafts come first, with their state', async () => {
    const mine = (await page(ids.teamF))!.folders.find((f) => f.name === 'Mine')!;
    const at = await tree.memberFilingPath(scopeA, 'notes', mine.id);
    const id = await draft(a, 'my draft', at);
    expect(await pathOf(id)).toBe(`notes.${L}_team.mine`);
    const inMine = (await page(mine.id))!;
    expect(inMine.items).toEqual([
      expect.objectContaining({ id, source: 'own', state: 'private' }),
    ]);
    expect(inMine.crumbs.map((c) => c.id)).toEqual([ids.teamF]);
  });

  it('a draft below a folder the member cannot see shows higher up, never the folder', async () => {
    // (The admin unshared its folder, say.) The member keeps its draft, at
    // the deepest folder it sees: here the top level.
    const id = await draft(a, 'in hidden', `notes.${L}_hidden`);
    const top = (await page(null))!;
    expect(top.folders.some((f) => f.id === ids.hiddenF)).toBe(false);
    expect(top.items.some((i) => i.id === id)).toBe(true);
    expect(await page(ids.hiddenF)).toBeNull();
  });

  it('naming its own folder like a hidden brain folder reveals nothing of it (audit S4)', async () => {
    const own = await tree.createMemberFolder(scopeA, 'notes', {
      parentId: null,
      name: `${L}_hidden`,
    });
    // The member's own row: its name, its id, no share, never the brain's.
    expect(own).toMatchObject({ own: true, name: `${L}_hidden`, share: null });
    expect(own.id).not.toBe(ids.hiddenF);
    const top = (await page(null))!;
    const shown = top.folders.filter((f) => f.path === `notes.${L}_hidden`);
    expect(shown.map((f) => [f.id, f.name])).toEqual([[own.id, `${L}_hidden`]]);
    expect(top.folders.some((f) => f.id === ids.hiddenF)).toBe(false);
    expect(await page(ids.hiddenF)).toBeNull();
    // Filing into the brain's id is refused: it is not a place the member sees.
    await expect(tree.memberFilingPath(scopeA, 'notes', ids.hiddenF)).rejects.toThrow(/not found/);
    const search = await tree.searchMemberTree(scopeA, 'notes', `${L}_hidden`);
    expect(search.folders.map((f) => f.id)).toEqual([own.id]);
    await tree.deleteMemberFolder(scopeA, 'notes', own.id);
  });

  it('a teammate’s shared draft below a hidden folder shows at a folder the member sees', async () => {
    const S = spaceOf[b]!;
    const inClosed = await draft(b, 'ben in closed', `notes.${L}_closed`);
    await m.systemDb.execute(
      sqlTag`update space_items set sharing = 'team' where node_id = ${inClosed}`,
    );
    const top = (await page(null))!;
    expect(top.folders.some((f) => f.id === ids.closedF)).toBe(false);
    expect(top.items.find((i) => i.id === inClosed)).toMatchObject({ source: 'team' });
    await m.systemDb.execute(sqlTag`delete from nodes where id = ${inClosed} and owner_id = ${S}`);
  });

  it('pages a folder through its drafts, then the brain’s items', async () => {
    const mine = (await page(ids.teamF))!.folders.find((f) => f.name === 'Mine')!;
    const at = await tree.memberFilingPath(scopeA, 'notes', mine.id);
    for (const n of [1, 2, 3]) await draft(a, `paged ${n}`, at);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p = (await tree.loadMemberTreeFolder(scopeA, 'notes', {
        folderId: mine.id,
        cursor,
        limit: 2,
      }))!;
      expect(p.items.length).toBeLessThanOrEqual(2);
      seen.push(...p.items.map((i) => i.id));
      cursor = p.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    // Every draft there once, none repeated.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe((await page(mine.id))!.folder!.itemCount);
  });

  it('a teammate’s shared draft shows at the deepest folder the member sees; a private one never', async () => {
    const S = spaceOf[b]!;
    await m.systemDb.execute(sqlTag`
      insert into nodes (owner_id, type, title, slug, path, audience, data, tags)
      values (${S}, 'branch', 'Ben private', 'ben_private', ${`notes.${L}_team.ben_private`}::ltree,
              'admin', '{}'::jsonb, '{}')`);
    const shared = await draft(b, 'ben shared', `notes.${L}_team.ben_private`);
    const priv = await draft(b, 'ben private', `notes.${L}_team`);
    await m.systemDb.execute(
      sqlTag`update space_items set sharing = 'team' where node_id = ${shared}`,
    );
    const inTeam = (await page(ids.teamF))!;
    expect(inTeam.folders.map((f) => f.name)).toEqual(['Mine']);
    expect(inTeam.items.find((i) => i.id === shared)).toMatchObject({
      source: 'team',
      author: 'Ben',
      state: 'draft',
    });
    expect(inTeam.items.some((i) => i.id === priv)).toBe(false);
    // Nothing of B's is A's to move.
    const res = await tree.moveMemberItems(scopeA, 'notes', [shared], ids.teamF);
    expect(res).toMatchObject({ moved: 0 });
    expect(await pathOf(shared)).toBe(`notes.${L}_team.ben_private`);
  });

  it('changes only its own folders, and moves only its own drafts that are not with an admin', async () => {
    await expect(
      tree.updateMemberFolder(scopeA, 'notes', ids.teamF, { name: 'Mine now' }),
    ).rejects.toThrow(/only your own/);
    const mine = (await page(ids.teamF))!.folders.find((f) => f.name === 'Mine')!;
    const renamed = await tree.updateMemberFolder(scopeA, 'notes', mine.id, { name: 'Drafts' });
    expect(renamed).toMatchObject({ path: `notes.${L}_team.drafts`, name: 'Drafts' });
    const inside = (await page(mine.id))!.items[0]!.id;
    expect(await pathOf(inside)).toBe(`notes.${L}_team.drafts`);

    const loose = await draft(a, 'loose');
    expect((await tree.moveMemberItems(scopeA, 'notes', [loose], mine.id)).moved).toBe(1);
    expect(await pathOf(loose)).toBe(`notes.${L}_team.drafts`);
    const [before] = (await m.systemDb.execute(
      sqlTag`select review_state from space_items where node_id = ${loose}`,
    )) as unknown as Array<{ review_state: string }>;
    await m.systemDb.execute(
      sqlTag`update space_items set review_state = 'submitted' where node_id = ${loose}`,
    );
    expect((await tree.moveMemberItems(scopeA, 'notes', [loose], null)).moved).toBe(0);
    expect(await pathOf(loose)).toBe(`notes.${L}_team.drafts`);
    // Nor does its folder move while it is with an admin: the admin's Accept
    // lands it where it was reviewed.
    await expect(
      tree.updateMemberFolder(scopeA, 'notes', mine.id, { parentId: null }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await pathOf(loose)).toBe(`notes.${L}_team.drafts`);
    // Back from review, the folder move carries it.
    await m.systemDb.execute(
      sqlTag`update space_items set review_state = ${before!.review_state} where node_id = ${loose}`,
    );
    const moved = await tree.updateMemberFolder(scopeA, 'notes', mine.id, { parentId: null });
    expect(moved.path).toBe('notes.drafts');
    expect(await pathOf(loose)).toBe('notes.drafts');
  });

  it('deleting its own folder lifts its drafts to the parent', async () => {
    const top = (await page(null))!;
    const drafts = top.folders.find((f) => f.own && f.name === 'Drafts')!;
    const inside = (await page(drafts.id))!.items.map((i) => i.id);
    expect(inside.length).toBeGreaterThan(0);
    await tree.deleteMemberFolder(scopeA, 'notes', drafts.id);
    for (const id of inside) expect(await pathOf(id)).toBe('notes');
    expect(await pathOf(drafts.id)).toBeNull();
  });

  it('another member sees none of A’s folders or private drafts', async () => {
    const scopeB = { anchorId: brain, spaceId: spaceOf[b]!, loginId: b };
    const top = (await tree.loadMemberTreeFolder(scopeB, 'notes', {}))!;
    expect(top.folders.some((f) => f.id === ids.hiddenF)).toBe(false);
    expect(top.items.some((i) => i.source === 'own' && i.title.includes('in hidden'))).toBe(false);
    const search = await tree.searchMemberTree(scopeB, 'notes', `${L} in hidden`);
    expect(search.items).toEqual([]);
  });
});
