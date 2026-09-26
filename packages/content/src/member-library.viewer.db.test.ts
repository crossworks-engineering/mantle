/**
 * The member Library on a real, migrated Postgres, read at the team level
 * (member logins, Phase 1): row security alone decides what a member sees.
 * Seeds its own rows under the brain's anchor and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/member-library.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('member Library at the team level', () => {
  type Db = typeof import('@mantle/db');
  type Lib = typeof import('./member-library');
  let m: Db;
  let lib: Lib;
  let sqlTag: typeof import('drizzle-orm').sql;
  let anchor: string;
  let createdAnchor = false;
  const tag = `member-lib-${randomUUID().slice(0, 8)}`;
  const ids = {
    teamPage: randomUUID(),
    adminPage: randomUUID(),
    publicNote: randomUUID(),
    task: randomUUID(),
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    // ONE key for every viewer DB test: roles are cluster-wide (28P01).
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    // The admin pool's own postgres-js client, for setup.
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    lib = await import('./member-library');
    sqlTag = (await import('drizzle-orm')).sql;

    // The row policy keys nodes to the brain's anchor (is_owner).
    const rows = (await m.systemDb.execute(
      sqlTag`select id from auth.users where is_owner limit 1`,
    )) as unknown as { id: string }[];
    if (rows[0]) {
      anchor = rows[0].id;
    } else {
      anchor = randomUUID();
      createdAnchor = true;
      await m.systemDb.execute(sqlTag`
        insert into auth.users (id, email, password_hash, is_owner)
        values (${anchor}, ${`${tag}@example.invalid`}, 'x', true)`);
    }
    const draft = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] });
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${ids.teamPage}, ${anchor}, 'page', ${`${tag} team page`}, 'pages', 'team'),
        (${ids.adminPage}, ${anchor}, 'page', ${`${tag} admin page`}, 'pages', 'admin'),
        (${ids.publicNote}, ${anchor}, 'note', ${`${tag} public note`}, 'notes', 'public'),
        (${ids.task}, ${anchor}, 'task', ${`${tag} task`}, 'tasks', 'admin')`);
    await m.systemDb.execute(sqlTag`
      insert into pages (node_id, doc, doc_text, draft_doc) values
        (${ids.teamPage}, '{"type":"doc","content":[]}'::jsonb, '', ${draft}::jsonb),
        (${ids.adminPage}, '{"type":"doc","content":[]}'::jsonb, '', null)`);
  });

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`delete from nodes where title like ${`${tag}%`}`);
    if (createdAnchor)
      await m.systemDb.execute(sqlTag`delete from auth.users where id = ${anchor}`);
    await m.closeDb();
  });

  it('refuses to run outside a viewer scope', async () => {
    await expect(lib.listLibrary(anchor)).rejects.toThrow(/viewer scope/);
  });

  it('lists team- and public-level items, never admin ones', async () => {
    const { items } = await m.withViewer('team', () => lib.listLibrary(anchor, { q: tag }));
    expect(items.map((i) => i.id).sort()).toEqual([ids.teamPage, ids.publicNote].sort());
  });

  it('reads a team page (published doc only) and 404s an admin one', async () => {
    const page = await m.withViewer('team', () => lib.getLibraryItem(anchor, ids.teamPage));
    expect(page?.type).toBe('page');
    expect(page && 'doc' in page && page.doc).toEqual({ type: 'doc', content: [] });
    expect(await m.withViewer('team', () => lib.getLibraryItem(anchor, ids.adminPage))).toBeNull();
    expect(await m.withViewer('team', () => lib.getLibraryItem(anchor, ids.task))).toBeNull();
  });

  it('shows a public-level reader only public items', async () => {
    const { items } = await m.withViewer('public', () => lib.listLibrary(anchor, { q: tag }));
    expect(items.map((i) => i.id)).toEqual([ids.publicNote]);
  });
});
