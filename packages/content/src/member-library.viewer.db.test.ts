/**
 * The member Library on a real, migrated Postgres, read at the team level
 * (member logins, Phase 1): row security alone decides what a member sees.
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

  it('lists team and client items with their level: never admin, and not open-link (public) ones', async () => {
    const { items, total } = await m.withViewer('team', () => lib.listLibrary(anchor, { q: tag }));
    expect(items.map((i) => [i.id, i.audience]).sort()).toEqual(
      [
        [ids.teamPage, 'team'],
        [ids.clientNote, 'client'],
      ].sort(),
    );
    expect(total).toBe(2);
  });

  it('shows a client-level reader only client items', async () => {
    const { items } = await m.withViewer('client', () => lib.listLibrary(anchor, { q: tag }));
    expect(items.map((i) => i.id)).toEqual([ids.clientNote]);
    expect(await m.withViewer('client', () => lib.getLibraryItem(anchor, ids.teamPage))).toBeNull();
  });

  it('leaves images cut out of documents out of the list, but reads them by id', async () => {
    const { items } = await m.withViewer('team', () => lib.listLibrary(anchor, { q: tag }));
    expect(items.map((i) => i.id)).not.toContain(ids.fragment);
    const frag = await m.withViewer('team', () => lib.getLibraryItem(anchor, ids.fragment));
    expect(frag?.type).toBe('file');
  });

  it('reads a client item by id at the team level, and a public one too (audit B10)', async () => {
    const note = await m.withViewer('team', () => lib.getLibraryItem(anchor, ids.clientNote));
    expect(note).toMatchObject({ type: 'note', audience: 'client' });
    // Not listed (the test above), but opened by id: no Client badge.
    const open = await m.withViewer('team', () => lib.getLibraryItem(anchor, ids.publicNote));
    expect(open).toMatchObject({ id: ids.publicNote, type: 'note', audience: 'team' });
  });

  it('a client does not open a public item by id', async () => {
    expect(
      await m.withViewer('client', () => lib.getLibraryItem(anchor, ids.publicNote)),
    ).toBeNull();
  });

  it('reads a team page (published doc only) and 404s an admin one', async () => {
    const page = await m.withViewer('team', () => lib.getLibraryItem(anchor, ids.teamPage));
    expect(page?.type).toBe('page');
    expect(page && 'doc' in page && page.doc).toEqual({ type: 'doc', content: [] });
    expect(await m.withViewer('team', () => lib.getLibraryItem(anchor, ids.adminPage))).toBeNull();
    expect(await m.withViewer('team', () => lib.getLibraryItem(anchor, ids.task))).toBeNull();
  });

  it('lists nothing for a level with no Library (public): fail closed', async () => {
    const { items, total } = await m.withViewer('public', () =>
      lib.listLibrary(anchor, { q: tag }),
    );
    expect(items).toEqual([]);
    expect(total).toBe(0);
    expect(
      await m.withViewer('public', () => lib.getLibraryItem(anchor, ids.publicNote)),
    ).toBeNull();
    expect(await m.withViewer('public', () => lib.libraryCounts(anchor))).toEqual({
      page: 0,
      note: 0,
      draw: 0,
      table: 0,
      file: 0,
    });
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
    await m.systemDb.execute(sqlTag`update nodes set audience = 'team' where id = ${t.id}`);
    const applied = await draft.applyTableOps(anchor, t.id, [
      { op: 'row_add', cells: { [col]: 'admin draft secret' } },
    ]);
    expect(applied?.ok).toBe(true);
    const item = await m.withViewer('team', () => lib.getLibraryItem(anchor, t.id));
    const text = JSON.stringify(item);
    expect(text).toContain('published cell');
    expect(text).not.toContain('admin draft secret');
  });
});
