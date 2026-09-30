/**
 * What a member wrote and an admin accepted, on a real, migrated Postgres
 * (member logins Phase 4, plan 6.2 and 6.3): the author's own list of
 * accepted items, read access to each one's SAVED version whatever its level
 * (never an admin's draft), nobody else's items, and the author's name for
 * the member-authored badge.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/member-accepted.viewer.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('member accepted items', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sp: typeof import('./member-space');
  let sf: typeof import('./member-space-files');
  let rv: typeof import('./member-review');
  let ma: typeof import('./member-accepted');
  let fp: typeof import('@mantle/files');
  let td: typeof import('./tables/draft');
  let pd: typeof import('./pages/draft');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `maccept-${randomUUID().slice(0, 8)}`;
  const loginA = randomUUID();
  const loginB = randomUUID();
  const spaceOf: Record<string, string> = {};
  let anchor: string;
  let otherBrain: string;
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-accepted-'));
  const reviewer = () => ({ loginId: anchor, name: 'Reviewer' });
  const moved: string[] = [];

  const as = <T>(login: string, fn: () => Promise<T>) =>
    m.withSpace({ spaceId: spaceOf[login]!, loginId: login }, fn);
  const spool = (text: string) =>
    fp.spoolUpload(Readable.from([Buffer.from(text)]), {
      maxBytes: sf.SPACE_FILE_MAX_BYTES,
      dir: fp.spaceSpoolDir(),
    });
  const submitAndAccept = async (login: string, id: string, audience?: 'admin' | 'team') => {
    await as(login, () => sp.submitItem(spaceOf[login]!, id));
    await rv.acceptReviewItem(anchor, id, reviewer(), audience ? { audience } : {});
    moved.push(id);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.MANTLE_SPACES_ROOT = path.join(root, 'spaces');
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    sp = await import('./member-space');
    sf = await import('./member-space-files');
    rv = await import('./member-review');
    ma = await import('./member-accepted');
    fp = await import('@mantle/files');
    td = await import('./tables/draft');
    pd = await import('./pages/draft');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);

    // A brain of this test's own (never mantle_brain_id(): test files run in
    // parallel), plus a second brain to prove the rule names this one.
    anchor = randomUUID();
    otherBrain = randomUUID();
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${anchor}, ${`${tag}-admin@example.invalid`}, 'x', 'admin'),
        (${otherBrain}, ${`${tag}-other@example.invalid`}, 'x', 'admin')`);
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values
        (${anchor}, 'brain', ${anchor}), (${otherBrain}, 'brain', ${otherBrain})`);
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${loginA}, ${`${tag}-a@example.invalid`}, 'x', 'member', 'Ann Author'),
        (${loginB}, ${`${tag}-b@example.invalid`}, 'x', 'member', null)`);
    const rows = (await m.systemDb.execute(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${loginA}, ${loginB})`)) as unknown as { id: string; login_id: string }[];
    for (const r of rows) spaceOf[r.login_id] = r.id;
  });

  afterAll(async () => {
    for (const id of moved) await m.systemDb.execute(sqlTag`delete from nodes where id = ${id}`);
    for (const s of Object.values(spaceOf)) {
      await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${s}`);
      await m.systemDb.execute(sqlTag`delete from spaces where id = ${s}`);
    }
    await m.systemDb.execute(sqlTag`delete from auth.users where id in (${loginA}, ${loginB})`);
    for (const b of [anchor, otherBrain]) {
      await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${b}`);
      await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${b}`);
      await m.systemDb.execute(sqlTag`delete from auth.users where id = ${b}`);
    }
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  let pageId: string;
  let fileId: string;
  let drawId: string;
  let tableId: string;
  let noteTeamId: string;
  let draftId: string;
  let bNoteId: string;

  it('accepts some of A’s items at admin and one at team; B’s one; one of A’s stays a draft', async () => {
    const A = spaceOf[loginA]!;
    const B = spaceOf[loginB]!;
    fileId = await as(loginA, async () =>
      sf.createMineFile(A, { filename: 'Figure.png', spooled: await spool('FIGUREBYTES') }),
    );
    pageId = (await as(loginA, () => sp.createMineItem(A, { type: 'page', title: `${tag} p` }))).id;
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'author words' }] }],
    };
    expect((await as(loginA, () => sp.saveMinePage(A, pageId, doc))).ok).toBe(true);

    const t = await as(loginA, () => sp.createMineItem(A, { type: 'table', title: `${tag} t` }));
    tableId = t.id;
    const got = await as(loginA, () => sp.getMineItem(A, tableId));
    const col = got?.body.type === 'table' ? got.body.table.data.columns[0]!.id : '';
    await as(loginA, () =>
      td.applyTableOps(A, tableId, [{ op: 'row_add', cells: { [col]: 'author cell' } }]),
    );
    await as(loginA, () => sp.saveMineTable(A, tableId));

    drawId = (await as(loginA, () => sp.createMineItem(A, { type: 'draw', title: `${tag} dr` })))
      .id;
    const drew = await as(loginA, () =>
      sp.saveMineDraw(
        A,
        drawId,
        { elements: [{ id: 'e1', type: 'rectangle' }] },
        { svg: '<svg xmlns="http://www.w3.org/2000/svg"><!-- AUTHORSVG --></svg>' },
      ),
    );
    expect(drew.ok).toBe(true);

    noteTeamId = (
      await as(loginA, () => sp.createMineItem(A, { type: 'note', title: `${tag} team note` }))
    ).id;
    draftId = (await as(loginA, () => sp.createMineItem(A, { type: 'note', title: `${tag} d` })))
      .id;
    bNoteId = (await as(loginB, () => sp.createMineItem(B, { type: 'note', title: `${tag} b` })))
      .id;

    await submitAndAccept(loginA, pageId);
    await submitAndAccept(loginA, fileId);
    await submitAndAccept(loginA, drawId);
    await submitAndAccept(loginA, tableId);
    await submitAndAccept(loginA, noteTeamId, 'team');
    await submitAndAccept(loginB, bNoteId);
  });

  it('lists exactly the author’s accepted items, with the level the admin chose', async () => {
    const res = await ma.listAccepted(anchor, loginA);
    expect(res.total).toBe(5);
    expect(res.items.map((i) => i.id).sort()).toEqual(
      [pageId, fileId, drawId, tableId, noteTeamId].sort(),
    );
    const levels = Object.fromEntries(res.items.map((i) => [i.id, i.audience]));
    expect(levels[pageId]).toBe('admin');
    expect(levels[noteTeamId]).toBe('team');
    expect(res.items.every((i) => i.acceptedAt)).toBe(true);
    // Never a draft, never another login's item.
    expect(res.items.map((i) => i.id)).not.toContain(draftId);
    expect(res.items.map((i) => i.id)).not.toContain(bNoteId);
    // B sees only B's; the kind filter narrows.
    expect((await ma.listAccepted(anchor, loginB)).items.map((i) => i.id)).toEqual([bNoteId]);
    expect(
      (await ma.listAccepted(anchor, loginA, { kind: 'note' })).items.map((i) => i.id),
    ).toEqual([noteTeamId]);
    // The title search.
    expect(
      (await ma.listAccepted(anchor, loginA, { q: 'team note' })).items.map((i) => i.id),
    ).toEqual([noteTeamId]);
    expect((await ma.listAccepted(anchor, loginA, { q: '100%_' })).total).toBe(0);
    // The rule names this brain.
    expect((await ma.listAccepted(otherBrain, loginA)).total).toBe(0);
  });

  it('narrows by level and orders by the row time for the one list', async () => {
    const above = await ma.listAccepted(anchor, loginA, {
      outside: ['team', 'client'],
      order: 'updated',
    });
    expect(above.items.map((i) => i.id)).not.toContain(noteTeamId);
    expect(above.items.every((i) => i.audience === 'admin' || i.audience === 'public')).toBe(true);
    expect(above.total).toBe(above.items.length);
    const times = above.items.map((i) => i.updatedAt);
    expect(times).toEqual([...times].sort().reverse());
    // byMe: exactly the ids this login wrote, of the ids asked about.
    const mine = await ma.acceptedByLogin(anchor, loginA, [noteTeamId, bNoteId, draftId]);
    expect([...mine]).toEqual([noteTeamId]);
    expect((await ma.acceptedByLogin(anchor, loginA, [])).size).toBe(0);
  });

  it('the author reads the SAVED version at admin, never an admin’s draft', async () => {
    // The admin works on both after Accept: drafts only, nothing committed.
    await pd.saveDraft(anchor, pageId, {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'admin draft words' }] }],
    });
    const brainTable = await (await import('./tables/read')).getTable(anchor, tableId);
    const col = brainTable!.data.columns[0]!.id;
    await td.applyTableOps(anchor, tableId, [
      { op: 'row_add', cells: { [col]: 'admin draft cell' } },
    ]);

    const page = await ma.getAcceptedItem(anchor, loginA, pageId);
    expect(page?.type).toBe('page');
    expect(JSON.stringify(page)).toContain('author words');
    expect(JSON.stringify(page)).not.toContain('admin draft words');

    const table = await ma.getAcceptedItem(anchor, loginA, tableId);
    expect(table?.type === 'table' && table.table.draft).toBeNull();
    expect(JSON.stringify(table)).toContain('author cell');
    expect(JSON.stringify(table)).not.toContain('admin draft cell');

    expect(await ma.acceptedDrawSvg(anchor, loginA, drawId)).toContain('AUTHORSVG');

    const file = await ma.getAcceptedItem(anchor, loginA, fileId);
    expect(file).toMatchObject({ type: 'file', filename: 'figure.png', audience: 'admin' });
    expect(await ma.isAuthorOfAcceptedFile(anchor, loginA, fileId)).toBe(true);
  });

  // Audit F07, option A: the author reads the snapshot taken at Accept.
  it('the author reads the version ACCEPTED: an admin’s later SAVED edits stay the brain’s', async () => {
    const say = (text: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    expect((await pd.commitPage(anchor, pageId, say('admin saved words'))).ok).toBe(true);
    await td.commitTable(anchor, tableId); // the admin's draft cell, now saved
    const dr = await import('./draws');
    await dr.commitDraw(
      anchor,
      drawId,
      { elements: [{ id: 'e2', type: 'ellipse' }] },
      { svg: '<svg xmlns="http://www.w3.org/2000/svg"><!-- ADMINSVG --></svg>' },
    );
    const notes = await import('./notes');
    await notes.updateNote(anchor, noteTeamId, {
      title: 'Renamed by admin',
      content: 'admin note words',
    });
    // The brain has the admin's version...
    const brainPage = await (await import('./pages/read')).getPage(anchor, pageId);
    expect(JSON.stringify(brainPage?.doc)).toContain('admin saved words');

    // ...and the author still reads what was accepted.
    const page = await ma.getAcceptedItem(anchor, loginA, pageId);
    expect(JSON.stringify(page)).toContain('author words');
    expect(JSON.stringify(page)).not.toContain('admin saved words');
    const table = await ma.getAcceptedItem(anchor, loginA, tableId);
    expect(JSON.stringify(table)).toContain('author cell');
    expect(JSON.stringify(table)).not.toContain('admin draft cell');
    const svg = await ma.acceptedDrawSvg(anchor, loginA, drawId);
    expect(svg).toContain('AUTHORSVG');
    expect(svg).not.toContain('ADMINSVG');
    const note = await ma.getAcceptedItem(anchor, loginA, noteTeamId);
    expect(note?.type === 'note' && note.content).not.toContain('admin note words');
    expect(note?.title).toBe(`${tag} team note`);
    const listed = (await ma.listAccepted(anchor, loginA)).items.find((i) => i.id === noteTeamId);
    expect(listed?.title).toBe(`${tag} team note`);
    // The workbook copy the table is read from sits in the snapshots folder.
    const snaps = await import('./member-snapshots');
    expect(existsSync(snaps.snapshotTableAbs(tableId))).toBe(true);
  });

  it('a file an admin changed: the accepted metadata, changedByAdmin, and no bytes', async () => {
    const before = await ma.getAcceptedItem(anchor, loginA, fileId);
    expect(before?.type === 'file' && before.changedByAdmin).toBeFalsy();
    expect(await ma.acceptedFileReadable(anchor, loginA, fileId)).toBe(true);

    // An admin replaces the brain file's bytes (and the node records it).
    const [n] = (await m.systemDb.execute(
      sqlTag`select path::text as path, data from nodes where id = ${fileId}`,
    )) as unknown as { path: string; data: Record<string, unknown> }[];
    const disk = fp.diskPathForFile(n!.path, String(n!.data.filename))!;
    writeFileSync(disk, 'ADMIN REPLACED BYTES');
    const sha = createHash('sha256').update('ADMIN REPLACED BYTES').digest('hex');
    await m.systemDb.execute(
      sqlTag`update nodes set data = data || jsonb_build_object('sha256', ${sha}::text)
              where id = ${fileId}`,
    );
    const after = await ma.getAcceptedItem(anchor, loginA, fileId);
    expect(after).toMatchObject({ type: 'file', filename: 'figure.png', changedByAdmin: true });
    expect(await ma.acceptedFileReadable(anchor, loginA, fileId)).toBe(false);
    // Still the author's accepted file (their own drawing's snapshot keeps it).
    expect(await ma.isAuthorOfAcceptedFile(anchor, loginA, fileId)).toBe(true);
  });

  it('nobody else reads them: another member, a draft, another brain, a wrong kind', async () => {
    expect(await ma.getAcceptedItem(anchor, loginB, pageId)).toBeNull();
    expect(await ma.acceptedDrawSvg(anchor, loginB, drawId)).toBeNull();
    expect(await ma.isAuthorOfAcceptedFile(anchor, loginB, fileId)).toBe(false);
    expect(await ma.getAcceptedItem(anchor, loginA, bNoteId)).toBeNull();
    expect(await ma.getAcceptedItem(anchor, loginA, draftId)).toBeNull();
    expect(await ma.getAcceptedItem(otherBrain, loginA, pageId)).toBeNull();
    expect(await ma.getAcceptedItem(anchor, loginA, randomUUID())).toBeNull();
    // Not a file / not a drawing: the asset routes' checks say no.
    expect(await ma.isAuthorOfAcceptedFile(anchor, loginA, pageId)).toBe(false);
    expect(await ma.acceptedDrawSvg(anchor, loginA, fileId)).toBeNull();
  });

  it('a returned item is not accepted: it is not listed or readable here', async () => {
    const A = spaceOf[loginA]!;
    await as(loginA, () => sp.submitItem(A, draftId));
    await rv.returnReviewItem(draftId, reviewer(), 'Not yet.');
    expect((await ma.listAccepted(anchor, loginA)).items.map((i) => i.id)).not.toContain(draftId);
    expect(await ma.getAcceptedItem(anchor, loginA, draftId)).toBeNull();
  });

  it('only an ACCEPTED row counts, even for an item already in the brain', async () => {
    // Not a state Accept leaves behind; the rule must hold on its own anyway.
    await m.systemDb.execute(
      sqlTag`update space_items set review_state = 'submitted' where node_id = ${noteTeamId}`,
    );
    try {
      expect((await ma.listAccepted(anchor, loginA)).items.map((i) => i.id)).not.toContain(
        noteTeamId,
      );
      expect(await ma.getAcceptedItem(anchor, loginA, noteTeamId)).toBeNull();
    } finally {
      await m.systemDb.execute(
        sqlTag`update space_items set review_state = 'accepted' where node_id = ${noteTeamId}`,
      );
    }
  });

  it('refuses to run inside a viewer scope (the rule needs the admin pool)', async () => {
    await expect(m.withViewer('team', () => ma.listAccepted(anchor, loginA))).rejects.toThrow(
      /admin pool/,
    );
    await expect(
      m.withViewer('team', () => ma.getAcceptedItem(anchor, loginA, pageId)),
    ).rejects.toThrow(/admin pool/);
  });

  it('names the author for the member-authored badge; an admin’s own item has none', async () => {
    const own = await (
      await import('./notes')
    ).createNote(anchor, { title: `${tag} admin note`, content: 'x' });
    const authors = await ma.acceptedAuthors(anchor, [pageId, noteTeamId, bNoteId, own.id]);
    expect(authors.get(pageId)?.name).toBe('Ann Author');
    expect(authors.get(noteTeamId)?.acceptedAt).toBeTruthy();
    expect(authors.get(bNoteId)?.name).toBe('A member'); // no display name, never the email
    expect(authors.get(pageId)?.role).toBe('member');
    expect(authors.has(own.id)).toBe(false);
    // A returned item has a row but was never accepted: no badge.
    expect((await ma.acceptedAuthors(spaceOf[loginA]!, [draftId])).size).toBe(0);
    expect((await ma.acceptedAuthors(otherBrain, [pageId])).size).toBe(0);
  });

  it('an author who is a client is labelled a client, never "A member" (audit B26)', async () => {
    // Clients author nothing yet (C5): a member login turned client stands in.
    await m.systemDb.execute(sqlTag`update auth.users set role = 'client' where id = ${loginB}`);
    try {
      const got = (await ma.acceptedAuthors(anchor, [bNoteId])).get(bNoteId);
      expect(got).toMatchObject({ name: 'A client', role: 'client' });
    } finally {
      await m.systemDb.execute(sqlTag`update auth.users set role = 'member' where id = ${loginB}`);
    }
    expect((await ma.acceptedAuthors(anchor, [bNoteId])).get(bNoteId)?.role).toBe('member');
  });

  it('a deleted login leaves the badge as "Removed member" and loses its list', async () => {
    await m.systemDb.execute(sqlTag`delete from auth.users where id = ${loginB}`);
    const authors = await ma.acceptedAuthors(anchor, [bNoteId]);
    expect(authors.get(bNoteId)?.name).toBe('Removed member');
    expect(authors.get(bNoteId)?.role).toBeNull();
    expect((await ma.listAccepted(anchor, loginB)).total).toBe(0);
  });
});
