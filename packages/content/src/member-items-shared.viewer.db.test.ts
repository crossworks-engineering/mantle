/**
 * "Shared by members" on a real, migrated Postgres (workspace review
 * pattern, Jason 2026-10-09, option 1): an admin reads what active members
 * shared with the team, at team level, the SAVED version only; never a
 * private item, never a working draft, never a submitted item here (it waits
 * in the review queue), never a deactivated author's item (left behind).
 * Unshare puts an item back to private and touches nothing else.
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
        (${loginB}, ${`${tag}-b@example.invalid`}, 'x', 'member')`);
    const rows = await exec<{ id: string; login_id: string }>(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${loginA}, ${loginB})`);
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
    expect((await as(loginA, () => sp.saveMinePage(A, sharedPage, para('SAVED TEXT')))).ok).toBe(
      true,
    );
    await as(loginA, () => sp.saveMineDraft(A, sharedPage, para('WORKING DRAFT')));
    for (const id of [sharedPage, sharedFile, submittedNote]) {
      await as(loginA, () => sp.setSharing(A, id, 'team'));
    }
    await as(loginA, () => sp.submitItem(A, submittedNote));
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
      delete from auth.users where id in (${admin}, ${loginA}, ${loginB})`);
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  it('lists what active members shared, and nothing private, submitted or left behind', async () => {
    expect((await mine()).sort()).toEqual(['shared page', 'shared.txt']);
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
  });

  it("a deactivated author's item is not read here (it waits as left behind)", async () => {
    expect(await sh.getMemberItemShared(leftPage)).toBeNull();
  });

  it('Unshare puts it back to private, once, and only a shared member item', async () => {
    expect(await sh.adminUnshareMemberItem(privatePage)).toBe(false);
    expect(await sh.adminUnshareMemberItem(randomUUID())).toBe(false);
    expect(await sh.adminUnshareMemberItem(sharedPage)).toBe(true);
    expect(await sharingOf(sharedPage)).toBe('private');
    expect(await sh.adminUnshareMemberItem(sharedPage)).toBe(false);
    expect(await mine()).toEqual(['shared.txt']);
    expect(await sh.getMemberItemShared(sharedPage)).toBeNull();
    // Nothing else changed: the author still has it, with its draft.
    const row = await as(loginA, () => sp.getMineRow(spaceOf[loginA]!, sharedPage));
    expect(row).toMatchObject({ sharing: 'private', reviewState: 'draft' });
  });
});
