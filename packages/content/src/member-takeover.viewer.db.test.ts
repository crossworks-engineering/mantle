/**
 * Take over (audit F07, Jason 2026-09-28) on a real, migrated Postgres: an
 * admin takes a submitted member item and its bundle into their OWN private
 * space (same ids, re-owned in every owner-copy table, bytes moved, nothing
 * indexed), nobody else reads it there, the member sees it only as
 * `with-admin`, the admin edits it and accepts it (the author row stays, the
 * extractor is told once per moved item, the author's snapshot is the
 * version accepted) or gives it back (the member's again, returned with the
 * note; refused while it uses what the member may not see). The purge never
 * deletes a taken item, and a taken item whose admin is deactivated goes
 * back to the Review queue for another admin. The title an item had when it
 * was first taken (`taken_title`, audit L6) survives a retake by another
 * admin and is cleared by a give back.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/member-takeover.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('take over a submitted member item', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sp: typeof import('./member-space');
  let sf: typeof import('./member-space-files');
  let rv: typeof import('./member-review');
  let tk: typeof import('./member-takeover');
  let ma: typeof import('./member-accepted');
  let pg: typeof import('./member-space-purge');
  let fp: typeof import('@mantle/files');
  let td: typeof import('./tables/draft');
  let sqlTag: typeof import('drizzle-orm').sql;
  let unlisten: () => Promise<void>;
  const announced: string[] = [];
  const tag = `mtake-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const adminA = randomUUID();
  const adminB = randomUUID();
  const member = randomUUID();
  const member2 = randomUUID();
  const logins = [adminA, adminB, member, member2];
  const spaceOf: Record<string, string> = {};
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-takeover-'));
  const moved: string[] = [];

  const as = <T>(login: string, fn: () => Promise<T>) =>
    m.withSpace({ spaceId: spaceOf[login]!, loginId: login }, fn);
  const exec = async <T>(q: ReturnType<typeof sqlTag>) =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const ownerOf = async (id: string) =>
    (await exec<{ owner_id: string }>(sqlTag`select owner_id from nodes where id = ${id}`))[0]
      ?.owner_id;
  const rowOf = async (id: string) =>
    (
      await exec<{
        review_state: string;
        author_login_id: string | null;
        taken_by: string | null;
        taken_root: string | null;
        reviewed_by: string | null;
        returned_note: string | null;
        sharing: string;
        taken_title: string | null;
      }>(sqlTag`select review_state, author_login_id, taken_by, taken_root, reviewed_by,
                       returned_note, sharing, taken_title
                  from space_items where node_id = ${id}`)
    )[0];
  const spool = (text: string) =>
    fp.spoolUpload(Readable.from([Buffer.from(text)]), {
      maxBytes: sf.SPACE_FILE_MAX_BYTES,
      dir: fp.spaceSpoolDir(),
    });
  const say = (text: string, extra: unknown[] = []) => ({
    type: 'doc',
    content: [...extra, { type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  const settle = () => new Promise((r) => setTimeout(r, 300));
  const actorA = () => ({ loginId: adminA, spaceId: spaceOf[adminA]! });
  const actorB = () => ({ loginId: adminB, spaceId: spaceOf[adminB]! });

  /** No row of any owner-copy table keeps `space` as owner of `ids`. */
  const noOwnerCopies = async (space: string, ids: string[]) => {
    const tablesWithOwner = await exec<{ table_name: string; has_node: boolean; has_id: boolean }>(
      sqlTag`
        select c.table_name,
               bool_or(k.column_name = 'node_id') as has_node,
               bool_or(k.column_name = 'id') as has_id
          from information_schema.columns c
          join information_schema.columns k
            on k.table_schema = c.table_schema and k.table_name = c.table_name
         where c.table_schema = 'public' and c.column_name = 'owner_id'
         group by c.table_name`,
    );
    expect(tablesWithOwner.length).toBeGreaterThan(5);
    for (const t of tablesWithOwner) {
      const col = t.has_node ? 'node_id' : t.has_id ? 'id' : null;
      if (!col) continue;
      const [r] = await exec<{ n: number }>(
        sqlTag`select count(*)::int as n from ${sqlTag.identifier(t.table_name)}
                where owner_id::text = ${space}
                  and ${sqlTag.identifier(col)}::text in (${sqlTag.join(
                    ids.map((i) => sqlTag`${i}`),
                    sqlTag`, `,
                  )})`,
      );
      expect(r?.n, t.table_name).toBe(0);
    }
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
    tk = await import('./member-takeover');
    ma = await import('./member-accepted');
    pg = await import('./member-space-purge');
    fp = await import('@mantle/files');
    td = await import('./tables/draft');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    const sub = await admin.listen('node_ingested', (id: string) => announced.push(id));
    unlisten = () => sub.unlisten();

    // A brain of this test's own (never mantle_brain_id(): test files run in
    // parallel), two admins who are not the anchor, and two members.
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${anchor}, ${`${tag}-anchor@example.invalid`}, 'x', 'admin', null),
        (${adminA}, ${`${tag}-a@example.invalid`}, 'x', 'admin', null),
        (${adminB}, ${`${tag}-b@example.invalid`}, 'x', 'admin', null),
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member', 'Mia Member'),
        (${member2}, ${`${tag}-n@example.invalid`}, 'x', 'member', null)`);
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`);
    const rows = await exec<{ id: string; login_id: string }>(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${adminA}, ${adminB}, ${member}, ${member2})`);
    for (const r of rows) spaceOf[r.login_id] = r.id;
  });

  afterAll(async () => {
    await unlisten();
    for (const id of moved) await m.systemDb.execute(sqlTag`delete from nodes where id = ${id}`);
    for (const s of Object.values(spaceOf)) {
      await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${s}`);
      await m.systemDb.execute(sqlTag`delete from spaces where id = ${s}`);
    }
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${anchor}`);
    await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${anchor}`);
    for (const l of [anchor, ...logins]) {
      await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${l}`);
      await m.systemDb.execute(sqlTag`delete from auth.users where id = ${l}`);
    }
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  let pageId: string; // the member's page, submitted
  let imageId: string; // the member's image the page shows (its bundle)
  let secretId: string; // a brain item at admin level

  it('takes a submitted item and its bundle into the acting admin’s own space', async () => {
    const M = spaceOf[member]!;
    const A = spaceOf[adminA]!;
    const { createNote } = await import('./notes');
    secretId = (await createNote(anchor, { title: `${tag} secret`, content: 'admin only' })).id;
    imageId = await as(member, async () =>
      sf.createMineFile(M, { filename: 'Photo.png', spooled: await spool('MEMBERPNG') }),
    );
    pageId = (await as(member, () => sp.createMineItem(M, { type: 'page', title: `${tag} p` }))).id;
    const img = { type: 'image', attrs: { nodeId: imageId } };
    expect(
      (await as(member, () => sp.saveMinePage(M, pageId, say('member words', [img])))).ok,
    ).toBe(true);
    await as(member, () => sp.setSharing(M, pageId, 'team'));
    await as(member, () => sp.submitItem(M, pageId));
    expect((await rv.listReviewQueue()).items.map((i) => i.id)).toContain(pageId);

    const res = await rv.takeOverReviewItem(pageId, actorA());
    expect(res.moved.map((b) => b.id)).toEqual([pageId, imageId]);
    for (const id of [pageId, imageId]) expect(await ownerOf(id)).toBe(A);
    expect(await rowOf(pageId)).toMatchObject({
      review_state: 'taken',
      author_login_id: member,
      taken_by: adminA,
      taken_root: null,
      sharing: 'private',
      taken_title: `${tag} p`,
    });
    expect(await rowOf(imageId)).toMatchObject({
      review_state: 'taken',
      author_login_id: member,
      taken_root: pageId,
    });
    // The bytes moved with the file.
    expect(readFileSync(fp.spaceFilePath(A, imageId), 'utf8')).toBe('MEMBERPNG');
    expect(existsSync(fp.spaceFilePath(M, imageId))).toBe(false);
    // The recorded bundle is cleared; the queue no longer lists it.
    const [b] = await exec<{ n: number }>(
      sqlTag`select count(*)::int as n from space_item_bundles where root_id = ${pageId}`,
    );
    expect(b?.n).toBe(0);
    expect((await rv.listReviewQueue()).items.map((i) => i.id)).not.toContain(pageId);
    expect(await rv.getReviewItem(pageId)).toBeNull();
    await noOwnerCopies(M, [pageId, imageId]);
  });

  it('a second Take over (another admin, or the same) finds nothing', async () => {
    await expect(rv.takeOverReviewItem(pageId, actorB())).rejects.toMatchObject({
      reason: 'not-found',
    });
    await expect(rv.acceptReviewItem(anchor, pageId, { loginId: adminB })).rejects.toMatchObject({
      reason: 'not-found',
    });
  });

  it('nothing was announced, indexed or chunked', async () => {
    await settle();
    expect(announced.filter((id) => [pageId, imageId].includes(id))).toEqual([]);
    const [c] = await exec<{ n: number }>(
      sqlTag`select count(*)::int as n from content_chunks where node_id in (${pageId}, ${imageId})`,
    );
    expect(c?.n).toBe(0);
  });

  it('nobody else reads it: not another admin, not a teammate, not the member', async () => {
    const B = spaceOf[adminB]!;
    const M = spaceOf[member]!;
    expect(await as(adminB, () => sp.getMineItem(B, pageId))).toBeNull();
    expect(await m.withTeamDrafts(() => sp.getTeamDraftItem(pageId))).toBeNull();
    expect(await as(member2, () => sp.getMineRow(spaceOf[member2]!, pageId))).toBeNull();
    // The member: not in their space, but listed as with-admin, title and
    // kind only, and every item route answers `with-admin`.
    expect(await as(member, () => sp.getMineItem(M, pageId))).toBeNull();
    const list = await as(member, () => sp.listMine(M, { withAdmin: true }));
    const held = list.items.filter((i) => i.reviewState === 'with-admin');
    expect(held.map((i) => i.id).sort()).toEqual([pageId, imageId].sort());
    expect(held.find((i) => i.id === pageId)).toMatchObject({
      type: 'page',
      title: `${tag} p`,
      icon: null,
      returnedNote: null,
    });
    expect(Object.keys(held[0]!).sort()).toEqual(
      [
        'authorLoginId',
        'icon',
        'id',
        'returnedNote',
        'reviewState',
        'sharing',
        'submittedAt',
        'title',
        'type',
        'updatedAt',
      ].sort(),
    );
    // A review filter without with-admin leaves them out.
    const drafts = await as(member, () =>
      sp.listMine(M, { withAdmin: true, reviewStates: ['draft'] }),
    );
    expect(drafts.items.map((i) => i.id)).not.toContain(pageId);
    expect(await sp.isWithAdmin(member, pageId)).toBe(true);
    expect(await sp.isWithAdmin(member2, pageId)).toBe(false);
    // Recall is refused (the route turns this into 409 `with-admin`).
    await expect(as(member, () => sp.recallItem(M, pageId))).rejects.toMatchObject({
      reason: 'not-found',
    });
    expect(sp.withAdminError().reason).toBe('with-admin');
  });

  it('the admin sees it in their private list, marked as taken from the member', async () => {
    const A = spaceOf[adminA]!;
    const list = await as(adminA, () => sp.listMine(A));
    expect(list.items.find((i) => i.id === pageId)?.reviewState).toBe('taken');
    const from = await tk.takenFromOf(A, [pageId, imageId]);
    expect(from.get(pageId)).toMatchObject({
      loginId: member,
      name: 'Mia Member',
      canGiveBack: true,
    });
    // Another admin's space names nothing.
    expect((await tk.takenFromOf(spaceOf[adminB]!, [pageId])).size).toBe(0);
  });

  it('give back is refused while it uses what the member may not see, or has unsaved edits', async () => {
    const A = spaceOf[adminA]!;
    const writer = { adminOfBrain: anchor };
    const img = { type: 'image', attrs: { nodeId: imageId } };
    const secret = {
      type: 'paragraph',
      content: [{ type: 'mention', attrs: { id: secretId, ref: 'node' } }],
    };
    expect(
      (
        await as(adminA, () =>
          sp.saveMinePage(A, pageId, say('admin words', [img, secret]), writer),
        )
      ).ok,
    ).toBe(true);
    await expect(
      tk.giveBackTakenItem(anchor, actorA(), pageId, 'Please fix'),
    ).rejects.toMatchObject({ reason: 'embed', ids: [secretId] });
    const draft = await import('./pages/draft');
    await as(adminA, () => draft.saveDraft(A, pageId, say('unsaved admin words', [img])));
    await expect(
      tk.giveBackTakenItem(anchor, actorA(), pageId, 'Please fix'),
    ).rejects.toMatchObject({ reason: 'unsaved-draft', ids: [pageId] });
    // Another admin cannot give it back.
    await expect(
      tk.giveBackTakenItem(anchor, actorB(), pageId, 'Please fix'),
    ).rejects.toMatchObject({ reason: 'not-found' });
    expect(
      (await as(adminA, () => sp.saveMinePage(A, pageId, say('admin fixed words', [img]), writer)))
        .ok,
    ).toBe(true);
  });

  it('give back returns it (and its bundle) to the member, editable, with the note', async () => {
    const M = spaceOf[member]!;
    const res = await tk.giveBackTakenItem(anchor, actorA(), pageId, 'Add the dates.');
    expect(res.returned.map((b) => b.id)).toEqual([pageId, imageId]);
    for (const id of [pageId, imageId]) expect(await ownerOf(id)).toBe(M);
    expect(await rowOf(pageId)).toMatchObject({
      review_state: 'returned',
      returned_note: 'Add the dates.',
      reviewed_by: adminA,
      taken_by: null,
      author_login_id: member,
      // The title it was taken with goes with the hold (audit L6).
      taken_title: null,
    });
    expect(await rowOf(imageId)).toMatchObject({
      review_state: 'draft',
      taken_root: null,
      taken_title: null,
    });
    expect(readFileSync(fp.spaceFilePath(M, imageId), 'utf8')).toBe('MEMBERPNG');
    expect(existsSync(fp.spaceFilePath(spaceOf[adminA]!, imageId))).toBe(false);
    const got = await as(member, () => sp.getMineItem(M, pageId));
    expect(JSON.stringify(got?.body)).toContain('admin fixed words');
    await as(member, () => sp.assertEditable(M, pageId));
    expect(await sp.isWithAdmin(member, pageId)).toBe(false);
    await noOwnerCopies(spaceOf[adminA]!, [pageId, imageId]);
    await settle();
    expect(announced.filter((id) => [pageId, imageId].includes(id))).toEqual([]);
  });

  it('accept after Take over keeps the author row, announces once, and snapshots', async () => {
    const M = spaceOf[member]!;
    const A = spaceOf[adminA]!;
    await as(member, () => sp.submitItem(M, pageId));
    await rv.takeOverReviewItem(pageId, actorA());
    const img = { type: 'image', attrs: { nodeId: imageId } };
    expect(
      (
        await as(adminA, () =>
          sp.saveMinePage(A, pageId, say('admin accepted words', [img]), { adminOfBrain: anchor }),
        )
      ).ok,
    ).toBe(true);
    const res = await rv.acceptOwnItem(anchor, { spaceId: A, loginId: adminA }, pageId);
    moved.push(pageId, imageId);
    expect(res.moved.map((b) => b.id)).toEqual([pageId, imageId]);
    for (const id of [pageId, imageId]) {
      expect(await ownerOf(id)).toBe(anchor);
      expect(await rowOf(id)).toMatchObject({
        review_state: 'accepted',
        author_login_id: member,
        reviewed_by: adminA,
        taken_by: null,
      });
    }
    await settle();
    expect(announced.filter((id) => id === pageId)).toEqual([pageId]);
    expect(announced.filter((id) => id === imageId)).toEqual([imageId]);
    // The member lists it as accepted and reads the version accepted...
    expect((await ma.listAccepted(anchor, member)).items.map((i) => i.id)).toContain(pageId);
    const { commitPage } = await import('./pages/draft');
    expect((await commitPage(anchor, pageId, say('later brain words', [img]))).ok).toBe(true);
    const item = await ma.getAcceptedItem(anchor, member, pageId);
    expect(JSON.stringify(item)).toContain('admin accepted words');
    expect(JSON.stringify(item)).not.toContain('later brain words');
    // ...and the member-authored badge names them.
    expect((await ma.acceptedAuthors(anchor, [pageId])).get(pageId)?.name).toBe('Mia Member');
    expect(await sp.isWithAdmin(member, pageId)).toBe(false);
  });

  it('a table taken over moves its workbook, and its snapshot is the accepted table', async () => {
    const M = spaceOf[member]!;
    const A = spaceOf[adminA]!;
    const t = await as(member, () => sp.createMineItem(M, { type: 'table', title: `${tag} t` }));
    const got = await as(member, () => sp.getMineItem(M, t.id));
    const col = got?.body.type === 'table' ? got.body.table.data.columns[0]!.id : '';
    await as(member, () =>
      td.applyTableOps(M, t.id, [{ op: 'row_add', cells: { [col]: 'member cell' } }]),
    );
    await as(member, () => sp.saveMineTable(M, t.id));
    await as(member, () => sp.submitItem(M, t.id));
    await rv.takeOverReviewItem(t.id, actorA());
    const [row] = await exec<{ storage_path: string }>(
      sqlTag`select storage_path from tables where node_id = ${t.id}`,
    );
    expect(row?.storage_path).toBe(`${A}/${t.id}.sqlite`);
    expect(existsSync(path.join(root, 'table-dbs', M, `${t.id}.sqlite`))).toBe(false);
    await rv.acceptOwnItem(anchor, { spaceId: A, loginId: adminA }, t.id);
    moved.push(t.id);
    const item = await ma.getAcceptedItem(anchor, member, t.id);
    expect(JSON.stringify(item)).toContain('member cell');
  });

  it('an admin’s own item accepted with no author row stays unsnapshotted', async () => {
    const A = spaceOf[adminA]!;
    const own = await as(adminA, () =>
      sp.createMineItem(A, { type: 'note', title: `${tag} own`, content: 'mine' }),
    );
    await rv.acceptOwnItem(anchor, { spaceId: A, loginId: adminA }, own.id);
    moved.push(own.id);
    expect(await rowOf(own.id)).toBeUndefined();
    const [s] = await exec<{ n: number }>(
      sqlTag`select count(*)::int as n from accepted_snapshots where node_id = ${own.id}`,
    );
    expect(s?.n).toBe(0);
  });

  it('delete: refused while the member can take it back; give-back refused once they cannot', async () => {
    const N = spaceOf[member2]!;
    const A = spaceOf[adminA]!;
    const note = await as(member2, () =>
      sp.createMineItem(N, { type: 'note', title: `${tag} n2`, content: 'n2 words' }),
    );
    await as(member2, () => sp.submitItem(N, note.id));
    await rv.takeOverReviewItem(note.id, actorA());
    await expect(as(adminA, () => sp.deleteMineItem(A, note.id))).rejects.toMatchObject({
      reason: 'taken',
    });
    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = now() where id = ${member2}`,
    );
    await expect(
      tk.giveBackTakenItem(anchor, actorA(), note.id, 'Back to you'),
    ).rejects.toMatchObject({ reason: 'author-inactive' });
    expect((await tk.takenFromOf(A, [note.id])).get(note.id)?.canGiveBack).toBe(false);
    expect(await as(adminA, () => sp.deleteMineItem(A, note.id))).toBe(true);
    expect(await ownerOf(note.id)).toBeUndefined();
    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = null where id = ${member2}`,
    );
  });

  let heldId: string;

  it('the purge never deletes a taken item; a deactivated taker releases it to the queue', async () => {
    const M = spaceOf[member]!;
    const A = spaceOf[adminA]!;
    heldId = (
      await as(member, () =>
        sp.createMineItem(M, { type: 'note', title: `${tag} held`, content: 'held words' }),
      )
    ).id;
    await as(member, () => sp.submitItem(M, heldId));
    await rv.takeOverReviewItem(heldId, actorA());
    expect((await rowOf(heldId))?.taken_title).toBe(`${tag} held`);
    // Admin A renames it while it is theirs: the author's list keeps the
    // title it was taken with.
    await as(adminA, () =>
      sp.updateMineItem(A, heldId, { title: `${tag} ADMIN A title` }, { adminOfBrain: anchor }),
    );
    expect((await rowOf(heldId))?.taken_title).toBe(`${tag} held`);
    const ownPrivate = await as(adminA, () =>
      sp.createMineItem(A, { type: 'note', title: `${tag} a private` }),
    );
    // Admin A deactivated 40 days ago: A's own private item goes, the taken
    // item (the member's work) stays.
    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = now() - interval '40 days' where id = ${adminA}`,
    );
    await pg.purgeDeactivatedSpaces();
    expect(await ownerOf(ownPrivate.id)).toBeUndefined();
    expect(await ownerOf(heldId)).toBe(A);
    expect((await rowOf(heldId))?.review_state).toBe('taken');

    // Released: the queue offers it again, as submitted, and counts it.
    const q = await rv.listReviewQueue();
    expect(q.items.find((i) => i.id === heldId)).toMatchObject({
      reason: 'submitted',
      reviewState: 'taken',
    });
    expect(await rv.countSubmitted()).toBeGreaterThanOrEqual(1);
    const read = await rv.getReviewItem(heldId);
    expect(read?.body.type === 'note' && read.body.note.content).toBe('held words');

    // Another admin takes it over from A's space.
    const B = spaceOf[adminB]!;
    const res = await rv.takeOverReviewItem(heldId, actorB());
    expect(res.moved.map((b) => b.id)).toEqual([heldId]);
    expect(await ownerOf(heldId)).toBe(B);
    // Taken again under A's title: the FIRST recorded title stays (audit L6),
    // never admin A's working title.
    expect(await rowOf(heldId)).toMatchObject({
      review_state: 'taken',
      taken_by: adminB,
      taken_title: `${tag} held`,
    });
    const [live] = await exec<{ title: string }>(
      sqlTag`select title from nodes where id = ${heldId}`,
    );
    expect(live?.title).toBe(`${tag} ADMIN A title`);
    expect((await sp.listWithAdmin(member, {})).find((r) => r.id === heldId)?.title).toBe(
      `${tag} held`,
    );
    expect((await rv.listReviewQueue()).items.map((i) => i.id)).not.toContain(heldId);
    await m.systemDb.execute(sqlTag`update auth.users set disabled_at = null where id = ${adminA}`);
  });

  it('a released item can be returned from the queue: a give-back to the member', async () => {
    const M = spaceOf[member]!;
    // B is deactivated now: released again, and returned by the anchor.
    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = now() where id = ${adminB}`,
    );
    await rv.returnReviewItem(heldId, { loginId: anchor }, 'Over to you again.', anchor);
    expect(await ownerOf(heldId)).toBe(M);
    expect(await rowOf(heldId)).toMatchObject({
      review_state: 'returned',
      returned_note: 'Over to you again.',
      reviewed_by: anchor,
      taken_title: null,
    });
    await m.systemDb.execute(sqlTag`update auth.users set disabled_at = null where id = ${adminB}`);
    await settle();
    expect(announced).not.toContain(heldId);
  });

  it('a left-behind item that was never submitted cannot be taken over', async () => {
    const N = spaceOf[member2]!;
    const shared = await as(member2, () =>
      sp.createMineItem(N, { type: 'note', title: `${tag} lb`, content: 'x' }),
    );
    await as(member2, () => sp.setSharing(N, shared.id, 'team'));
    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = now() where id = ${member2}`,
    );
    await expect(rv.takeOverReviewItem(shared.id, actorA())).rejects.toMatchObject({
      reason: 'not-submitted',
    });
    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = null where id = ${member2}`,
    );
  });

  it('a missing or pending snapshot is completed from the brain on the author’s first read', async () => {
    // As for an item accepted before migration 0183 (or by older code).
    await m.systemDb.execute(sqlTag`delete from accepted_snapshots where node_id = ${pageId}`);
    const item = await ma.getAcceptedItem(anchor, member, pageId);
    expect(JSON.stringify(item)).toContain('later brain words');
    const [s1] = await exec<{ pending: boolean }>(
      sqlTag`select pending from accepted_snapshots where node_id = ${pageId}`,
    );
    expect(s1?.pending).toBe(false);
  });
});
