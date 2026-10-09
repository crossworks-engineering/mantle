/**
 * "Shared by members" on a real, migrated Postgres (workspace review
 * pattern, Jason 2026-10-09, option 1): an admin reads what active members
 * shared with the team, at team level, the SAVED version only; never a
 * private item, never a working draft, never a submitted item here (it waits
 * in the review queue), never a deactivated author's item (left behind).
 * Unshare puts an item back to private and touches nothing else, and only
 * under the same rule (audit M1): never a left-behind item, a submitted one,
 * an admin's own, a folder or a client's item. Bytes and SVG serve the item
 * and what it embeds, nothing else (audit L1).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/member-items-shared.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('Shared by members, the admin side', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sp: typeof import('./member-space');
  let sf: typeof import('./member-space-files');
  let sh: typeof import('./member-items-shared');
  let fp: typeof import('@mantle/files');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `mshared-${randomUUID().slice(0, 8)}`;
  const loginA = randomUUID();
  const loginB = randomUUID();
  const loginC = randomUUID();
  const spaceOf: Record<string, string> = {};
  let admin: string;
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-shared-'));

  const as = <T>(login: string, fn: () => Promise<T>) =>
    m.withSpace({ spaceId: spaceOf[login]!, loginId: login }, fn);
  const spool = (text: string) =>
    fp.spoolUpload(Readable.from([Buffer.from(text)]), {
      maxBytes: sf.SPACE_FILE_MAX_BYTES,
      dir: fp.spaceSpoolDir(),
    });
  const exec = async <T>(q: ReturnType<typeof sqlTag>) =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const sharingOf = async (id: string) =>
    (
      await exec<{ sharing: string }>(sqlTag`select sharing from space_items where node_id = ${id}`)
    )[0]?.sharing;
  const mine = async () => {
    const all = await sh.listMemberItemsShared(admin);
    return all.filter((i) => i.title.startsWith(tag)).map((i) => i.title.slice(tag.length + 1));
  };

  let sharedPage: string;
  let privatePage: string;
  let sharedFile: string;
  let privateFile: string;
  let submittedNote: string;
  let leftPage: string;
  let embeddedImage: string;
  let returnedNote: string;
  let adminOwn: string;
  let folderId: string;
  let clientNote: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.MANTLE_SPACES_ROOT = path.join(root, 'spaces');
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    sp = await import('./member-space');
    sf = await import('./member-space-files');
    sh = await import('./member-items-shared');
    fp = await import('@mantle/files');
    sqlTag = (await import('drizzle-orm')).sql;
    const client = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(client, process.env.MANTLE_MASTER_KEY);

    admin = randomUUID();
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${admin}, ${`${tag}-admin@example.invalid`}, 'x', 'admin'),
        (${loginA}, ${`${tag}-a@example.invalid`}, 'x', 'member'),
        (${loginB}, ${`${tag}-b@example.invalid`}, 'x', 'member'),
        (${loginC}, ${`${tag}-c@example.invalid`}, 'x', 'client')`);
    for (const login of [admin, loginC]) {
      await m.systemDb.execute(sqlTag`
        insert into spaces (kind, login_id) values ('personal', ${login})
        on conflict do nothing`);
    }
    const rows = await exec<{ id: string; login_id: string }>(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${loginA}, ${loginB}, ${admin}, ${loginC})`);
    for (const r of rows) spaceOf[r.login_id] = r.id;

    const A = spaceOf[loginA]!;
    const B = spaceOf[loginB]!;
    const make = (login: string, space: string, type: 'page' | 'note', title: string) =>
      as(login, () => sp.createMineItem(space, { type, title: `${tag} ${title}` })).then(
        (r) => r.id,
      );
    sharedPage = await make(loginA, A, 'page', 'shared page');
    privatePage = await make(loginA, A, 'page', 'private page');
    submittedNote = await make(loginA, A, 'note', 'submitted note');
    leftPage = await make(loginB, B, 'page', 'left page');
    returnedNote = await make(loginA, A, 'note', 'returned note');
    embeddedImage = await as(loginA, async () =>
      sf.createMineFile(A, { filename: `${tag} embedded.png`, spooled: await spool('PNG') }),
    );
    sharedFile = await as(loginA, async () =>
      sf.createMineFile(A, { filename: `${tag} shared.txt`, spooled: await spool('SHARED') }),
    );
    privateFile = await as(loginA, async () =>
      sf.createMineFile(A, { filename: `${tag} private.txt`, spooled: await spool('PRIVATE') }),
    );
    const para = (text: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    // The saved version, then a working draft over it.
    const saved = await as(loginA, () =>
      sp.saveMinePage(A, sharedPage, {
        type: 'doc',
        content: [
          ...para('SAVED TEXT').content,
          { type: 'image', attrs: { nodeId: embeddedImage } },
        ],
      }),
    );
    expect(saved.ok).toBe(true);
    await as(loginA, () => sp.saveMineDraft(A, sharedPage, para('WORKING DRAFT')));
    for (const id of [sharedPage, sharedFile, submittedNote, embeddedImage, returnedNote]) {
      await as(loginA, () => sp.setSharing(A, id, 'team'));
    }
    await as(loginA, () => sp.submitItem(A, submittedNote));
    await m.systemDb.execute(sqlTag`
      update space_items set review_state = 'returned' where node_id = ${returnedNote}`);
    // Rows no rule should ever reach, written by hand: an admin's own note
    // and a folder in a member's space, both shared with the team, and a
    // client's submitted request (a client item can never be team-shared:
    // a trigger refuses it).
    adminOwn = randomUUID();
    folderId = randomUUID();
    clientNote = randomUUID();
    const odd: [string, string, string, string, string][] = [
      [adminOwn, spaceOf[admin]!, 'note', 'admin own', admin],
      [folderId, A, 'branch', 'folder', loginA],
      [clientNote, spaceOf[loginC]!, 'note', 'client note', loginC],
    ];
    for (const [id, owner, type, title, author] of odd) {
      // A folder's path is unique per owner: its own label under notes.
      const at = type === 'branch' ? `notes.f${id.replace(/-/g, '').slice(0, 12)}` : 'notes';
      await m.systemDb.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, slug, path, audience)
        values (${id}, ${owner}, ${type}, ${`${tag} ${title}`}, ${`${tag}-${id}`}, ${at}::ltree,
                'admin')`);
      const client = author === loginC;
      await m.systemDb.execute(sqlTag`
        insert into space_items (node_id, author_login_id, sharing, review_state)
        values (${id}, ${author}, ${client ? 'private' : 'team'},
                ${client ? 'submitted' : 'draft'})`);
    }
    await as(loginB, () => sp.setSharing(B, leftPage, 'team'));
    // B leaves: what B shared is left behind (the review queue offers it).
    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = now() where id = ${loginB}`,
    );
  }, 60_000);

  afterAll(async () => {
    for (const s of Object.values(spaceOf)) {
      await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${s}`);
      await m.systemDb.execute(sqlTag`delete from spaces where id = ${s}`);
    }
    await m.systemDb.execute(sqlTag`
      delete from auth.users where id in (${admin}, ${loginA}, ${loginB}, ${loginC})`);
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  it('lists what active members shared, and nothing private, submitted or left behind', async () => {
    expect((await mine()).sort()).toEqual([
      'embedded.png',
      'returned note',
      'shared page',
      'shared.txt',
    ]);
    const page = (await sh.listMemberItemsShared(admin, 'page')).filter((i) => i.id === sharedPage);
    expect(page).toHaveLength(1);
    expect(page[0]!.author).toMatchObject({ loginId: loginA, active: true });
    expect((await sh.listMemberItemsShared(admin, 'note')).map((i) => i.id)).not.toContain(
      submittedNote,
    );
  });

  it('reads the SAVED version, never the working draft', async () => {
    const got = await sh.getMemberItemShared(sharedPage);
    expect(got?.author).toMatchObject({ loginId: loginA, active: true });
    const text = JSON.stringify(got?.body);
    expect(text).toContain('SAVED TEXT');
    expect(text).not.toContain('WORKING DRAFT');
  });

  it('a private item answers like a missing one, for the item and its bytes', async () => {
    expect(await sh.getMemberItemShared(privatePage)).toBeNull();
    expect(await sh.getMemberItemShared(randomUUID())).toBeNull();
    expect(await sh.openMemberFileShared(privateFile)).toBeNull();
    const opened = await sh.openMemberFileShared(sharedFile);
    expect(opened).not.toBeNull();
    for (const id of [submittedNote, adminOwn, folderId, clientNote]) {
      expect(await sh.getMemberItemShared(id), id).toBeNull();
    }
  });

  it('bytes serve the item and what it embeds, nothing else (L1)', async () => {
    expect(await sh.openMemberFileShared(sharedPage, embeddedImage)).not.toBeNull();
    // Shared too, but not in the page: not reachable through it.
    expect(await sh.openMemberFileShared(sharedPage, sharedFile)).toBeNull();
    expect(await sh.openMemberFileShared(sharedPage, privateFile)).toBeNull();
    // Through an item the rule refuses: nothing.
    expect(await sh.openMemberFileShared(submittedNote, sharedFile)).toBeNull();
    expect(await sh.memberDrawSvgShared(sharedPage, randomUUID())).toBeNull();
  });

  it("a deactivated author's item is not read here (it waits as left behind)", async () => {
    expect(await sh.getMemberItemShared(leftPage)).toBeNull();
  });

  it('Unshare refuses what the rule refuses, and the left-behind item stays queued (M1)', async () => {
    for (const id of [leftPage, submittedNote, adminOwn, folderId]) {
      expect(await sh.adminUnshareMemberItem(id), id).toBeNull();
      expect(await sharingOf(id), id).toBe('team');
    }
    expect(await sh.adminUnshareMemberItem(clientNote)).toBeNull();
    const rv = await import('./member-review');
    const queued = (await rv.listReviewQueue()).items.find((i) => i.id === leftPage);
    expect(queued?.reason).toBe('left-behind');
  });

  it('Unshare puts it back to private, once, and only a shared member item', async () => {
    expect(await sh.adminUnshareMemberItem(privatePage)).toBeNull();
    expect(await sh.adminUnshareMemberItem(randomUUID())).toBeNull();
    expect(await sh.adminUnshareMemberItem(sharedPage)).toEqual({
      id: sharedPage,
      type: 'page',
      authorLoginId: loginA,
    });
    expect(await sharingOf(sharedPage)).toBe('private');
    expect(await sh.adminUnshareMemberItem(sharedPage)).toBeNull();
    expect((await mine()).sort()).toEqual(['embedded.png', 'returned note', 'shared.txt']);
    expect(await sh.getMemberItemShared(sharedPage)).toBeNull();
    // Nothing else changed: the author still has it, with its draft.
    const row = await as(loginA, () => sp.getMineRow(spaceOf[loginA]!, sharedPage));
    expect(row).toMatchObject({ sharing: 'private', reviewState: 'draft' });
  });
});
