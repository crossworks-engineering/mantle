/**
 * An ADMIN's private items on a real, migrated Postgres (member logins
 * Phase 7, Jason 2026-09-28): an admin keeps items in their own personal
 * space and saves them under the admin embed rule (the brain's items at any
 * level). Nobody else ever reads them: not another admin (by id, or through
 * the brain), not a member (team drafts, even with a 'team' row). Nothing is
 * announced to the extractor. The admin's own Accept and the review queue
 * were removed in workspaces W5c.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/admin-space.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
  // A client login with a submitted item (audit A3): the badge count below
  // must not take it for an admin's.
  const client = randomUUID();
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
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member'),
        (${client}, ${`${tag}-c@example.invalid`}, 'x', 'client')`);
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`);
    const rows = await exec<{ id: string; login_id: string }>(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${adminA}, ${adminB}, ${member}, ${client})`);
    for (const r of rows) spaceOf[r.login_id] = r.id;
  }, 60_000);

  afterAll(async () => {
    await unlisten();
    for (const id of moved) await m.systemDb.execute(sqlTag`delete from nodes where id = ${id}`);
    for (const s of Object.values(spaceOf)) {
      await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${s}`);
      await m.systemDb.execute(sqlTag`delete from spaces where id = ${s}`);
    }
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${anchor}`);
    await m.systemDb.execute(sqlTag`
      delete from spaces where login_id in (${anchor}, ${adminA}, ${adminB}, ${member}, ${client})`);
    await m.systemDb.execute(sqlTag`
      delete from auth.users where id in (${anchor}, ${adminA}, ${adminB}, ${member}, ${client})`);
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
    // A disabled admin gets the member rule too. withSpace refuses to open
    // a disabled login's space at all (audit A16), so the login is disabled
    // while its space is open: the rule reads the row, not the session.
    const A = spaceOf[adminA]!;
    const setDisabled = (on: boolean) =>
      m.systemDb.execute(
        on
          ? sqlTag`update auth.users set disabled_at = now() where id = ${adminA}`
          : sqlTag`update auth.users set disabled_at = null where id = ${adminA}`,
      );
    try {
      expect(
        await as(adminA, async () => {
          await setDisabled(true);
          return sp.disallowedRefs(A, er.pageRefs(mention(secretId)), { adminOfBrain: anchor });
        }),
      ).toEqual([secretId]);
      await expect(as(adminA, async () => 1)).rejects.toThrow(/disabled/);
    } finally {
      await setDisabled(false);
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
    expect(await ownerOf(pageId)).toBe(spaceOf[adminA]);
  });

  it('a member never reads an admin’s item, even with a team row (0179)', async () => {
    // Force a 'team' row an admin cannot set (a promoted member's
    // leftover). The member's own shared note is the contrast.
    await m.systemDb.execute(sqlTag`
      update space_items set sharing = 'team' where node_id = ${bNoteId}`);
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
    } finally {
      await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${other}`);
      await m.systemDb.execute(sqlTag`delete from auth.users where id = ${other}`);
    }
  });
});
