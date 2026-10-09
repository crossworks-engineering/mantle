/**
 * Member review on a real, migrated Postgres (member logins Phase 4, plan
 * v3.1 section 6): an admin reads only submitted items and what deactivated
 * logins left shared; Return (no note); Recall beats Accept; Accept moves
 * the item and its bundle into the brain with the same ids, rows and bytes,
 * and is the one path that announces anything to the extractor; the 30-day
 * purge deletes private items only and empties a space's directories.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/member-review.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifyBarrier } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('member review, accept and purge', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sp: typeof import('./member-space');
  let sf: typeof import('./member-space-files');
  let rv: typeof import('./member-review');
  let pg: typeof import('./member-space-purge');
  let fp: typeof import('@mantle/files');
  let td: typeof import('./tables/draft');
  let sqlTag: typeof import('drizzle-orm').sql;
  let unlisten: () => Promise<void>;
  const announced: string[] = [];
  /** Every node_ingested notification committed so far has arrived. */
  const announcedSoFar = () =>
    notifyBarrier(
      (m.systemDb as unknown as { $client: Parameters<typeof notifyBarrier>[0] }).$client,
      'node_ingested',
      { seen: (s) => announced.includes(s) },
    );
  const tag = `mreview-${randomUUID().slice(0, 8)}`;
  const loginA = randomUUID();
  const loginB = randomUUID();
  const loginC = randomUUID();
  const loginD = randomUUID();
  const loginE = randomUUID();
  const spaceOf: Record<string, string> = {};
  let anchor: string;
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-review-'));
  const reviewer = () => ({ loginId: anchor, name: 'Reviewer' });

  const as = <T>(login: string, fn: () => Promise<T>) =>
    m.withSpace({ spaceId: spaceOf[login]!, loginId: login }, fn);
  const spool = (text: string) =>
    fp.spoolUpload(Readable.from([Buffer.from(text)]), {
      maxBytes: sf.SPACE_FILE_MAX_BYTES,
      dir: fp.spaceSpoolDir(),
    });
  const exec = async <T>(q: ReturnType<typeof sqlTag>) =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const ownerOf = async (id: string) =>
    (await exec<{ owner_id: string }>(sqlTag`select owner_id from nodes where id = ${id}`))[0]
      ?.owner_id;
  const stateOf = async (id: string) =>
    (
      await exec<{ review_state: string; reviewed_by: string | null }>(
        sqlTag`select review_state, reviewed_by from space_items where node_id = ${id}`,
      )
    )[0];

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
    pg = await import('./member-space-purge');
    fp = await import('@mantle/files');
    td = await import('./tables/draft');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    const sub = await admin.listen('node_ingested', (id: string) => announced.push(id));
    unlisten = () => sub.unlisten();

    // A brain of this test's own: the reviewing admin's login and a brain
    // space row with its id. Not mantle_brain_id(): test files run in
    // parallel, and another file may create and delete the shared anchor.
    anchor = randomUUID();
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${anchor}, ${`${tag}-admin@example.invalid`}, 'x', 'admin')`);
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`);
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${loginA}, ${`${tag}-a@example.invalid`}, 'x', 'member'),
        (${loginB}, ${`${tag}-b@example.invalid`}, 'x', 'member'),
        (${loginC}, ${`${tag}-c@example.invalid`}, 'x', 'member'),
        (${loginD}, ${`${tag}-d@example.invalid`}, 'x', 'member'),
        (${loginE}, ${`${tag}-e@example.invalid`}, 'x', 'member')`);
    const rows = await exec<{ id: string; login_id: string }>(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${loginA}, ${loginB}, ${loginC}, ${loginD}, ${loginE})`);
    for (const r of rows) spaceOf[r.login_id] = r.id;
  }, 60_000);

  const moved: string[] = [];

  afterAll(async () => {
    await unlisten();
    const spaceIds = Object.values(spaceOf);
    for (const id of moved) await m.systemDb.execute(sqlTag`delete from nodes where id = ${id}`);
    for (const s of spaceIds) {
      await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${s}`);
      await m.systemDb.execute(sqlTag`delete from spaces where id = ${s}`);
    }
    await m.systemDb.execute(sqlTag`
      delete from auth.users where id in (${loginA}, ${loginB}, ${loginC}, ${loginD}, ${loginE})`);
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${anchor}`);
    await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${anchor}`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id = ${anchor}`);
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  let pageId: string;
  let imageId: string;
  let noteId: string;
  let strayId: string;

  it('builds a page that shows an own image and links an own note', async () => {
    const A = spaceOf[loginA]!;
    imageId = await as(loginA, async () =>
      sf.createMineFile(A, { filename: 'Photo One.png', spooled: await spool('PNGBYTES') }),
    );
    strayId = await as(loginA, async () =>
      sf.createMineFile(A, { filename: 'stray.txt', spooled: await spool('not embedded') }),
    );
    noteId = (await as(loginA, () => sp.createMineItem(A, { type: 'note', title: `${tag} n` }))).id;
    pageId = (await as(loginA, () => sp.createMineItem(A, { type: 'page', title: `${tag} p` }))).id;
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { nodeId: imageId } },
        { type: 'paragraph', content: [{ type: 'mention', attrs: { id: noteId, ref: 'node' } }] },
      ],
    };
    const saved = await as(loginA, () => sp.saveMinePage(A, pageId, doc));
    expect(saved.ok).toBe(true);
  });

  it('an admin never sees a private item, not even by id', async () => {
    const q = await rv.listReviewQueue();
    expect(q.items.map((i) => i.id)).not.toContain(pageId);
    expect(await rv.getReviewItem(pageId)).toBeNull();
    expect(await rv.previewAccept(pageId)).toBeNull();
    expect(await rv.openReviewFile(pageId, imageId)).toBeNull();
    await expect(rv.acceptReviewItem(anchor, pageId, reviewer())).rejects.toMatchObject({
      reason: 'not-found',
    });
    await expect(rv.returnReviewItem(pageId, reviewer())).rejects.toMatchObject({
      reason: 'not-found',
    });
  });

  it('a submitted item is listed and read at its saved version, with its bundle', async () => {
    const A = spaceOf[loginA]!;
    await as(loginA, () => sp.submitItem(A, pageId));
    const q = await rv.listReviewQueue();
    const row = q.items.find((i) => i.id === pageId);
    expect(row).toMatchObject({ reason: 'submitted', type: 'page' });
    expect(row?.author.email).toBe(`${tag}-a@example.invalid`);
    // Only the submitted item: its image and note stay unlisted.
    expect(q.items.map((i) => i.id)).not.toContain(imageId);
    expect(q.items.map((i) => i.id)).not.toContain(noteId);

    const item = await rv.getReviewItem(pageId);
    expect(item?.body.type === 'page' && item.body.page.draft).toBeNull();

    const bundle = await rv.previewAccept(pageId);
    expect(bundle?.items.map((b) => b.id)).toEqual([pageId, imageId]);
    expect(bundle?.linksStayingBehind).toBe(1);

    // The image the page shows is readable for the review; nothing else is.
    const img = await rv.openReviewFile(pageId, imageId);
    expect(img?.file.id).toBe(imageId);
    img?.stream.destroy();
    expect(await rv.openReviewFile(pageId, strayId)).toBeNull();
    expect(await rv.openReviewFile(pageId, noteId)).toBeNull();
  });

  it('Return sends it back, with no note; the author edits and resubmits', async () => {
    const A = spaceOf[loginA]!;
    await rv.returnReviewItem(pageId, reviewer());
    const row = await as(loginA, () => sp.getMineRow(A, pageId));
    expect([row?.reviewState, row?.returnedNote]).toEqual(['returned', null]);
    expect((await stateOf(pageId))?.reviewed_by).toBe(anchor);
    // Not waiting any more: a second Return is refused.
    await expect(rv.returnReviewItem(pageId, reviewer())).rejects.toMatchObject({
      reason: 'not-found',
    });
    await as(loginA, () => sp.assertEditable(A, pageId));
    await as(loginA, () => sp.submitItem(A, pageId));
  });

  it('a Recall that lands first wins over Accept', async () => {
    const A = spaceOf[loginA]!;
    await as(loginA, () => sp.recallItem(A, pageId));
    // The same answer as for a private item: nothing tells them apart.
    await expect(rv.acceptReviewItem(anchor, pageId, reviewer())).rejects.toMatchObject({
      reason: 'not-found',
    });
    expect(await ownerOf(pageId)).toBe(A);
    await as(loginA, () => sp.submitItem(A, pageId));
  });

  it('Approve is pinned: a version sent again since the admin looked is refused', async () => {
    const A = spaceOf[loginA]!;
    const shown = (await rv.getReviewItem(pageId))!.row.submittedAt;
    expect(shown).not.toBeNull();
    // The author recalls it and sends it again: a new submittedAt.
    await as(loginA, () => sp.recallItem(A, pageId));
    await new Promise((r) => setTimeout(r, 5));
    await as(loginA, () => sp.submitItem(A, pageId));
    await expect(
      rv.acceptReviewItem(anchor, pageId, reviewer(), { submittedAt: shown }),
    ).rejects.toMatchObject({ reason: 'changed' });
    // The route requires a pin: none at all is refused the same way.
    await expect(
      rv.acceptReviewItem(anchor, pageId, reviewer(), { requirePin: true }),
    ).rejects.toMatchObject({ reason: 'changed' });
    // And a null pin is for a never-submitted item only.
    await expect(
      rv.acceptReviewItem(anchor, pageId, reviewer(), { requirePin: true, submittedAt: null }),
    ).rejects.toMatchObject({ reason: 'changed' });
    // Nothing moved; it still waits.
    expect(await ownerOf(pageId)).toBe(A);
    expect((await stateOf(pageId))?.review_state).toBe('submitted');
  });

  it('nothing was announced to the extractor before Accept', async () => {
    await announcedSoFar();
    expect(announced.filter((id) => [pageId, imageId, noteId].includes(id))).toEqual([]);
  });

  it('Accept moves the item and its bundle into the brain, same ids, at the level picked', async () => {
    const A = spaceOf[loginA]!;
    const spaceBytes = fp.spaceFilePath(A, imageId);
    expect(existsSync(spaceBytes)).toBe(true);
    // Pinned to the version on screen, which is the one waiting.
    const shown = (await rv.getReviewItem(pageId))!.row.submittedAt;
    const res = await rv.acceptReviewItem(anchor, pageId, reviewer(), {
      audience: 'team',
      submittedAt: shown,
      requirePin: true,
    });
    moved.push(pageId, imageId);
    expect(res.moved.map((b) => b.id)).toEqual([pageId, imageId]);
    expect(res.linksStayingBehind).toBe(1);

    expect(await ownerOf(pageId)).toBe(anchor);
    expect(await ownerOf(imageId)).toBe(anchor);
    expect(await ownerOf(noteId)).toBe(A); // a link, not an embed: it stays
    const levels = await exec<{ id: string; audience: string }>(
      sqlTag`select id, audience from nodes where id in (${pageId}, ${imageId})`,
    );
    expect(levels.map((l) => l.audience)).toEqual(['team', 'team']);
    for (const id of [pageId, imageId]) {
      expect(await stateOf(id)).toMatchObject({ review_state: 'accepted', reviewed_by: anchor });
    }

    // The bytes moved into the brain's files tree, under a safe name.
    const [f] = await exec<{ path: string; data: Record<string, unknown> }>(
      sqlTag`select path::text as path, data from nodes where id = ${imageId}`,
    );
    expect(f?.path).toBe('files');
    const disk = fp.diskPathForFile('files', String(f?.data.filename));
    expect(disk && readFileSync(disk, 'utf8')).toBe('PNGBYTES');
    expect(existsSync(spaceBytes)).toBe(false);
    expect(f?.data.storage).toBeUndefined();

    // Gone from Mine; the author's link target is still theirs.
    expect(await as(loginA, () => sp.getMineRow(A, pageId))).toBeNull();
    expect(await as(loginA, () => sp.getMineRow(A, noteId))).not.toBeNull();

    // Accepting again finds nothing to accept.
    await expect(rv.acceptReviewItem(anchor, pageId, reviewer())).rejects.toMatchObject({
      reason: 'not-found',
    });
  });

  it('Accept announced each moved item to the extractor once, and nothing else', async () => {
    await announcedSoFar();
    const seen = announced.filter((id) => [pageId, imageId, noteId, strayId].includes(id));
    expect(seen.sort()).toEqual([pageId, imageId].sort());
  });

  it('no row anywhere keeps the space as owner of a moved item (owner-copy registry)', async () => {
    const A = spaceOf[loginA]!;
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
                where owner_id = ${A} and ${sqlTag.identifier(col)} in (${pageId}, ${imageId})`,
      );
      expect(r?.n, t.table_name).toBe(0);
    }
  });

  it('Accept moves a table’s workbook into the brain’s table folder', async () => {
    const A = spaceOf[loginA]!;
    const t = await as(loginA, () => sp.createMineItem(A, { type: 'table', title: `${tag} t` }));
    const got = await as(loginA, () => sp.getMineItem(A, t.id));
    const col = got?.body.type === 'table' ? got.body.table.data.columns[0]!.id : '';
    await as(loginA, () =>
      td.applyTableOps(A, t.id, [{ op: 'row_add', cells: { [col]: 'accepted cell' } }]),
    );
    await as(loginA, () => sp.saveMineTable(A, t.id));
    await as(loginA, () => sp.submitItem(A, t.id));
    const oldFile = path.join(root, 'table-dbs', A, `${t.id}.sqlite`);
    expect(existsSync(oldFile)).toBe(true);
    await rv.acceptReviewItem(anchor, t.id, reviewer());
    moved.push(t.id);
    const [row] = await exec<{ storage_path: string }>(
      sqlTag`select storage_path from tables where node_id = ${t.id}`,
    );
    expect(row?.storage_path).toBe(`${anchor}/${t.id}.sqlite`);
    expect(existsSync(path.join(root, 'table-dbs', anchor, `${t.id}.sqlite`))).toBe(true);
    expect(existsSync(oldFile)).toBe(false);
    const { getTable } = await import('./tables/read');
    const brainTable = await getTable(anchor, t.id);
    expect(JSON.stringify(brainTable?.data)).toContain('accepted cell');
  });

  it('a left-behind item is approved through the pin the route requires (null)', async () => {
    const D = spaceOf[loginD]!;
    const kept = await as(loginD, () =>
      sp.createMineItem(D, { type: 'note', title: `${tag} kept`, content: 'left for the team' }),
    );
    await as(loginD, () => sp.setSharing(D, kept.id, 'team'));
    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = now() where id = ${loginD}`,
    );
    try {
      const row = (await rv.listReviewQueue()).items.find((i) => i.id === kept.id);
      expect(row).toMatchObject({ reason: 'left-behind', submittedAt: null });
      // No pin is refused; a pin with a time it never had is refused.
      await expect(
        rv.acceptReviewItem(anchor, kept.id, reviewer(), { requirePin: true }),
      ).rejects.toMatchObject({ reason: 'changed' });
      await expect(
        rv.acceptReviewItem(anchor, kept.id, reviewer(), {
          requirePin: true,
          submittedAt: new Date().toISOString(),
        }),
      ).rejects.toMatchObject({ reason: 'changed' });
      expect(await ownerOf(kept.id)).toBe(D);
      // The null it was shown approves it.
      await rv.acceptReviewItem(anchor, kept.id, reviewer(), {
        requirePin: true,
        submittedAt: row!.submittedAt,
      });
      moved.push(kept.id);
      expect(await ownerOf(kept.id)).toBe(anchor);
      expect((await stateOf(kept.id))?.review_state).toBe('accepted');
    } finally {
      await m.systemDb.execute(
        sqlTag`update auth.users set disabled_at = null where id = ${loginD}`,
      );
    }
  });

  it('what a deactivated login shared is offered to an admin: discard it', async () => {
    const B = spaceOf[loginB]!;
    const shared = await as(loginB, () =>
      sp.createMineItem(B, { type: 'note', title: `${tag} shared`, content: 'team stuff' }),
    );
    await as(loginB, () => sp.setSharing(B, shared.id, 'team'));
    const submitted = await as(loginB, () =>
      sp.createMineItem(B, { type: 'note', title: `${tag} sub`, content: 'for review' }),
    );
    await as(loginB, () => sp.submitItem(B, submitted.id));

    // Active author: the shared note is not an admin's; the submitted one
    // cannot be discarded, only returned or accepted.
    expect((await rv.listReviewQueue()).items.map((i) => i.id)).not.toContain(shared.id);
    await expect(rv.discardLeftBehind(submitted.id)).rejects.toMatchObject({
      reason: 'not-left-behind',
    });

    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = now() where id = ${loginB}`,
    );
    const q = await rv.listReviewQueue();
    expect(q.items.find((i) => i.id === shared.id)).toMatchObject({
      reason: 'left-behind',
      author: { inactive: true },
    });
    await rv.discardLeftBehind(shared.id);
    expect(await ownerOf(shared.id)).toBeUndefined();
    await rv.discardLeftBehind(submitted.id);
    expect(await ownerOf(submitted.id)).toBeUndefined();
  });

  it('the purge deletes private items after 30 days, keeps shared and submitted ones', async () => {
    const C = spaceOf[loginC]!;
    const priv = await as(loginC, () =>
      sp.createMineItem(C, { type: 'page', title: `${tag} private` }),
    );
    const privFile = await as(loginC, async () =>
      sf.createMineFile(C, { filename: 'secret.txt', spooled: await spool('secret') }),
    );
    const shared = await as(loginC, () =>
      sp.createMineItem(C, { type: 'note', title: `${tag} c shared` }),
    );
    await as(loginC, () => sp.setSharing(C, shared.id, 'team'));
    const submitted = await as(loginC, () =>
      sp.createMineItem(C, { type: 'note', title: `${tag} c sub` }),
    );
    await as(loginC, () => sp.submitItem(C, submitted.id));

    // Deactivated 5 days ago: nothing is due yet.
    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = now() - interval '5 days' where id = ${loginC}`,
    );
    expect((await pg.findSpacePurge()).find((d) => d.spaceId === C)).toBeUndefined();
    await pg.purgeDeactivatedSpaces();
    expect(await ownerOf(priv.id)).toBe(C);

    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = now() - interval '31 days' where id = ${loginC}`,
    );
    expect((await pg.findSpacePurge()).find((d) => d.spaceId === C)?.items).toBe(2);
    const res = await pg.purgeDeactivatedSpaces();
    expect(res.skipped).toBeUndefined();
    expect(await ownerOf(priv.id)).toBeUndefined();
    expect(await ownerOf(privFile)).toBeUndefined();
    expect(existsSync(fp.spaceFilePath(C, privFile))).toBe(false);
    expect(await ownerOf(shared.id)).toBe(C);
    expect(await ownerOf(submitted.id)).toBe(C);
    expect(existsSync(fp.spaceDir(C))).toBe(true);
  });

  it('a space the purge empties loses both of its directories (D6)', async () => {
    const D = spaceOf[loginD]!;
    await as(loginD, async () =>
      sf.createMineFile(D, { filename: 'only.txt', spooled: await spool('only') }),
    );
    await as(loginD, () => sp.createMineItem(D, { type: 'table', title: `${tag} d grid` }));
    expect(existsSync(fp.spaceDir(D))).toBe(true);
    expect(existsSync(path.join(root, 'table-dbs', D))).toBe(true);
    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = now() - interval '40 days' where id = ${loginD}`,
    );
    const res = await pg.purgeDeactivatedSpaces();
    expect(res.emptied).toBeGreaterThanOrEqual(1);
    const [left] = await exec<{ n: number }>(
      sqlTag`select count(*)::int as n from nodes where owner_id = ${D}`,
    );
    expect(left?.n).toBe(0);
    expect(existsSync(fp.spaceDir(D))).toBe(false);
    expect(existsSync(path.join(root, 'table-dbs', D))).toBe(false);
  });

  it('a login enabled again is never purged', async () => {
    const E = spaceOf[loginE]!;
    const p = await as(loginE, () => sp.createMineItem(E, { type: 'page', title: `${tag} e` }));
    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = now() - interval '40 days' where id = ${loginE}`,
    );
    await m.systemDb.execute(sqlTag`update auth.users set disabled_at = null where id = ${loginE}`);
    await pg.purgeDeactivatedSpaces();
    expect(await ownerOf(p.id)).toBe(E);
  });
});
