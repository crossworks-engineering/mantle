/**
 * The member Library on a real, migrated Postgres (member logins, Phase 1):
 * row security alone decides what a member sees. No level narrows it and no
 * row carries a level (W5c). The level roles (runInLevelRoleForTest) still
 * prove the published-columns rule; the last block reads as a login in the
 * shim's workspace scope (withViewer with { login }, workspaces W5b2), where
 * the grants decide.
 * Seeds its own rows under the brain's anchor and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/member-library.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('member Library at the team level', () => {
  type Db = typeof import('@mantle/db');
  type Lib = typeof import('./member-library');
  let m: Db;
  let lib: Lib;
  let sqlTag: typeof import('drizzle-orm').sql;
  let anchor: string;
  const tag = `member-lib-${randomUUID().slice(0, 8)}`;
  const ids = {
    teamPage: randomUUID(),
    adminPage: randomUUID(),
    publicNote: randomUUID(),
    clientNote: randomUUID(),
    task: randomUUID(),
    fragment: randomUUID(),
  };

  const tableRoot = mkdtempSync(path.join(tmpdir(), 'mantle-lib-tables-'));

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.TABLE_DB_DIR = tableRoot;
    // ONE key for every viewer DB test: roles are cluster-wide (28P01).
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    // The admin pool's own postgres-js client, for setup.
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    lib = await import('./member-library');
    sqlTag = (await import('drizzle-orm')).sql;

    // The row policy keys nodes to the brain's anchor (is_owner): the one
    // shared test anchor, which no test deletes.
    anchor = await ensureTestAnchor(admin);
    const draft = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] });
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${ids.teamPage}, ${anchor}, 'page', ${`${tag} team page`}, 'pages', 'team'),
        (${ids.adminPage}, ${anchor}, 'page', ${`${tag} admin page`}, 'pages', 'admin'),
        (${ids.publicNote}, ${anchor}, 'note', ${`${tag} public note`}, 'notes', 'public'),
        (${ids.clientNote}, ${anchor}, 'note', ${`${tag} client note`}, 'notes', 'client'),
        (${ids.task}, ${anchor}, 'task', ${`${tag} task`}, 'tasks', 'admin')`);
    // An image cut out of a document at ingest: a file pointing at its source.
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience, data) values
        (${ids.fragment}, ${anchor}, 'file', ${`${tag} report - image 1 (p1)`}, 'files', 'team',
         ${JSON.stringify({ sourceFileId: ids.teamPage, mime_type: 'image/png' })}::jsonb)`);
    await m.systemDb.execute(sqlTag`
      insert into pages (node_id, doc, doc_text, draft_doc) values
        (${ids.teamPage}, '{"type":"doc","content":[]}'::jsonb, '', ${draft}::jsonb),
        (${ids.adminPage}, '{"type":"doc","content":[]}'::jsonb, '', null)`);
  }, 60_000);

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`delete from nodes where title like ${`${tag}%`}`);
    await m.closeDb();
    rmSync(tableRoot, { recursive: true, force: true });
  });

  it('refuses to run outside a viewer scope', async () => {
    await expect(lib.listLibrary(anchor)).rejects.toThrow(/viewer scope/);
  });

  it('no level narrows the list and no row carries one: row security decides', async () => {
    const { items } = await m.runInLevelRoleForTest('team', () =>
      lib.listLibrary(anchor, { q: tag }),
    );
    const listed = items.map((i) => i.id);
    expect(listed).toEqual(expect.arrayContaining([ids.teamPage, ids.clientNote]));
    expect(listed).not.toContain(ids.adminPage);
    expect(listed).not.toContain(ids.task);
    for (const i of items) expect('audience' in i, i.id).toBe(false);
  });

  it('leaves images cut out of documents out of the list, but reads them by id', async () => {
    const { items } = await m.runInLevelRoleForTest('team', () =>
      lib.listLibrary(anchor, { q: tag }),
    );
    expect(items.map((i) => i.id)).not.toContain(ids.fragment);
    const frag = await m.runInLevelRoleForTest('team', () =>
      lib.getLibraryItem(anchor, ids.fragment),
    );
    expect(frag?.type).toBe('file');
  });

  it('reads a team page (published doc only) and 404s an admin one', async () => {
    const page = await m.runInLevelRoleForTest('team', () =>
      lib.getLibraryItem(anchor, ids.teamPage),
    );
    expect(page?.type).toBe('page');
    expect(page && 'doc' in page && page.doc).toEqual({ type: 'doc', content: [] });
    expect(
      await m.runInLevelRoleForTest('team', () => lib.getLibraryItem(anchor, ids.adminPage)),
    ).toBeNull();
    expect(
      await m.runInLevelRoleForTest('team', () => lib.getLibraryItem(anchor, ids.task)),
    ).toBeNull();
  });

  it('reads a team table’s published workbook only, never the admin’s unsaved draft', async () => {
    const write = await import('./tables/write');
    const draft = await import('./tables/draft');
    const t = await write.createTable(anchor, { title: `${tag} team table` });
    const col = t.data.columns[0]!.id;
    await draft.commitTable(anchor, t.id, {
      ...t.data,
      rows: [{ id: randomUUID(), cells: { [col]: 'published cell' } }],
    });
    // The levels are frozen since W5b2: the level role reads one, so the
    // fixture sets it under the test bypass.
    await m.systemDb.transaction(async (tx) => {
      await tx.execute(sqlTag`select mantle_heads_bypass('test fixture')`);
      await tx.execute(sqlTag`update nodes set audience = 'team' where id = ${t.id}`);
    });
    const applied = await draft.applyTableOps(anchor, t.id, [
      { op: 'row_add', cells: { [col]: 'admin draft secret' } },
    ]);
    expect(applied?.ok).toBe(true);
    const item = await m.runInLevelRoleForTest('team', () => lib.getLibraryItem(anchor, t.id));
    const text = JSON.stringify(item);
    expect(text).toContain('published cell');
    expect(text).not.toContain('admin draft secret');
  });
  it('as a login (workspace scope): lists and opens what its workspace holds, by grant, nothing else', async () => {
    const login = randomUUID();
    const ws = randomUUID();
    const other = randomUUID();
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${login}, ${`${tag}-ws@example.invalid`}, 'x', 'member')`);
    await m.systemDb.execute(sqlTag`
      insert into workspaces (id, owner_id, name) values
        (${ws}, ${anchor}, ${`${tag} ws`}), (${other}, ${anchor}, ${`${tag} other`})`);
    await m.systemDb.execute(
      sqlTag`insert into workspace_users (workspace_id, login_id) values (${ws}, ${login})`,
    );
    // Its workspace holds the team page and the admin page (the grant
    // decides, not the frozen level); another workspace the client note.
    const holds: Array<[string, string]> = [
      [ws, ids.teamPage],
      [ws, ids.adminPage],
      [other, ids.clientNote],
    ];
    for (const [wsId, id] of holds) {
      await m.withSubtreeHeads(id, [], (tx) =>
        tx.execute(sqlTag`insert into item_grants (node_id, workspace_id) values (${id}, ${wsId})`),
      );
    }
    try {
      const as = <T>(fn: () => Promise<T>) => m.withViewer({ login }, fn);
      const { items, total } = await as(() => lib.listLibrary(anchor, { q: tag }));
      expect(items.map((i) => i.id).sort()).toEqual([ids.teamPage, ids.adminPage].sort());
      expect(total).toBe(2);
      expect(await as(() => lib.getLibraryItem(anchor, ids.adminPage))).toMatchObject({
        type: 'page',
      });
      // Not held by a workspace of theirs: neither listed nor opened.
      expect(await as(() => lib.getLibraryItem(anchor, ids.clientNote))).toBeNull();
      expect(await as(() => lib.getLibraryItem(anchor, ids.publicNote))).toBeNull();
      expect((await as(() => lib.libraryCounts(anchor))).note).toBe(0);
    } finally {
      for (const [wsId, id] of holds) {
        await m.withSubtreeHeads(id, [], (tx) =>
          tx.execute(
            sqlTag`delete from item_grants where node_id = ${id} and workspace_id = ${wsId}`,
          ),
        );
      }
      await m.systemDb.execute(sqlTag`delete from workspaces where id in (${ws}, ${other})`);
      await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${login}`);
      await m.systemDb.execute(sqlTag`delete from auth.users where id = ${login}`);
    }
  });
});
