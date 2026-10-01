/**
 * What a CLIENT login reads (client logins C2), on a real, migrated Postgres,
 * inside withViewer('client'): "Shared with you" is exactly the brain's
 * client items (never public, team, admin, a team draft, a member's space or
 * an admin's private space); a team item by id is a miss; a client page that
 * names a team item carries "Private item" instead of its title and leaves
 * its embed out; file bytes and drawing images above client are never
 * served; no DTO carries an author or a level.
 *
 * Brain items belong to the shared test anchor (mantle_brain_id()): the
 * client role's row security knows only that brain. Removes its rows after
 * (the anchor stays).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/client-shared.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('what a client reads', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let cs: typeof import('./client-shared');
  let cd: typeof import('./client-draw-images');
  let lib: typeof import('./member-library');
  let files: typeof import('@mantle/files');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `cshared-${randomUUID().slice(0, 8)}`;
  let brain = '';
  const member = randomUUID();
  const adminA = randomUUID();
  const logins = [member, adminA];
  const spaceOf: Record<string, string> = {};
  const b = {
    clientPage: randomUUID(),
    clientPage2: randomUUID(),
    clientNote: randomUUID(),
    clientFile: randomUUID(),
    clientDraw: randomUUID(),
    teamPage: randomUUID(),
    teamFile: randomUUID(),
    teamDraw: randomUUID(),
    adminPage: randomUUID(),
    adminFile: randomUUID(),
    publicNote: randomUUID(),
  };
  const s = { teamDraft: randomUUID(), memberPrivate: randomUUID(), adminPrivate: randomUUID() };
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-cshared-'));
  const client = <T>(fn: () => Promise<T>) => m.withViewer('client', fn);

  const clientDoc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'mention', attrs: { id: b.teamPage, label: 'TEAMTITLE mention', ref: 'node' } },
          { type: 'text', text: ' and ' },
          {
            type: 'text',
            text: 'ADMINTITLE link',
            marks: [{ type: 'link', attrs: { href: `/n/${b.adminPage}` } }],
          },
          { type: 'text', text: ' and ' },
          { type: 'mention', attrs: { id: b.publicNote, label: 'PUBLICTITLE', ref: 'node' } },
          { type: 'text', text: ' and ' },
          { type: 'mention', attrs: { id: b.clientPage2, label: 'STALELABEL two', ref: 'node' } },
          { type: 'text', text: ' and ' },
          {
            type: 'text',
            text: 'UPPERTEAM link',
            marks: [{ type: 'link', attrs: { href: `PAGE:${b.teamPage}` } }],
          },
          { type: 'text', text: ' and ' },
          {
            type: 'text',
            text: 'ABSTEAM link',
            marks: [
              { type: 'link', attrs: { href: `https://brain.example.invalid/n/${b.teamPage}` } },
            ],
          },
        ],
      },
      { type: 'image', attrs: { nodeId: b.teamFile, alt: 'TEAMFILE alt' } },
      { type: 'childPage', attrs: { pageId: b.teamPage, title: 'TEAMTITLE child' } },
      { type: 'childPage', attrs: { pageId: b.clientPage2, title: 'STALECHILD title' } },
      { type: 'image', attrs: { nodeId: b.clientFile, alt: 'client picture' } },
    ],
  };
  const sym = (id: string, bytes: string) =>
    `<symbol id="image-${id}"><image href="data:image/png;base64,${bytes}"></image></symbol>`;
  const drawSvg = `<svg xmlns="http://www.w3.org/2000/svg"><defs>${sym('sClient', 'Q0xJRU5U')}${sym('sTeam', 'VEVBTQ==')}${sym('sAdmin', 'QURNSU4=')}</defs><a href="/n/${b.teamPage}"><path d="M1"/></a><a href="https://brain.example.invalid/n/${b.adminPage}"><path d="M2"/></a><a href="/n/${b.clientPage2}"><path d="M3"/></a><a href="https://example.invalid/"><path d="M4"/></a></svg>`;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    m = await import('@mantle/db');
    cs = await import('./client-shared');
    cd = await import('./client-draw-images');
    lib = await import('./member-library');
    files = await import('@mantle/files');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    brain = await ensureTestAnchor(admin);
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member', 'Pat Member'),
        (${adminA}, ${`${tag}-a@example.invalid`}, 'x', 'admin', 'Ann Admin')`);
    const rows = (await m.systemDb.execute(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${member}, ${adminA})`)) as unknown as { id: string; login_id: string }[];
    for (const r of rows) spaceOf[r.login_id] = r.id;

    const fileData = (name: string, content: string) =>
      JSON.stringify({ filename: name, content, mime_type: 'text/plain' });
    const noteData = JSON.stringify({
      content: `See [TEAMTITLE notelink](/n/${b.teamPage}) and [ok link](/n/${b.clientPage2}).\n\n![TEAMFILE img](media:${b.teamFile})`,
    });
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience, data) values
        (${b.clientPage}, ${brain}, 'page', ${`${tag} client page`}, 'pages', 'client', '{}'::jsonb),
        (${b.clientPage2}, ${brain}, 'page', ${`${tag} client page two`}, 'pages', 'client', '{}'::jsonb),
        (${b.clientNote}, ${brain}, 'note', ${`${tag} client note`}, 'notes', 'client', ${noteData}::jsonb),
        (${b.clientFile}, ${brain}, 'file', ${`${tag} client file`}, 'files', 'client', ${fileData('c.txt', 'CLIENT BYTES')}::jsonb),
        (${b.clientDraw}, ${brain}, 'draw', ${`${tag} client drawing`}, 'draws', 'client', '{}'::jsonb),
        (${b.teamPage}, ${brain}, 'page', ${`${tag} TEAMTITLE`}, 'pages', 'team', '{}'::jsonb),
        (${b.teamFile}, ${brain}, 'file', ${`${tag} team file`}, 'files', 'team', ${fileData('t.txt', 'TEAM BYTES')}::jsonb),
        (${b.teamDraw}, ${brain}, 'draw', ${`${tag} team drawing`}, 'draws', 'team', '{}'::jsonb),
        (${b.adminPage}, ${brain}, 'page', ${`${tag} ADMINTITLE`}, 'pages', 'admin', '{}'::jsonb),
        (${b.adminFile}, ${brain}, 'file', ${`${tag} admin file`}, 'files', 'admin', ${fileData('a.txt', 'ADMIN BYTES')}::jsonb),
        (${b.publicNote}, ${brain}, 'note', ${`${tag} PUBLICTITLE`}, 'notes', 'public', '{}'::jsonb)`);
    // Items in personal spaces, each set to client: the owner is not the
    // brain, so the client role never sees them, whatever their level says.
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${s.teamDraft}, ${spaceOf[member]!}, 'page', ${`${tag} team draft`}, 'pages', 'client'),
        (${s.memberPrivate}, ${spaceOf[member]!}, 'note', ${`${tag} member private`}, 'notes', 'client'),
        (${s.adminPrivate}, ${spaceOf[adminA]!}, 'note', ${`${tag} admin private`}, 'notes', 'client')`);
    await m.systemDb.execute(sqlTag`
      insert into space_items (node_id, author_login_id, sharing) values
        (${s.teamDraft}, ${member}, 'team'),
        (${s.memberPrivate}, ${member}, 'private'),
        (${s.adminPrivate}, ${adminA}, 'private')`);
    const empty = JSON.stringify({ type: 'doc', content: [] });
    await m.systemDb.execute(sqlTag`
      insert into pages (node_id, doc, doc_text, draft_doc) values
        (${b.clientPage}, ${JSON.stringify(clientDoc)}::jsonb, 'Hello TEAMTITLE mention and TEAMTITLE child', ${JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'DRAFT SECRET' }] }] })}::jsonb),
        (${b.clientPage2}, ${empty}::jsonb, '', null),
        (${b.teamPage}, ${empty}::jsonb, '', null),
        (${b.adminPage}, ${empty}::jsonb, '', null),
        (${s.teamDraft}, ${empty}::jsonb, '', null)`);
    // What the extractor did before the level-filtered text (audit B1): a
    // summary written from the page's whole doc_text, team title and all.
    await m.systemDb.execute(sqlTag`
      update nodes set data = data || ${JSON.stringify({ summary: 'A page about TEAMTITLE mention and TEAMTITLE child' })}::jsonb
       where id in (${b.clientPage}, ${b.clientNote}, ${b.clientFile})`);
    const refs = JSON.stringify({ sClient: b.clientFile, sTeam: b.teamFile, sAdmin: b.adminFile });
    await m.systemDb.execute(sqlTag`
      insert into draws (node_id, scene_svg, file_refs) values
        (${b.clientDraw}, ${drawSvg}, ${refs}::jsonb),
        (${b.teamDraw}, ${drawSvg}, ${refs}::jsonb)`);
  }, 60_000);

  afterAll(async () => {
    for (const id of [...Object.values(b), ...Object.values(s)]) {
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${id}`);
    }
    for (const l of logins) {
      await m.systemDb.execute(sqlTag`delete from nodes where owner_id in
        (select id from spaces where login_id = ${l})`);
      await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${l}`);
      await m.systemDb.execute(sqlTag`delete from auth.users where id = ${l}`);
    }
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('refuses to run anywhere but a client scope', async () => {
    await expect(cs.listClientShared(brain)).rejects.toThrow(/withViewer\('client'\)/);
    await expect(m.withViewer('team', () => cs.listClientShared(brain))).rejects.toThrow();
    await expect(cs.clientReadableIds(brain, [b.teamPage])).rejects.toThrow();
    await expect(cd.clientVisibleDrawFileIds(brain, b.clientDraw)).rejects.toThrow();
  });

  it('"Shared with you" is exactly the client items: no public, team, admin or space item', async () => {
    const { items, total } = await client(() => cs.listClientShared(brain, { q: tag }));
    expect(items.map((i) => i.id).sort()).toEqual(
      [b.clientPage, b.clientPage2, b.clientNote, b.clientFile, b.clientDraw].sort(),
    );
    expect(total).toBe(5);
  });

  it('rows carry only the named fields: no author, no level, no staff id, no summary', async () => {
    const { items } = await client(() => cs.listClientShared(brain, { q: tag }));
    for (const i of items) {
      expect(Object.keys(i).sort()).toEqual(['icon', 'id', 'title', 'type', 'updatedAt'].sort());
    }
  });

  it('a summary written from the unredacted text never reaches a client (audit B1)', async () => {
    const list = await client(() => cs.listClientShared(brain, { q: tag }));
    expect(JSON.stringify(list)).not.toContain('TEAMTITLE');
    for (const id of [b.clientPage, b.clientNote, b.clientFile]) {
      const item = await client(() => cs.getClientSharedItem(brain, id));
      expect(item, id).not.toBeNull();
      expect(JSON.stringify(item), id).not.toContain('TEAMTITLE');
      expect(item && 'summary' in item, id).toBe(false);
    }
  });

  it('a team, admin, public or space item by id is a miss', async () => {
    for (const id of [b.teamPage, b.adminPage, b.publicNote, s.teamDraft, s.adminPrivate]) {
      expect(await client(() => cs.getClientSharedItem(brain, id)), id).toBeNull();
    }
  });

  it('a client page names a team item as "Private item" and leaves its embed out', async () => {
    const item = await client(() => cs.getClientSharedItem(brain, b.clientPage));
    expect(item?.type).toBe('page');
    const text = JSON.stringify(item);
    for (const leak of [
      'TEAMTITLE',
      'ADMINTITLE',
      'PUBLICTITLE',
      'TEAMFILE',
      'DRAFT SECRET',
      b.teamPage,
      b.adminPage,
      b.teamFile,
      b.publicNote,
    ]) {
      expect(text, leak).not.toContain(leak);
    }
    // Two chips and three links relabelled (one an upper-case PAGE: ref, one
    // an absolute URL to a /n/ permalink); the readable chip and image stay.
    expect(text.split('Private item').length - 1).toBe(5);
    for (const leak of ['UPPERTEAM', 'ABSTEAM', 'brain.example.invalid']) {
      expect(text, leak).not.toContain(leak);
    }
    expect(text).toContain(b.clientPage2);
    expect(text).toContain(b.clientFile);
    // A readable chip and child page card carry today's title, not the stored one.
    expect(text).not.toContain('STALELABEL');
    expect(text).not.toContain('STALECHILD');
    expect(text.split(`${tag} client page two`).length - 1).toBe(2);
    // `folderId` (folder phase 7): the folder it sits in, for the Folder
    // index block; a client reads the folder through its own tree route.
    expect(Object.keys(item!).sort()).toEqual(
      ['doc', 'folderId', 'icon', 'id', 'title', 'type', 'updatedAt'].sort(),
    );
  });

  it('a client note links a team item as "Private item" and drops its image', async () => {
    const item = await client(() => cs.getClientSharedItem(brain, b.clientNote));
    expect(item?.type).toBe('note');
    const content = item && item.type === 'note' ? item.content : '';
    expect(content).toBe(`See Private item and [ok link](/n/${b.clientPage2}).\n\n`);
  });

  it('a client table is its grid only: no app, description, tags, summary; private cell refs blanked (audit B13)', async () => {
    const write = await import('./tables/write');
    const t = await write.createTable(brain, {
      title: `${tag} client table`,
      tags: ['TAGSECRET'],
      // What an app export writes: the app's name.
      description: 'Mirrors the APPNAME internal app',
      data: {
        columns: [
          { id: 'c1', name: 'Name', type: 'text' },
          { id: 'c2', name: 'Link', type: 'url' },
        ],
        rows: [
          { id: 'r1', cells: { c1: 'plain value', c2: `/n/${b.teamPage}` } },
          { id: 'r2', cells: { c1: `PAGE:${b.adminPage}`, c2: `/n/${b.clientPage2}` } },
          { id: 'r3', cells: { c1: `https://brain.example.invalid/n/${b.teamFile}`, c2: null } },
        ],
      },
    });
    const link = { appId: randomUUID(), appName: 'APPNAME internal', sqliteTable: 't' };
    await m.systemDb.execute(sqlTag`
      update nodes set audience = 'client',
             data = data || ${JSON.stringify({ appLink: link, summary: 'SUMMARYSECRET', visibility: 'public' })}::jsonb
       where id = ${t.id}`);
    try {
      const item = await client(() => cs.getClientSharedItem(brain, t.id));
      expect(item?.type).toBe('table');
      const table = item && item.type === 'table' ? item.table : null;
      const allowed = ['data', 'docClipped', 'tabs', 'tabId', 'rowCount'];
      expect(Object.keys(table ?? {}).filter((k) => !allowed.includes(k))).toEqual([]);
      expect(
        Object.keys(table?.data ?? {}).filter(
          (k) => !['columns', 'rows', 'aggregates'].includes(k),
        ),
      ).toEqual([]);
      const text = JSON.stringify(item);
      for (const leak of [
        'APPNAME',
        'TAGSECRET',
        'SUMMARYSECRET',
        'visibility',
        'audience',
        'draft',
        b.teamPage,
        b.adminPage,
        b.teamFile,
      ]) {
        expect(text, leak).not.toContain(leak);
      }
      expect(table?.data.columns).toEqual([
        { id: 'c1', name: 'Name', type: 'text' },
        { id: 'c2', name: 'Link', type: 'url' },
      ]);
      expect(table?.data.rows.map((r) => r.cells)).toEqual([
        { c1: 'plain value', c2: 'Private item' },
        { c1: 'Private item', c2: `/n/${b.clientPage2}` },
        { c1: 'Private item' },
      ]);
      expect(table?.rowCount).toBe(3);
    } finally {
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${t.id}`);
    }
  });

  it('one readable-ids query answers client items of this brain only', async () => {
    const ids = await client(() =>
      cs.clientReadableIds(brain, [b.clientPage2, b.teamPage, b.adminFile, s.teamDraft, 'x']),
    );
    expect([...ids]).toEqual([b.clientPage2]);
  });

  it('file bytes: a client file is served, a team or admin file never', async () => {
    const got = await client(() => files.openFileById({ ownerId: brain, fileId: b.clientFile }));
    expect(got?.size).toBe('CLIENT BYTES'.length);
    got?.stream.destroy();
    for (const id of [b.teamFile, b.adminFile]) {
      expect(await client(() => files.openFileById({ ownerId: brain, fileId: id })), id).toBeNull();
      expect(await client(() => files.readFileById({ ownerId: brain, fileId: id })), id).toBeNull();
      expect(await client(() => files.fileById({ ownerId: brain, fileId: id })), id).toBeNull();
    }
  });

  it('a client drawing keeps its client image only; a team drawing is a miss', async () => {
    const ids = await client(() => cd.clientVisibleDrawFileIds(brain, b.clientDraw));
    expect([...ids]).toEqual(['sClient']);
    const svg = await client(async () => {
      const raw = await (await import('./draws')).getDrawSvg(brain, b.clientDraw);
      return raw ? cd.clientDrawSvg(brain, b.clientDraw, raw) : null;
    });
    expect(svg).toContain('Q0xJRU5U');
    expect(svg).not.toContain('VEVBTQ==');
    expect(svg).not.toContain('QURNSU4=');
    // Element links (audit B25): a link to an item the client may not read
    // loses its href, the element stays; readable and external links stay.
    expect(svg).not.toContain(b.teamPage);
    expect(svg).not.toContain(b.adminPage);
    expect(svg).toContain(`<a href="/n/${b.clientPage2}">`);
    expect(svg).toContain('<a href="https://example.invalid/">');
    expect(svg).toContain('<a><path d="M1"/></a>');
    expect(
      await client(async () => (await import('./draws')).getDrawSvg(brain, b.teamDraw)),
    ).toBeNull();
  });

  it('the member Library lists team and client items with their level, never admin or public; opens a public one by id', async () => {
    const { items } = await m.withViewer('team', () => lib.listLibrary(brain, { q: tag }));
    const byId = new Map(items.map((i) => [i.id, i.audience]));
    expect([...byId.keys()].sort()).toEqual(
      [
        b.clientPage,
        b.clientPage2,
        b.clientNote,
        b.clientFile,
        b.clientDraw,
        b.teamPage,
        b.teamFile,
        b.teamDraw,
      ].sort(),
    );
    expect(byId.get(b.teamPage)).toBe('team');
    expect(byId.get(b.clientNote)).toBe('client');
    const counts = await m.withViewer('team', () => lib.libraryCounts(brain));
    expect(counts.page).toBeGreaterThanOrEqual(3);
    // A public item is not listed, but a member opens it by id (audit B10).
    expect((await m.withViewer('team', () => lib.getLibraryItem(brain, b.publicNote)))?.id).toBe(
      b.publicNote,
    );
    expect(await m.withViewer('team', () => lib.getLibraryItem(brain, b.adminPage))).toBeNull();
    expect(
      (await m.withViewer('team', () => lib.getLibraryItem(brain, b.clientNote)))?.audience,
    ).toBe('client');
  });
});
