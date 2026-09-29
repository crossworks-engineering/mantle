/**
 * The client thread on a client-level brain item (client logins C5,
 * decision 8), on a real migrated Postgres: clients and members read and
 * write it while the item is at client level; nothing of it below admin
 * otherwise.
 *
 * The leak fixture: the team, admin and public items and a member's
 * team-shared item already HOLD comments with thread_scope 'client' (written
 * on the admin pool), so only the item rule (a brain item at client level)
 * keeps them out. On the client-level item itself an admin's 'team' comment
 * sits next to the client thread, so only the scope rule hides it.
 *
 * Brain items belong to the shared test anchor (mantle_brain_id()): the
 * rules know only that brain. Removes its rows after (the anchor stays).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/client-thread.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the client thread on a client-level item', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sp: typeof import('./member-space');
  let ct: typeof import('./client-thread');
  let nc: typeof import('./node-comments');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `cthread-${randomUUID().slice(0, 8)}`;
  let brain = '';
  const client = randomUUID();
  const member = randomUUID();
  const adminLogin = randomUUID();
  const logins = [client, member, adminLogin];
  const spaceOf: Record<string, string> = {};
  const items = {
    client: randomUUID(),
    raise: randomUUID(),
    team: randomUUID(),
    admin: randomUUID(),
    pub: randomUUID(),
  };
  let personal = '';

  const C = { kind: 'client' as const, loginId: client, name: 'Cleo Client' };
  const M = { kind: 'member' as const, loginId: member, name: 'Mia' };
  const asClient = <T>(fn: () => Promise<T>) => m.withHumanViewer('client', fn);
  const asMember = <T>(fn: () => Promise<T>) => m.withHumanViewer('team', fn);
  const bodies = (rows: { body: string }[] | null) => rows?.map((r) => r.body) ?? null;
  /** Every comment on `ids` the current scope's row security shows. */
  const rawComments = async (ids: string[]) =>
    (
      (await m.db.execute(
        sqlTag`select body from node_comments where node_id in (${sqlTag.join(ids, sqlTag`, `)})`,
      )) as unknown as { body: string }[]
    ).map((r) => r.body);
  const seed = (nodeId: string, body: string, scope: string, kind = 'owner') =>
    m.systemDb.execute(sqlTag`
      insert into node_comments (owner_id, node_id, author_kind, login_id, author_name, body, thread_scope)
      values (${brain}, ${nodeId}, ${kind}, ${adminLogin}, 'Admin', ${body}, ${scope})`);
  const setAudience = (id: string, audience: string) =>
    m.systemDb.execute(sqlTag`update nodes set audience = ${audience} where id = ${id}`);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sp = await import('./member-space');
    ct = await import('./client-thread');
    nc = await import('./node-comments');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    brain = await ensureTestAnchor(admin);
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${client}, ${`${tag}-c@example.invalid`}, 'x', 'client', 'Cleo Client'),
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member', 'Mia'),
        (${adminLogin}, ${`${tag}-a@example.invalid`}, 'x', 'admin', null)`);
    const rows = (await m.systemDb.execute(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${client}, ${member}, ${adminLogin})`)) as unknown as {
      id: string;
      login_id: string;
    }[];
    for (const r of rows) spaceOf[r.login_id] = r.id;
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${items.client}, ${brain}, 'note', ${`${tag} client note`}, 'notes', 'client'),
        (${items.raise}, ${brain}, 'note', ${`${tag} to raise`}, 'notes', 'client'),
        (${items.team}, ${brain}, 'note', ${`${tag} team note`}, 'notes', 'team'),
        (${items.admin}, ${brain}, 'note', ${`${tag} admin note`}, 'notes', 'admin'),
        (${items.pub}, ${brain}, 'note', ${`${tag} public note`}, 'notes', 'public')`);
    // A member's item shared with the team, at client level by hand: the
    // team role reads the node (team drafts), so only the brain-item rule
    // keeps its thread out.
    const S = spaceOf[member]!;
    personal = (
      await m.withSpace({ spaceId: S, loginId: member }, () =>
        sp.createMineItem(S, { type: 'note', title: `${tag} personal`, content: 'x' }),
      )
    ).id;
    await m.systemDb.execute(
      sqlTag`update space_items set sharing = 'team' where node_id = ${personal}`,
    );
    await setAudience(personal, 'client');

    await seed(items.client, 'hello clients', 'client');
    await seed(items.client, 'admin only talk', 'team');
    await seed(items.raise, 'raise me', 'client');
    for (const id of [items.team, items.admin, items.pub, personal]) {
      await seed(id, `forbidden on ${id}`, 'client');
    }
  }, 60_000);

  afterAll(async () => {
    for (const id of Object.values(items)) {
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${id}`);
    }
    for (const l of logins) {
      await m.systemDb.execute(sqlTag`delete from nodes where owner_id in
        (select id from spaces where login_id = ${l})`);
      await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${l}`);
      await m.systemDb.execute(sqlTag`delete from auth.users where id = ${l}`);
    }
    await m.closeDb();
  });

  it('a client reads the client thread of a client-level item, not the admin talk', async () => {
    expect(bodies(await asClient(() => ct.listClientThread(brain, items.client)))).toEqual([
      'hello clients',
    ]);
    // Row security holds the same line, not only the function's filter.
    expect(await asClient(() => rawComments([items.client]))).toEqual(['hello clients']);
  });

  it('a client writes on it, as itself; members and clients both read it', async () => {
    const row = await ct.addClientThreadComment(brain, items.client, C, 'from the client');
    expect(row).toMatchObject({
      ownerId: brain,
      authorKind: 'client',
      loginId: client,
      authorName: 'Cleo Client',
      threadScope: 'client',
    });
    expect(nc.toNodeCommentDto(row!, { loginId: client }).mine).toBe(true);
    expect(nc.toNodeCommentDto(row!, { loginId: member }).mine).toBe(false);
    const want = ['hello clients', 'from the client'];
    expect(bodies(await asClient(() => ct.listClientThread(brain, items.client)))).toEqual(want);
    expect(bodies(await asMember(() => ct.listClientThread(brain, items.client)))).toEqual(want);
  });

  it('a client cannot read or write the thread of any other item', async () => {
    for (const id of [items.team, items.admin, items.pub, personal]) {
      expect(await asClient(() => ct.listClientThread(brain, id)), id).toBeNull();
      expect(await ct.addClientThreadComment(brain, id, C, 'leak'), id).toBeNull();
    }
    expect(
      await asClient(() => rawComments([items.team, items.admin, items.pub, personal])),
    ).toEqual([]);
  });

  it('a member reads and writes it on a client-level item; any other item is a 404', async () => {
    const row = await ct.addClientThreadComment(brain, items.client, M, 'from the team');
    expect(row).toMatchObject({ authorKind: 'member', authorName: 'Mia', threadScope: 'client' });
    expect(bodies(await asClient(() => ct.listClientThread(brain, items.client)))).toContain(
      'from the team',
    );
    for (const id of [items.team, items.admin, items.pub, personal]) {
      expect(await asMember(() => ct.listClientThread(brain, id)), id).toBeNull();
      expect(await ct.addClientThreadComment(brain, id, M, 'leak'), id).toBeNull();
    }
    // The team role reads the team item and the team-shared personal item
    // (their nodes), yet none of their 'client' comments.
    expect(
      await asMember(() => rawComments([items.team, items.admin, items.pub, personal])),
    ).toEqual([]);
    expect((await asMember(() => rawComments([items.client]))).sort()).toEqual(
      ['from the client', 'from the team', 'hello clients'].sort(),
    );
  });

  it('after the item is raised to team, clients and members read nothing of it', async () => {
    expect(bodies(await asClient(() => ct.listClientThread(brain, items.raise)))).toEqual([
      'raise me',
    ]);
    await setAudience(items.raise, 'team');
    try {
      expect(await asClient(() => ct.listClientThread(brain, items.raise))).toBeNull();
      expect(await asClient(() => rawComments([items.raise]))).toEqual([]);
      expect(await asMember(() => ct.listClientThread(brain, items.raise))).toBeNull();
      expect(await asMember(() => rawComments([items.raise]))).toEqual([]);
      expect(await ct.addClientThreadComment(brain, items.raise, C, 'late')).toBeNull();
    } finally {
      await setAudience(items.raise, 'client');
    }
  });

  it('without the human flag the client and team roles read 0 rows', async () => {
    expect(await m.withViewer('client', () => rawComments([items.client]))).toEqual([]);
    expect(await m.withViewer('team', () => rawComments([items.client]))).toEqual([]);
    expect(await m.withViewer('client', () => ct.listClientThread(brain, items.client))).toEqual(
      [],
    );
  });

  it('deletes only the caller’s own comment on the thread', async () => {
    const mine = await ct.addClientThreadComment(brain, items.client, C, 'take me back');
    const theirs = await ct.addClientThreadComment(brain, items.client, M, 'member keeps');
    // A client cannot delete a member's comment, nor as the wrong kind.
    expect(await ct.deleteClientThreadComment(brain, items.client, C, theirs!.id)).toBe(false);
    expect(
      await ct.deleteClientThreadComment(
        brain,
        items.client,
        { kind: 'member', loginId: client },
        mine!.id,
      ),
    ).toBe(false);
    expect(await ct.deleteClientThreadComment(brain, items.client, C, mine!.id)).toBe(true);
    expect(await ct.deleteClientThreadComment(brain, items.client, M, theirs!.id)).toBe(true);
    const left = bodies(await asClient(() => ct.listClientThread(brain, items.client)));
    expect(left).not.toContain('take me back');
    expect(left).not.toContain('member keeps');
  });

  it('an admin’s comment on a client-level item joins the client thread, under the name', async () => {
    const owner = {
      kind: 'owner' as const,
      loginId: adminLogin,
      name: `${tag}-a@example.invalid`,
      clientName: 'Ada',
    };
    const onClient = await nc.addNodeComment(brain, items.client, owner, 'from the admin');
    expect(onClient).toMatchObject({ threadScope: 'client', authorName: 'Ada' });
    expect(bodies(await asClient(() => ct.listClientThread(brain, items.client)))).toContain(
      'from the admin',
    );
    expect(bodies(await asMember(() => ct.listClientThread(brain, items.client)))).toContain(
      'from the admin',
    );
    // On a team item it stays the admins' own, as before.
    const onTeam = await nc.addNodeComment(brain, items.team, owner, 'admin on team');
    expect(onTeam).toMatchObject({ threadScope: 'team', authorName: owner.name });
    // An agent never writes into what clients read.
    const agent = await nc.addNodeComment(
      brain,
      items.client,
      { kind: 'agent', name: 'Helper' },
      'agent note',
    );
    expect(agent?.threadScope).toBe('team');
    expect(bodies(await asClient(() => ct.listClientThread(brain, items.client)))).not.toContain(
      'agent note',
    );
    // The owner reads every scope.
    expect((await nc.listNodeComments(brain, items.client)).map((c) => c.body)).toEqual(
      expect.arrayContaining(['admin only talk', 'from the admin', 'agent note']),
    );
  });
});
