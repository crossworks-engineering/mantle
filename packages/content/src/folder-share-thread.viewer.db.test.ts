/**
 * The client thread on a FOLDER-shared item (folder plan phase 4, with client
 * logins C5 decision 8), on a real migrated Postgres: an item read at client
 * level through a folder shared with clients carries the client thread, by
 * the union rule the row policy uses (own level OR inherited share). Clients
 * and members read and write it; the admins' person comments join it. An
 * item in a team-shared or unshared folder has none, and unsharing the
 * folder takes the thread away again.
 *
 * The leak fixture: the items in the team-shared and unshared folders
 * already HOLD comments with thread_scope 'client' (written on the admin
 * pool), so only the item rule keeps them out.
 *
 * Rows belong to the shared test anchor, under folders of this run's own.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/folder-share-thread.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the client thread on a folder-shared item', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let tree: typeof import('./tree/index');
  let ct: typeof import('./client-thread');
  let nc: typeof import('./node-comments');
  let usage: typeof import('./client-admin-usage');
  let sqlTag: typeof import('drizzle-orm').sql;
  let brain = '';
  const label = `fst${randomUUID().slice(0, 8)}`;
  const clientPath = `notes.${label}_client`;
  const teamPath = `notes.${label}_team`;
  const plainPath = `notes.${label}_plain`;
  const ids = {
    clientF: randomUUID(),
    teamF: randomUUID(),
    plainF: randomUUID(),
    /** Admin by its own level, in the client-shared folder. */
    adminInClient: randomUUID(),
    /** Public by its own level, in the client-shared folder: read at client
     *  through the folder (the union rule). */
    publicInClient: randomUUID(),
    /** Admin, in the folder shared with the team only. */
    adminInTeam: randomUUID(),
    /** Admin, in a folder nobody shared. */
    adminPlain: randomUUID(),
  };
  const client = randomUUID();
  const member = randomUUID();
  const adminLogin = randomUUID();
  const logins = [client, member, adminLogin];

  const C = { kind: 'client' as const, loginId: client, name: 'Cleo Client' };
  const M = { kind: 'member' as const, loginId: member, name: 'Mia' };
  const asClient = <T>(fn: () => Promise<T>) => m.withHumanViewer('client', fn);
  const asMember = <T>(fn: () => Promise<T>) => m.withHumanViewer('team', fn);
  const bodies = (rows: { body: string }[] | null) => rows?.map((r) => r.body) ?? null;
  const rawComments = async (nodeIds: string[]) =>
    (
      (await m.db.execute(
        sqlTag`select body from node_comments where node_id in (${sqlTag.join(nodeIds, sqlTag`, `)})`,
      )) as unknown as { body: string }[]
    ).map((r) => r.body);
  const insert = (id: string, type: string, path: string, audience = 'admin') =>
    m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience, data, tags)
      values (${id}, ${brain}, ${type}::node_type, ${`${label} ${type}`}, ${path}::ltree,
              ${audience}, ${type === 'note' ? JSON.stringify({ content: 'x' }) : '{}'}::jsonb,
              '{}')`);
  const share = (id: string, level: string | null) =>
    m.systemDb.execute(sqlTag`update nodes set share_level = ${level} where id = ${id}`);
  const seed = (nodeId: string, body: string, scope: string, kind = 'owner') =>
    m.systemDb.execute(sqlTag`
      insert into node_comments (owner_id, node_id, author_kind, login_id, author_name, body, thread_scope)
      values (${brain}, ${nodeId}, ${kind}, ${adminLogin}, 'Admin', ${body}, ${scope})`);
  const forbidden = () => [ids.adminInTeam, ids.adminPlain];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tree = await import('./tree/index');
    ct = await import('./client-thread');
    nc = await import('./node-comments');
    usage = await import('./client-admin-usage');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    brain = await ensureTestAnchor(admin);
    await tree.ensureKindRoot(brain, 'notes');
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${client}, ${`${label}-c@example.invalid`}, 'x', 'client', 'Cleo Client'),
        (${member}, ${`${label}-m@example.invalid`}, 'x', 'member', 'Mia'),
        (${adminLogin}, ${`${label}-a@example.invalid`}, 'x', 'admin', null)`);
    await insert(ids.clientF, 'branch', clientPath);
    await insert(ids.teamF, 'branch', teamPath);
    await insert(ids.plainF, 'branch', plainPath);
    await insert(ids.adminInClient, 'note', clientPath);
    await insert(ids.publicInClient, 'note', clientPath, 'public');
    await insert(ids.adminInTeam, 'note', teamPath);
    await insert(ids.adminPlain, 'note', plainPath);
    await share(ids.clientF, 'client');
    await share(ids.teamF, 'team');

    await seed(ids.adminInClient, 'hello folder clients', 'client');
    await seed(ids.adminInClient, 'admin only talk', 'team');
    for (const id of forbidden()) await seed(id, `forbidden on ${id}`, 'client');
  }, 60_000);

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${brain}
      and (path <@ ${clientPath}::ltree or path <@ ${teamPath}::ltree or path <@ ${plainPath}::ltree)`);
    for (const l of logins) {
      await m.systemDb.execute(sqlTag`delete from nodes where owner_id in
        (select id from spaces where login_id = ${l})`);
      await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${l}`);
      await m.systemDb.execute(sqlTag`delete from auth.users where id = ${l}`);
    }
    await m.closeDb();
  });

  it('the fixture: the items inherit their folders’ shares', async () => {
    const rows = (await m.systemDb.execute(sqlTag`
      select id, inherited_level from nodes
       where id in (${ids.adminInClient}, ${ids.publicInClient}, ${ids.adminInTeam}, ${ids.adminPlain})`)) as unknown as {
      id: string;
      inherited_level: string | null;
    }[];
    const byId = new Map(rows.map((r) => [r.id, r.inherited_level]));
    expect(byId.get(ids.adminInClient)).toBe('client');
    expect(byId.get(ids.publicInClient)).toBe('client');
    expect(byId.get(ids.adminInTeam)).toBe('team');
    expect(byId.get(ids.adminPlain)).toBeNull();
  });

  it('a client reads the client thread of an item in a client-shared folder, not the admin talk', async () => {
    expect(bodies(await asClient(() => ct.listClientThread(brain, ids.adminInClient)))).toEqual([
      'hello folder clients',
    ]);
    // Row security holds the same line, not only the function's filter.
    expect(await asClient(() => rawComments([ids.adminInClient]))).toEqual([
      'hello folder clients',
    ]);
  });

  it('clients and members write on it and both read it', async () => {
    const byClient = await ct.addClientThreadComment(
      brain,
      ids.adminInClient,
      C,
      'from the client',
    );
    expect(byClient).toMatchObject({ authorKind: 'client', threadScope: 'client' });
    const byMember = await ct.addClientThreadComment(brain, ids.adminInClient, M, 'from the team');
    expect(byMember).toMatchObject({ authorKind: 'member', threadScope: 'client' });
    const want = ['hello folder clients', 'from the client', 'from the team'];
    expect(bodies(await asClient(() => ct.listClientThread(brain, ids.adminInClient)))).toEqual(
      want,
    );
    expect(bodies(await asMember(() => ct.listClientThread(brain, ids.adminInClient)))).toEqual(
      want,
    );
  });

  it('a public item read at client through the folder carries the thread too', async () => {
    expect(
      await ct.addClientThreadComment(brain, ids.publicInClient, C, 'on the public one'),
    ).toMatchObject({
      threadScope: 'client',
    });
    expect(bodies(await asClient(() => ct.listClientThread(brain, ids.publicInClient)))).toEqual([
      'on the public one',
    ]);
  });

  it('an item in a team-shared or unshared folder has no client thread', async () => {
    for (const id of forbidden()) {
      expect(await asClient(() => ct.listClientThread(brain, id)), id).toBeNull();
      expect(await asMember(() => ct.listClientThread(brain, id)), id).toBeNull();
      expect(await ct.addClientThreadComment(brain, id, C, 'leak'), id).toBeNull();
      expect(await ct.addClientThreadComment(brain, id, M, 'leak'), id).toBeNull();
    }
    expect(await asClient(() => rawComments(forbidden()))).toEqual([]);
    // The team role reads the team-shared item's node, yet none of its
    // 'client' comments.
    expect(await asMember(() => rawComments(forbidden()))).toEqual([]);
  });

  it('an admin’s person comment joins the client thread; an agent’s never does', async () => {
    const owner = {
      kind: 'owner' as const,
      loginId: adminLogin,
      name: `${label}-a@example.invalid`,
      clientName: 'Ada',
    };
    expect(
      await nc.addNodeComment(brain, ids.adminInClient, owner, 'from the admin'),
    ).toMatchObject({ threadScope: 'client', authorName: 'Ada' });
    expect(bodies(await asClient(() => ct.listClientThread(brain, ids.adminInClient)))).toContain(
      'from the admin',
    );
    const agent = await nc.addNodeComment(
      brain,
      ids.adminInClient,
      { kind: 'agent', name: 'Helper' },
      'agent note',
    );
    expect(agent?.threadScope).toBe('team');
    // In a team-shared folder it stays the admins' own.
    expect(await nc.addNodeComment(brain, ids.adminInTeam, owner, 'admin on team')).toMatchObject({
      threadScope: 'team',
      authorName: owner.name,
    });
  });

  it('the admin usage report counts client comments on a folder-shared item', async () => {
    const rows = await usage.clientThreadActivity(brain, 1);
    const row = rows.find((r) => r.nodeId === ids.adminInClient);
    expect(row).toMatchObject({ clientComments: 1, lastClientName: 'Cleo Client' });
    expect(rows.find((r) => r.nodeId === ids.adminInTeam)).toBeUndefined();
  });

  it('after the folder is unshared, clients and members read nothing of it', async () => {
    await share(ids.clientF, null);
    try {
      for (const id of [ids.adminInClient, ids.publicInClient]) {
        expect(await asClient(() => ct.listClientThread(brain, id)), id).toBeNull();
        expect(await asMember(() => ct.listClientThread(brain, id)), id).toBeNull();
        expect(await ct.addClientThreadComment(brain, id, C, 'late'), id).toBeNull();
      }
      expect(await asClient(() => rawComments([ids.adminInClient, ids.publicInClient]))).toEqual(
        [],
      );
      expect(await asMember(() => rawComments([ids.adminInClient]))).toEqual([]);
      expect(
        (await usage.clientThreadActivity(brain, 1)).find((r) => r.nodeId === ids.adminInClient),
      ).toBeUndefined();
    } finally {
      await share(ids.clientF, 'client');
    }
  });

  it('without the human flag the client and team roles read 0 rows', async () => {
    expect(await m.withViewer('client', () => rawComments([ids.adminInClient]))).toEqual([]);
    expect(await m.withViewer('team', () => rawComments([ids.adminInClient]))).toEqual([]);
  });
});
