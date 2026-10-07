/**
 * Comments on personal items and the space_item_changed event, on a real
 * migrated Postgres (member logins Phase 2). Threads are stored with the
 * brain's id; row security decides who reads them (migration 0168).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/member-space-comments.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestAnchor, notifyBarrier, pollUntil } from '@mantle/db/test-support';

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
  const brainPage = randomUUID();

  const asA = <T>(fn: () => Promise<T>) => m.withSpace({ spaceId: spaceA, loginId: loginA }, fn);
  const asB = <T>(fn: () => Promise<T>) => m.withSpace({ spaceId: spaceB, loginId: loginB }, fn);
  const A = { loginId: loginA, name: 'Ann' };
  const B = { loginId: loginB, name: 'Ben' };
  /** Every space_item_changed event committed so far has arrived. */
  const settle = () =>
    notifyBarrier(
      (m.systemDb as unknown as { $client: Parameters<typeof notifyBarrier>[0] }).$client,
      'space_item_changed',
      {
        payload: (s) => JSON.stringify({ id: s }),
        seen: (s) => events.some((e) => e.id === s),
      },
    );

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

    // The shared test anchor (never deleted by a test).
    anchor = await ensureTestAnchor(admin);
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
  }, 60_000);

  afterAll(async () => {
    await unlisten();
    await m.systemDb.execute(sqlTag`delete from nodes where id = ${brainPage}`);
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id in (${spaceA}, ${spaceB})`);
    await m.systemDb.execute(sqlTag`delete from spaces where login_id in (${loginA}, ${loginB})`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id in (${loginA}, ${loginB})`);
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

  it('the team role reads a teammate thread only with the human flag (T1)', async () => {
    // A team-level agent runs on the same role without mantle.human: it must
    // see nothing, even on a team-shared item.
    const byAgent = await m.withViewer('team', () =>
      m.db
        .select()
        .from(m.nodeComments)
        .where(sqlTag`${m.nodeComments.nodeId} = ${pageId}`),
    );
    expect(byAgent).toEqual([]);
    const byMember = await m.withTeamDrafts(() =>
      m.db
        .select()
        .from(m.nodeComments)
        .where(sqlTag`${m.nodeComments.nodeId} = ${pageId}`),
    );
    expect(byMember.length).toBe(2);
    // The nodes rules hide a personal item from the plain team role too, so
    // the behaviour above holds even without the comment rule's own human
    // check. That check is the second layer: pin it so it cannot go quietly.
    const [policy] = (await m.systemDb.execute(sqlTag`
      select qual from pg_policies
      where tablename = 'node_comments' and policyname = 'node_comments_team_drafts_read'`)) as unknown as {
      qual: string;
    }[];
    expect(policy?.qual).toContain('mantle.human');
  });

  it('the space role writes only its own login’s comments, kept with the brain id (T1)', async () => {
    const forge = (loginId: string, ownerId: string) =>
      asA(() =>
        m.db.insert(m.nodeComments).values({
          ownerId,
          nodeId: pageId,
          authorKind: 'member',
          loginId,
          authorName: 'Forged',
          body: 'forged',
        }),
      );
    // Another login's name on the comment.
    await expect(forge(loginB, anchor)).rejects.toThrow();
    // Stored under the personal space instead of the brain.
    await expect(forge(loginA, spaceA)).rejects.toThrow();
    const bodies = (await asA(() => cm.listMineComments(spaceA, pageId)))?.map((c) => c.body);
    expect(bodies).not.toContain('forged');
  });

  it('an owner read never reaches a personal item’s thread (S7)', async () => {
    const nc = await import('./node-comments');
    const [first] = (await asA(() => cm.listMineComments(spaceA, pageId)))!;
    // Stored with the brain's id, but the node is a space's: not the owner's.
    expect(await nc.listNodeComments(anchor, pageId)).toEqual([]);
    expect(await nc.getNodeComment(anchor, first!.id)).toBeNull();
    expect(await nc.deleteNodeComment(anchor, first!.id)).toBe(false);
    // The brain's own thread still reads.
    expect((await nc.listNodeComments(anchor, brainPage)).map((c) => c.body)).toEqual([
      'admin only talk',
    ]);
  });

  it('the owner comments channel carries brain nodes only (S7)', async () => {
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    const seen: string[] = [];
    const sub = await admin.listen('comments_changed', (p: string) => {
      seen.push(String(JSON.parse(p)?.nodeId));
    });
    try {
      await asA(() => cm.addMineComment(spaceA, anchor, pageId, A, 'quiet'));
      await m.systemDb.execute(sqlTag`
        insert into node_comments (owner_id, node_id, author_kind, login_id, author_name, body)
        values (${anchor}, ${brainPage}, 'owner', ${anchor}, 'Admin', 'loud')`);
      // Committed after the quiet one: once it is here, the quiet one would be.
      await pollUntil(() => seen.includes(brainPage), { what: 'the brain comment event' });
      expect(seen).toContain(brainPage);
      expect(seen).not.toContain(pageId);
    } finally {
      await sub.unlisten();
      await m.systemDb.execute(
        sqlTag`delete from node_comments where node_id = ${brainPage} and body = 'loud'`,
      );
      const mine = (await asA(() => cm.listMineComments(spaceA, pageId)))!;
      const quiet = mine.find((c) => c.body === 'quiet');
      if (quiet) await asA(() => cm.deleteMineComment(spaceA, pageId, quiet.id));
    }
  });

  it('only the level roles may map a login to its space (S10)', async () => {
    const denied = await asA(() =>
      m.db.execute(sqlTag`select mantle_personal_space(${loginB}::uuid) as id`),
    ).catch((err: { cause?: { code?: string } }) => err.cause?.code);
    expect(denied).toBe('42501');
    const rows = (await m.withViewer('team', () =>
      m.db.execute(sqlTag`select mantle_personal_space(${loginB}::uuid) as id`),
    )) as unknown as { id: string }[];
    expect(rows[0]?.id).toBe(spaceB);
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
      'comment:true', // S7's quiet comment and its delete
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
  // ── Batch 2: S6 split by audience, S4 atomic teammate write, S5 ───────────

  it('review talk stays hidden from teammates after the item is shared (S6)', async () => {
    // The page is submitted and private; 'ready for review' was review talk.
    await asA(() => sp.setSharing(spaceA, pageId, 'team'));
    const mine = (await asA(() => cm.listMineComments(spaceA, pageId)))!.map((c) => c.body);
    expect(mine).toContain('ready for review');
    const theirs = (await m.withTeamDrafts(() => cm.listTeamDraftComments(pageId)))!.map(
      (c) => c.body,
    );
    expect(theirs).toContain('first');
    expect(theirs).not.toContain('ready for review');
    // Row security holds the same line, whatever the app asks.
    const raw = await m.withTeamDrafts(() =>
      m.db
        .select()
        .from(m.nodeComments)
        .where(sqlTag`${m.nodeComments.nodeId} = ${pageId}`),
    );
    expect(raw.map((c) => c.body)).not.toContain('ready for review');
    // A comment the author writes while it is shared is the team's.
    await asA(() => cm.addMineComment(spaceA, anchor, pageId, A, 'team can see this'));
    const after = (await m.withTeamDrafts(() => cm.listTeamDraftComments(pageId)))!.map(
      (c) => c.body,
    );
    expect(after).toContain('team can see this');
  });

  it('a teammate takes back an own comment after an unshare (S6)', async () => {
    const b = await m.withTeamDrafts(() => cm.addTeamDraftComment(anchor, pageId, B, 'oops'));
    await asA(() => sp.setSharing(spaceA, pageId, 'private'));
    expect(await m.withTeamDrafts(() => cm.deleteTeamDraftComment(pageId, loginB, b.id))).toBe(
      true,
    );
    // Still never another login's comment.
    const [first] = (await asA(() => cm.listMineComments(spaceA, pageId)))!;
    expect(await m.withTeamDrafts(() => cm.deleteTeamDraftComment(pageId, loginB, first!.id))).toBe(
      false,
    );
  });

  it('a teammate comment on a private or deleted item is a 404, never written (S4)', async () => {
    // Private now (the test above unshared it).
    await expect(
      m.withTeamDrafts(() => cm.addTeamDraftComment(anchor, pageId, B, 'sneaky')),
    ).rejects.toMatchObject({ reason: 'not-found' });
    await expect(
      m.withTeamDrafts(() => cm.addTeamDraftComment(anchor, randomUUID(), B, 'ghost')),
    ).rejects.toMatchObject({ reason: 'not-found' });
    const bodies = (await asA(() => cm.listMineComments(spaceA, pageId)))!.map((c) => c.body);
    expect(bodies).not.toContain('sneaky');
  });

  it('the space role cannot re-point its own comment (S5)', async () => {
    const [own] = (await asA(() => cm.listMineComments(spaceA, pageId)))!.filter(
      (c) => c.loginId === loginA,
    );
    const moved = await asA(() =>
      m.db
        .update(m.nodeComments)
        .set({ ownerId: spaceA })
        .where(sqlTag`${m.nodeComments.id} = ${own!.id}`),
    ).catch((err: { cause?: { code?: string } }) => err.cause?.code ?? 'error');
    expect(moved).toBe('42501');
    // Postgres refuses that through the read rule already; the update rule's
    // own check is the second layer (S5). Pin it.
    const [policy] = (await m.systemDb.execute(sqlTag`
      select with_check from pg_policies
      where tablename = 'node_comments' and policyname = 'node_comments_space_update'`)) as unknown as {
      with_check: string;
    }[];
    expect(policy?.with_check).toContain('mantle_is_brain_space');
  });
});
