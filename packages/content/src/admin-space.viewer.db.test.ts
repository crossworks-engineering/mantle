/**
 * An ADMIN's private items on a real, migrated Postgres (member logins
 * Phase 7, Jason 2026-09-28): an admin keeps items in their own personal
 * space, saves them under the admin embed rule (the brain's items at any
 * level), and accepts them into the brain themselves. Nobody else ever reads
 * them: not another admin (by id, or through the brain), not a member (team
 * drafts, even with a 'team' row), not the review queue. Nothing is
 * announced to the extractor before Accept, and Accept announces each moved
 * item once and leaves no author record (no member-authored badge).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/admin-space.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifyBarrier } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('admin private items', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sp: typeof import('./member-space');
  let sf: typeof import('./member-space-files');
  let sc: typeof import('./member-space-comments');
  let rv: typeof import('./member-review');
  let ma: typeof import('./member-accepted');
  let er: typeof import('./embed-refs');
  let fp: typeof import('@mantle/files');
  let draft: typeof import('./pages/draft');
  let sqlTag: typeof import('drizzle-orm').sql;
  let unlisten: () => Promise<void>;
  const announced: string[] = [];
  const tag = `aspace-${randomUUID().slice(0, 8)}`;
  // A brain of this test's own (not mantle_brain_id(): test files run in
  // parallel), two more admins and a member.
  const anchor = randomUUID();
  const adminA = randomUUID();
  const adminB = randomUUID();
  const member = randomUUID();
  const spaceOf: Record<string, string> = {};
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-admin-space-'));
  const moved: string[] = [];

  const as = <T>(login: string, fn: () => Promise<T>) =>
    m.withSpace({ spaceId: spaceOf[login]!, loginId: login }, fn);
  const exec = async <T>(q: ReturnType<typeof sqlTag>) =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const ownerOf = async (id: string) =>
    (await exec<{ owner_id: string }>(sqlTag`select owner_id from nodes where id = ${id}`))[0]
      ?.owner_id;
  const spool = (text: string) =>
    fp.spoolUpload(Readable.from([Buffer.from(text)]), {
      maxBytes: sf.SPACE_FILE_MAX_BYTES,
      dir: fp.spaceSpoolDir(),
    });
  const mention = (id: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id, ref: 'node' } }] }],
  });
  const text = (t: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
  });
  /** Every node_ingested notification committed so far has arrived. */
  const settle = () =>
    notifyBarrier(
      (m.systemDb as unknown as { $client: Parameters<typeof notifyBarrier>[0] }).$client,
      'node_ingested',
      { seen: (s) => announced.includes(s) },
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.MANTLE_SPACES_ROOT = path.join(root, 'spaces');
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    sp = await import('./member-space');
    sf = await import('./member-space-files');
    sc = await import('./member-space-comments');
    rv = await import('./member-review');
    ma = await import('./member-accepted');
    er = await import('./embed-refs');
    fp = await import('@mantle/files');
    draft = await import('./pages/draft');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    const sub = await admin.listen('node_ingested', (id: string) => announced.push(id));
    unlisten = () => sub.unlisten();

    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${anchor}, ${`${tag}-anchor@example.invalid`}, 'x', 'admin'),
        (${adminA}, ${`${tag}-a@example.invalid`}, 'x', 'admin'),
        (${adminB}, ${`${tag}-b@example.invalid`}, 'x', 'admin'),
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member')`);
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`);
    const rows = await exec<{ id: string; login_id: string }>(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${adminA}, ${adminB}, ${member})`);
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
    await m.systemDb.execute(sqlTag`
      delete from spaces where login_id in (${anchor}, ${adminA}, ${adminB}, ${member})`);
    await m.systemDb.execute(sqlTag`
      delete from auth.users where id in (${anchor}, ${adminA}, ${adminB}, ${member})`);
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  let secretId: string; // a brain item at admin level
  let pageId: string; // admin A's private page
  let imageId: string; // admin A's private image, shown on the page
  let bNoteId: string; // admin B's private note
  let mNoteId: string; // the member's note

  it('an admin keeps private items in their own space; nothing is announced', async () => {
    const { createNote } = await import('./notes');
    secretId = (await createNote(anchor, { title: `${tag} secret`, content: 'admin only' })).id;
    const A = spaceOf[adminA]!;
    pageId = (await as(adminA, () => sp.createMineItem(A, { type: 'page', title: `${tag} p` }))).id;
    imageId = await as(adminA, async () =>
      sf.createMineFile(A, { filename: 'Pic.png', spooled: await spool('PNGBYTES') }),
    );
    await as(adminA, () => draft.saveDraft(A, pageId, text('working copy')));
    const B = spaceOf[adminB]!;
    bNoteId = (
      await as(adminB, () =>
        sp.createMineItem(B, { type: 'note', title: `${tag} b`, content: 'b only' }),
      )
    ).id;
    const M = spaceOf[member]!;
    mNoteId = (
      await as(member, () =>
        sp.createMineItem(M, { type: 'note', title: `${tag} m`, content: 'team stuff' }),
      )
    ).id;
    expect(await ownerOf(pageId)).toBe(A);
    const mine = await as(adminA, () => sp.listMine(A));
    expect(mine.items.map((i) => i.id).sort()).toEqual([pageId, imageId].sort());
    await settle();
    expect(announced.filter((id) => [pageId, imageId, bNoteId, mNoteId].includes(id))).toEqual([]);
  });

  it('the admin embed rule: the brain at any level, never another login’s item', async () => {
    const A = spaceOf[adminA]!;
    const writer = { adminOfBrain: anchor };
    const refs = (id: string) => er.pageRefs(mention(id));
    // An admin-level brain item: allowed for the admin, as an admin.
    expect(await as(adminA, () => sp.disallowedRefs(A, refs(secretId), writer))).toEqual([]);
    // Without naming the brain, the member rule applies (Library only).
    expect(await as(adminA, () => sp.disallowedRefs(A, refs(secretId)))).toEqual([secretId]);
    // Another admin's private item, or a member's: refused.
    for (const other of [bNoteId, mNoteId]) {
      expect(await as(adminA, () => sp.disallowedRefs(A, refs(other), writer))).toEqual([other]);
    }
    // A "brain" that is not one (another admin's space): the member rule.
    expect(
      await as(adminA, () =>
        sp.disallowedRefs(A, refs(secretId), { adminOfBrain: spaceOf[adminB]! }),
      ),
    ).toEqual([secretId]);
    // Save version under the rule: the admin-level item is fine, with the
    // own image embedded.
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { nodeId: imageId } },
        {
          type: 'paragraph',
          content: [{ type: 'mention', attrs: { id: secretId, ref: 'node' } }],
        },
      ],
    };
    const saved = await as(adminA, () => sp.saveMinePage(A, pageId, doc, writer));
    expect(saved.ok).toBe(true);
    // A note's text is checked on every change, by the same rule.
    const note = await as(adminA, () =>
      sp.createMineItem(
        A,
        { type: 'note', title: `${tag} an`, content: `[s](/n/${secretId})` },
        writer,
      ),
    );
    await expect(
      as(adminA, () => sp.updateMineItem(A, note.id, { content: `[b](/n/${bNoteId})` }, writer)),
    ).rejects.toMatchObject({ reason: 'embed', ids: [bNoteId] });
    await as(adminA, () => sp.deleteMineItem(A, note.id));
  });

  it('a member keeps today’s rule, even when the brain is named', async () => {
    const M = spaceOf[member]!;
    const page = await as(member, () => sp.createMineItem(M, { type: 'page', title: `${tag} mp` }));
    await expect(
      as(member, () => sp.saveMinePage(M, page.id, mention(secretId), { adminOfBrain: anchor })),
    ).rejects.toMatchObject({ reason: 'embed', ids: [secretId] });
    // A disabled admin gets the member rule too.
    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = now() where id = ${adminA}`,
    );
    try {
      const A = spaceOf[adminA]!;
      expect(
        await as(adminA, () =>
          sp.disallowedRefs(A, er.pageRefs(mention(secretId)), { adminOfBrain: anchor }),
        ),
      ).toEqual([secretId]);
    } finally {
      await m.systemDb.execute(
        sqlTag`update auth.users set disabled_at = null where id = ${adminA}`,
      );
    }
  });

  it('another admin cannot read or change the item, by id or through the brain', async () => {
    const B = spaceOf[adminB]!;
    expect(await as(adminB, () => sp.getMineItem(B, pageId))).toBeNull();
    expect(await as(adminB, () => sf.openMineFile(B, imageId))).toBeNull();
    await expect(
      as(adminB, () => sp.updateMineItem(B, pageId, { title: 'mine now' })),
    ).rejects.toMatchObject({ reason: 'not-found' });
    await expect(as(adminB, () => sp.deleteMineItem(B, pageId))).rejects.toMatchObject({
      reason: 'not-found',
    });
    // Brain reads filter on the brain id: a private item is not the brain's.
    const { getPage } = await import('./pages/read');
    const { getNote } = await import('./notes');
    expect(await getPage(anchor, pageId)).toBeNull();
    expect(await getNote(anchor, bNoteId)).toBeNull();
    // Nor does B accept A's item into the brain.
    await expect(
      rv.acceptOwnItem(anchor, { spaceId: B, loginId: adminB }, pageId),
    ).rejects.toMatchObject({ reason: 'not-found' });
    // A's space with B's login: the space must be the caller's own.
    await expect(
      rv.acceptOwnItem(anchor, { spaceId: spaceOf[adminA]!, loginId: adminB }, pageId),
    ).rejects.toMatchObject({ reason: 'not-found' });
    expect(await ownerOf(pageId)).toBe(spaceOf[adminA]);
  });

  it('an admin’s item never reaches the review queue, the count or the review tools', async () => {
    // Force the states an admin cannot set (a promoted member's leftovers).
    await m.systemDb.execute(sqlTag`
      update space_items set sharing = 'team', review_state = 'submitted',
        submitted_at = now() where node_id = ${bNoteId}`);
    // The badge count, on one snapshot (other test files submit in parallel):
    // every submitted personal item, less the ones an admin wrote.
    await m.systemDb.transaction(async (tx) => {
      await tx.execute(sqlTag`set transaction isolation level repeatable read`);
      const [c] = (await tx.execute(sqlTag`
        select count(*)::int as total,
               count(*) filter (where u.role <> 'member')::int as admins
          from space_items si
          join nodes n on n.id = si.node_id
          join spaces s on s.id = n.owner_id and s.kind = 'personal'
          left join auth.users u on u.id = si.author_login_id
         where si.review_state = 'submitted'`)) as unknown as { total: number; admins: number }[];
      expect(c!.admins).toBeGreaterThanOrEqual(1);
      expect(await rv.countSubmitted(tx)).toBe(c!.total - c!.admins);
    });
    expect((await rv.listReviewQueue()).items.map((i) => i.id)).not.toContain(bNoteId);
    expect(await rv.getReviewItem(bNoteId)).toBeNull();
    expect(await rv.previewAccept(bNoteId)).toBeNull();
    expect(await rv.listReviewComments(bNoteId)).toBeNull();
    const reviewer = { loginId: anchor, name: 'Reviewer' };
    await expect(rv.acceptReviewItem(anchor, bNoteId, reviewer)).rejects.toMatchObject({
      reason: 'not-found',
    });
    await expect(rv.returnReviewItem(bNoteId, reviewer, 'no')).rejects.toMatchObject({
      reason: 'not-found',
    });
    await expect(rv.addReviewComment(anchor, bNoteId, reviewer, 'hi')).rejects.toMatchObject({
      reason: 'not-found',
    });
    expect(await ownerOf(bNoteId)).toBe(spaceOf[adminB]);
    // Left behind (deactivated, shared) is still not a member's.
    await m.systemDb.execute(sqlTag`
      update space_items set review_state = 'draft', submitted_at = null
       where node_id = ${bNoteId}`);
    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = now() where id = ${adminB}`,
    );
    try {
      expect((await rv.listReviewQueue()).items.map((i) => i.id)).not.toContain(bNoteId);
      await expect(rv.discardLeftBehind(bNoteId)).rejects.toMatchObject({ reason: 'not-found' });
    } finally {
      await m.systemDb.execute(
        sqlTag`update auth.users set disabled_at = null where id = ${adminB}`,
      );
    }

    // The contrast: the member's submitted item IS listed.
    const M = spaceOf[member]!;
    await as(member, () => sp.submitItem(M, mNoteId));
    expect((await rv.listReviewQueue()).items.map((i) => i.id)).toContain(mNoteId);
    await as(member, () => sp.recallItem(M, mNoteId));
  });

  it('a member never reads an admin’s item, even with a team row (0179)', async () => {
    // bNoteId still says sharing 'team' (forced above). The member's own
    // shared note is the contrast.
    const M = spaceOf[member]!;
    await as(member, () => sp.setSharing(M, mNoteId, 'team'));
    // Read from another member's side: a second member login.
    const other = randomUUID();
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${other}, ${`${tag}-o@example.invalid`}, 'x', 'member')`);
    try {
      const list = await m.withTeamDrafts(() => sp.listTeamDrafts(other, { q: tag }));
      expect(list.items.map((i) => i.id)).toContain(mNoteId);
      expect(list.items.map((i) => i.id)).not.toContain(bNoteId);
      expect(await m.withTeamDrafts(() => sp.getTeamDraftItem(bNoteId))).toBeNull();
      expect(await m.withTeamDrafts(() => sp.getTeamDraftRow(bNoteId))).toBeNull();
      // Not even the state row or the node, read straight.
      const si = await m.withTeamDrafts(() =>
        m.db.execute(sqlTag`select node_id from space_items where node_id = ${bNoteId}`),
      );
      expect((si as unknown as unknown[]).length).toBe(0);
      const node = await m.withTeamDrafts(() =>
        m.db.execute(sqlTag`select id from nodes where id = ${bNoteId}`),
      );
      expect((node as unknown as unknown[]).length).toBe(0);
      expect(await m.withTeamDrafts(() => sc.listTeamDraftComments(bNoteId))).toBeNull();
      await expect(
        sc.addTeamDraftComment(anchor, bNoteId, { loginId: other, name: 'O' }, 'hello'),
      ).rejects.toMatchObject({ reason: 'not-found' });
      // The member's shared note takes the same comment.
      const c = await sc.addTeamDraftComment(anchor, mNoteId, { loginId: other, name: 'O' }, 'hi');
      expect(c.nodeId).toBe(mNoteId);
    } finally {
      await m.systemDb.execute(sqlTag`delete from node_comments where login_id = ${other}`);
      await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${other}`);
      await m.systemDb.execute(sqlTag`delete from auth.users where id = ${other}`);
    }
  });

  it('self-accept refuses unsaved edits, and a member never self-accepts', async () => {
    const A = spaceOf[adminA]!;
    await as(adminA, () => draft.saveDraft(A, pageId, text('unsaved')));
    await expect(
      rv.acceptOwnItem(anchor, { spaceId: A, loginId: adminA }, pageId),
    ).rejects.toMatchObject({ reason: 'unsaved-draft' });
    await as(adminA, () => draft.discardDraft(A, pageId));

    const M = spaceOf[member]!;
    await expect(
      rv.acceptOwnItem(anchor, { spaceId: M, loginId: member }, mNoteId),
    ).rejects.toMatchObject({ reason: 'not-found' });
    expect(await ownerOf(mNoteId)).toBe(M);
  });

  it('self-accept moves the item and its bundle; each announced once; no author', async () => {
    const A = spaceOf[adminA]!;
    const spaceBytes = fp.spaceFilePath(A, imageId);
    expect(existsSync(spaceBytes)).toBe(true);
    const res = await rv.acceptOwnItem(anchor, { spaceId: A, loginId: adminA }, pageId, {
      audience: 'team',
    });
    moved.push(pageId, imageId);
    expect(res.moved.map((b) => b.id)).toEqual([pageId, imageId]);
    expect(res.audience).toBe('team');
    expect(await ownerOf(pageId)).toBe(anchor);
    expect(await ownerOf(imageId)).toBe(anchor);
    const [f] = await exec<{ path: string; data: Record<string, unknown> }>(
      sqlTag`select path::text as path, data from nodes where id = ${imageId}`,
    );
    expect(f?.path).toBe('files');
    const disk = fp.diskPathForFile('files', String(f?.data.filename));
    expect(disk && readFileSync(disk, 'utf8')).toBe('PNGBYTES');
    expect(existsSync(spaceBytes)).toBe(false);

    // No author record: no member-authored badge, not a member's accepted item.
    const rows = await exec<{ node_id: string }>(
      sqlTag`select node_id from space_items where node_id in (${pageId}, ${imageId})`,
    );
    expect(rows).toEqual([]);
    expect((await ma.acceptedAuthors(anchor, [pageId, imageId])).size).toBe(0);
    expect((await ma.listAccepted(anchor, adminA)).items).toEqual([]);

    // Gone from the admin's space; a second Accept finds nothing.
    expect(await as(adminA, () => sp.getMineRow(A, pageId))).toBeNull();
    await expect(
      rv.acceptOwnItem(anchor, { spaceId: A, loginId: adminA }, pageId),
    ).rejects.toMatchObject({ reason: 'not-found' });

    await settle();
    const seen = announced.filter((id) => [pageId, imageId, bNoteId, mNoteId].includes(id));
    expect(seen.sort()).toEqual([pageId, imageId].sort());
  });
});
