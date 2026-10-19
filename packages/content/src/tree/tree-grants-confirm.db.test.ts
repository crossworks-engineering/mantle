/**
 * The tree's visibility confirm on grants (W5b2, S6), on a scratch brain the
 * workspaces migration made live: a page made in a folder another
 * workspace reads names it ("This will also be visible to: ..."); a page
 * moved in and out names what it gains and loses; a folder move reaches
 * what is inside, except past a folder's "Removed here" or a grant set on
 * an item; a folder deleted lifts its contents, a merged subfolder taking
 * the folder it merges into. Each confirmed write ends as the list said.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/tree-grants-confirm.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the tree confirm on grants', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let tree: typeof import('./index');
  let pages: typeof import('../pages');
  const owner = randomUUID();
  const S = randomUUID();
  let admin = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  /** A fixture write to the workspace tables, as the superuser: the app's
   *  pools only read them. */
  const su = async (q: ReturnType<typeof sql>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);
  const readWs = async (id: string) =>
    (await x<{ r: string[] }>(sql`select read_ws::text[] as r from nodes where id = ${id}`))[0]!.r;
  /** A grant set by hand (or "Removed here" with `excluded`), heads first. */
  const grant = (id: string, ws: string, excluded = false) =>
    m.withSubtreeHeads(id, [], async (tx) => {
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, excluded)
                           values (${id}, ${ws}, ${excluded})
                           on conflict (node_id, workspace_id)
                           do update set excluded = ${excluded}, via_folder_id = null`);
    });
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      if (err instanceof tree.TreeVisibilityError) return err.diff;
      throw err;
    }
    throw new Error('expected a visibility refusal');
  };
  const sales = () => [{ wsId: S, name: 'Sales' }];
  const folder = (name: string, parentId: string | null = null) =>
    tree.createTreeFolder(owner, 'pages', { parentId, name });

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tree = await import('./index');
    pages = await import('../pages');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role)
                values (${owner}, ${`confirm-${owner.slice(0, 8)}@example.invalid`}, 'x', true, 'admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
                on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    admin = (
      await x<{ id: string }>(
        sql`select id::text as id from workspaces where owner_id = ${owner} and is_admin`,
      )
    )[0]!.id;
    await su(sql`insert into workspaces (id, owner_id, name) values (${S}, ${owner}, 'Sales')`);
    await tree.ensureKindRoot(owner, 'pages');
  }, 180_000);

  // Dropping the scratch database can wait on other suites' connections on
  // a busy box: give the hook room instead of the 10 s default.
  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  }, 60_000);

  it('a new page in a folder Sales reads names Sales; Admin only or the top level asks nothing', async () => {
    const f = await folder('Sales folder');
    await grant(f.id, S);
    const diff = await refusal(pages.createPage(owner, { title: 'Pitch', folderId: f.id }));
    expect(diff).toEqual({
      total: 1,
      changes: [
        {
          id: '',
          title: 'Pitch',
          alsoVisibleTo: sales(),
          removedFrom: [],
          // Where it is homed, and who reads it without edit (A0, L-c).
          home: expect.objectContaining({ wsId: admin }),
          readOnly: sales(),
        },
      ],
    });
    expect((await tree.loadTreeFolder(owner, 'pages', { folderId: f.id }))!.items).toEqual([]);
    // A confirm for another count asks again; the right one goes ahead.
    await refusal(
      pages.createPage(owner, { title: 'Pitch', folderId: f.id, confirm: true, seen: 2 }),
    );
    const page = await pages.createPage(owner, {
      title: 'Pitch',
      folderId: f.id,
      confirm: true,
      seen: 1,
    });
    expect((await readWs(page.id)).sort()).toEqual([admin, S].sort());

    const plain = await folder('Plain folder');
    const quiet = await pages.createPage(owner, { title: 'Quiet', folderId: plain.id });
    expect(await readWs(quiet.id)).toEqual([admin]);
    const top = await pages.createPage(owner, { title: 'Top' });
    expect(await readWs(top.id)).toEqual([admin]);
    // The page's own row only: a page made next to one (split, extract).
    expect(
      await tree.guardNewPageIn(m.db, owner, f.path, 'Beside', null, { ownRow: false }),
    ).toEqual({ changes: [], total: 0 });
  });

  it('a page moved in names what it gains, moved out what it loses', async () => {
    const [f] = await x<{ id: string }>(sql`
      select id::text as id from nodes where owner_id = ${owner} and type = 'branch'
         and path = 'pages.sales_folder'::ltree`);
    const page = await pages.createPage(owner, { title: 'Mover' });
    const into = await refusal(tree.moveTreeItems(owner, 'pages', [page.id], f!.id));
    expect(into.changes).toEqual([
      { id: page.id, title: 'Mover', alsoVisibleTo: sales(), removedFrom: [] },
    ]);
    expect(await readWs(page.id)).toEqual([admin]);
    await tree.moveTreeItems(owner, 'pages', [page.id], f!.id, { confirm: true, seen: 1 });
    expect((await readWs(page.id)).sort()).toEqual([admin, S].sort());
    const out = await refusal(tree.moveTreeItems(owner, 'pages', [page.id], null));
    expect(out.changes).toEqual([
      { id: page.id, title: 'Mover', alsoVisibleTo: [], removedFrom: sales() },
    ]);
    await tree.moveTreeItems(owner, 'pages', [page.id], null, { confirm: true });
    expect(await readWs(page.id)).toEqual([admin]);
  });

  it('a folder move reaches inside, but not past "Removed here" nor a grant set on an item', async () => {
    const dest = await folder('Sales dest');
    await grant(dest.id, S);
    const xf = await folder('Xmove');
    const a = await pages.createPage(owner, { title: 'Alpha', folderId: xf.id });
    const y = await folder('Ysub', xf.id);
    const b = await pages.createPage(owner, { title: 'Bravo', folderId: y.id });
    // Ysub does not take Sales from above: "Removed here".
    await grant(y.id, S, true);

    const diff = await refusal(tree.updateTreeFolder(owner, 'pages', xf.id, { parentId: dest.id }));
    expect(diff.total).toBe(2);
    expect(diff.changes).toEqual([
      { id: a.id, title: 'Alpha', alsoVisibleTo: sales(), removedFrom: [] },
      { id: xf.id, title: 'Xmove', alsoVisibleTo: sales(), removedFrom: [] },
    ]);
    await tree.updateTreeFolder(
      owner,
      'pages',
      xf.id,
      { parentId: dest.id },
      { confirm: true, seen: 2 },
    );
    // The database derived exactly what the list said.
    for (const id of [xf.id, a.id]) expect(await readWs(id)).toContain(S);
    for (const id of [y.id, b.id]) expect(await readWs(id)).not.toContain(S);

    // Alpha keeps Sales on its own (a grant set on it): only the folder
    // loses it on the way back.
    await grant(a.id, S);
    const back = await refusal(tree.updateTreeFolder(owner, 'pages', xf.id, { parentId: null }));
    expect(back.changes).toEqual([
      { id: xf.id, title: 'Xmove', alsoVisibleTo: [], removedFrom: sales() },
    ]);
    await tree.updateTreeFolder(owner, 'pages', xf.id, { parentId: null }, { confirm: true });
    expect(await readWs(xf.id)).not.toContain(S);
    expect(await readWs(a.id)).toContain(S);
  });

  it('a folder deleted lifts what it holds; a merged subfolder takes the folder it joins', async () => {
    // A top-level "Mix" that Sales reads, and one inside the deleted folder.
    const mixTop = await folder('Mix');
    await grant(mixTop.id, S);
    const p = await folder('Lift me');
    await grant(p.id, S);
    const c = await pages.createPage(owner, {
      title: 'Charlie',
      folderId: p.id,
      confirm: true,
      seen: 1,
    });
    const q = await folder('Qsub', p.id);
    const d = await pages.createPage(owner, {
      title: 'Delta',
      folderId: q.id,
      confirm: true,
      seen: 1,
    });
    const mix = await folder('Mix', p.id);
    const e = await pages.createPage(owner, {
      title: 'Echo',
      folderId: mix.id,
      confirm: true,
      seen: 1,
    });
    for (const id of [c.id, q.id, d.id, e.id]) expect(await readWs(id)).toContain(S);

    const diff = await refusal(tree.deleteTreeFolder(owner, 'pages', p.id));
    // Echo lands in the top-level Mix, which Sales reads too: no change.
    expect(diff.total).toBe(3);
    expect(diff.changes.map((ch) => [ch.title, ch.alsoVisibleTo, ch.removedFrom])).toEqual([
      ['Charlie', [], sales()],
      ['Delta', [], sales()],
      ['Qsub', [], sales()],
    ]);
    await tree.deleteTreeFolder(owner, 'pages', p.id, { confirm: true, seen: 3 });
    for (const id of [c.id, q.id, d.id]) expect(await readWs(id)).not.toContain(S);
    expect(await readWs(e.id)).toContain(S);
  });
});
