/**
 * Comments on personal items and the space_item_changed event, on a real
 * migrated Postgres (member logins Phase 2). Threads are stored with the
 * brain's id; row security decides who reads them (migration 0168).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/member-space-comments.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('member personal space: comments and change events', () => {
  type Db = typeof import('@mantle/db');
  type Space = typeof import('./member-space');
  type Comments = typeof import('./member-space-comments');
  let m: Db;
  let sp: Space;
  let cm: Comments;
  let sqlTag: typeof import('drizzle-orm').sql;
  let unlisten: () => Promise<void>;
  const events: { id: string; spaceId: string; kind: string; team: boolean }[] = [];
  const tag = `mscomm-${randomUUID().slice(0, 8)}`;
  const loginA = randomUUID();
  const loginB = randomUUID();
  let spaceA: string;
  let spaceB: string;
  let anchor: string;
  let madeAnchor = false;
  const brainPage = randomUUID();

  const asA = <T>(fn: () => Promise<T>) => m.withSpace({ spaceId: spaceA, loginId: loginA }, fn);
  const asB = <T>(fn: () => Promise<T>) => m.withSpace({ spaceId: spaceB, loginId: loginB }, fn);
  const A = { loginId: loginA, name: 'Ann' };
  const B = { loginId: loginB, name: 'Ben' };
  const settle = () => new Promise((r) => setTimeout(r, 250));

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sp = await import('./member-space');
    cm = await import('./member-space-comments');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    const sub = await admin.listen('space_item_changed', (p: string) => {
      const c = JSON.parse(p);
      if (typeof c?.id === 'string') events.push(c);
    });
    unlisten = () => sub.unlisten();

    const found = (
      (await m.systemDb.execute(sqlTag`select mantle_brain_id() as id`)) as unknown as {
        id: string | null;
      }[]
    )[0]?.id;
    if (found) anchor = found;
    else {
      anchor = randomUUID();
      madeAnchor = true;
      await m.systemDb.execute(sqlTag`
        insert into auth.users (id, email, password_hash, is_owner)
        values (${anchor}, ${`${tag}-owner@example.invalid`}, 'x', true)`);
    }
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${loginA}, ${`${tag}-a@example.invalid`}, 'x', 'member'),
        (${loginB}, ${`${tag}-b@example.invalid`}, 'x', 'member')`);
    const rows = (await m.systemDb.execute(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${loginA}, ${loginB})`)) as unknown as {
      id: string;
      login_id: string;
    }[];
    spaceA = rows.find((r) => r.login_id === loginA)!.id;
    spaceB = rows.find((r) => r.login_id === loginB)!.id;
    // A brain item at the team level with an admin thread on it.
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience)
      values (${brainPage}, ${anchor}, 'page', ${`${tag} library`}, 'pages', 'team')`);
    await m.systemDb.execute(sqlTag`
      insert into node_comments (owner_id, node_id, author_kind, login_id, author_name, body)
      values (${anchor}, ${brainPage}, 'owner', ${anchor}, 'Admin', 'admin only talk')`);
  });

  afterAll(async () => {
    await unlisten();
    await m.systemDb.execute(sqlTag`delete from nodes where id = ${brainPage}`);
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id in (${spaceA}, ${spaceB})`);
    await m.systemDb.execute(sqlTag`delete from spaces where login_id in (${loginA}, ${loginB})`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id in (${loginA}, ${loginB})`);
    if (madeAnchor) {
      await m.systemDb.execute(sqlTag`delete from spaces where id = ${anchor}`);
      await m.systemDb.execute(sqlTag`delete from auth.users where id = ${anchor}`);
    }
    await m.closeDb();
  });

  let pageId: string;

  it('a private item is closed for comments; its create event reaches only its space', async () => {
    const page = await asA(() => sp.createMineItem(spaceA, { type: 'page', title: `${tag} p` }));
    pageId = page.id;
    await expect(
      asA(() => cm.addMineComment(spaceA, anchor, pageId, A, 'hello')),
    ).rejects.toMatchObject({ reason: 'not-shared' });
    await settle();
    expect(events.filter((e) => e.id === pageId)).toEqual([
      { id: pageId, spaceId: spaceA, kind: 'created', team: false },
    ]);
  });

  it('shared: the author and a teammate talk; the thread is kept with the brain id', async () => {
    await asA(() => sp.setSharing(spaceA, pageId, 'team'));
    const a1 = await asA(() => cm.addMineComment(spaceA, anchor, pageId, A, 'first'));
    const b1 = await m.withTeamDrafts(() => cm.addTeamDraftComment(anchor, pageId, B, 'reply'));
    expect([a1.ownerId, b1.ownerId]).toEqual([anchor, anchor]);
    expect([a1.loginId, b1.loginId]).toEqual([loginA, loginB]);
    const seenByA = await asA(() => cm.listMineComments(spaceA, pageId));
    const seenByB = await m.withTeamDrafts(() => cm.listTeamDraftComments(pageId));
    expect(seenByA?.map((c) => c.body)).toEqual(['first', 'reply']);
    expect(seenByB?.map((c) => c.body)).toEqual(['first', 'reply']);
  });

  it('nobody deletes another login’s comment', async () => {
    const [first, reply] = (await asA(() => cm.listMineComments(spaceA, pageId)))!;
    expect(await m.withTeamDrafts(() => cm.deleteTeamDraftComment(pageId, loginB, first!.id))).toBe(
      false,
    );
    expect(await asA(() => cm.deleteMineComment(spaceA, pageId, reply!.id))).toBe(false);
    expect(await m.withTeamDrafts(() => cm.deleteTeamDraftComment(pageId, loginB, reply!.id))).toBe(
      true,
    );
    expect((await asA(() => cm.listMineComments(spaceA, pageId)))?.map((c) => c.body)).toEqual([
      'first',
    ]);
  });

  it('the team role never reads a brain thread, nor a private item’s', async () => {
    const leaked = await m.withTeamDrafts(() =>
      m.db
        .select()
        .from(m.nodeComments)
        .where(sqlTag`${m.nodeComments.nodeId} = ${brainPage}`),
    );
    expect(leaked).toEqual([]);
    await asA(() => sp.setSharing(spaceA, pageId, 'private'));
    expect(await m.withTeamDrafts(() => cm.listTeamDraftComments(pageId))).toBeNull();
    const raw = await m.withTeamDrafts(() =>
      m.db
        .select()
        .from(m.nodeComments)
        .where(sqlTag`${m.nodeComments.nodeId} = ${pageId}`),
    );
    expect(raw).toEqual([]);
    // Another member's space never sees it either.
    expect(await asB(() => cm.listMineComments(spaceB, pageId))).toBeNull();
  });

  it('submitted: the author may comment (the review discussion)', async () => {
    await asA(() => sp.submitItem(spaceA, pageId));
    const c = await asA(() => cm.addMineComment(spaceA, anchor, pageId, A, 'ready for review'));
    expect(c.body).toBe('ready for review');
  });

  it('events: state changes reach teammates while shared; a rolled-back write sends none', async () => {
    await settle();
    const kinds = events.filter((e) => e.id === pageId).map((e) => `${e.kind}:${e.team}`);
    expect(kinds).toEqual([
      'created:false',
      'state:true', // shared
      'comment:true',
      'comment:true',
      'comment:true', // the teammate's delete
      'state:true', // unshared: teammates must drop it
      'state:false', // submitted while private
      'comment:false',
    ]);
    // Other test files write to this database at the same time: count this
    // space's events only.
    const mine = () => events.filter((e) => e.spaceId === spaceA).length;
    const before = mine();
    await expect(
      asA(async () => {
        await sp.createMineItem(spaceA, { type: 'note', title: `${tag} rolled back` });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await settle();
    expect(mine()).toBe(before);
  });
});
