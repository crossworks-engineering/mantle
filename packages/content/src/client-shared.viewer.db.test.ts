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
          { type: 'mention', attrs: { id: b.clientPage2, label: 'Shared two', ref: 'node' } },
        ],
      },
      { type: 'image', attrs: { nodeId: b.teamFile, alt: 'TEAMFILE alt' } },
      { type: 'childPage', attrs: { pageId: b.teamPage, title: 'TEAMTITLE child' } },
      { type: 'image', attrs: { nodeId: b.clientFile, alt: 'client picture' } },
    ],
  };
  const sym = (id: string, bytes: string) =>
    `<symbol id="image-${id}"><image href="data:image/png;base64,${bytes}"></image></symbol>`;
  const drawSvg = `<svg xmlns="http://www.w3.org/2000/svg"><defs>${sym('sClient', 'Q0xJRU5U')}${sym('sTeam', 'VEVBTQ==')}${sym('sAdmin', 'QURNSU4=')}</defs></svg>`;

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
        (${b.clientPage}, ${JSON.stringify(clientDoc)}::jsonb, '', ${JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'DRAFT SECRET' }] }] })}::jsonb),
        (${b.clientPage2}, ${empty}::jsonb, '', null),
        (${b.teamPage}, ${empty}::jsonb, '', null),
        (${b.adminPage}, ${empty}::jsonb, '', null),
        (${s.teamDraft}, ${empty}::jsonb, '', null)`);
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

  it('rows carry only the named fields: no author, no level, no staff id', async () => {
    const { items } = await client(() => cs.listClientShared(brain, { q: tag }));
    for (const i of items) {
      expect(Object.keys(i).sort()).toEqual(
        ['icon', 'id', 'summary', 'title', 'type', 'updatedAt'].sort(),
      );
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
    // Two chips and one link relabelled; the readable chip and image stay.
    expect(text.split('Private item').length - 1).toBe(3);
    expect(text).toContain('Shared two');
    expect(text).toContain(b.clientPage2);
    expect(text).toContain(b.clientFile);
    expect(Object.keys(item!).sort()).toEqual(
      ['doc', 'icon', 'id', 'summary', 'title', 'type', 'updatedAt'].sort(),
    );
  });

  it('a client note links a team item as "Private item" and drops its image', async () => {
    const item = await client(() => cs.getClientSharedItem(brain, b.clientNote));
    expect(item?.type).toBe('note');
    const content = item && item.type === 'note' ? item.content : '';
    expect(content).toBe(`See Private item and [ok link](/n/${b.clientPage2}).\n\n`);
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
    expect(
      await client(async () => (await import('./draws')).getDrawSvg(brain, b.teamDraw)),
    ).toBeNull();
  });

  it('the member Library lists team and client items with their level, never admin or public', async () => {
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
    expect(await m.withViewer('team', () => lib.getLibraryItem(brain, b.publicNote))).toBeNull();
    expect(await m.withViewer('team', () => lib.getLibraryItem(brain, b.adminPage))).toBeNull();
    expect(
      (await m.withViewer('team', () => lib.getLibraryItem(brain, b.clientNote)))?.audience,
    ).toBe('client');
  });
});
