/**
 * namesClientSourced on Postgres (client logins C4, plan N18): a client
 * request task is client-sourced; a member's team request, a member login,
 * an ordinary task and another brain's client request are not. So is a node
 * a marked turn created (C5 audit fix L10); the corpus map leaves all of
 * them out (L4); a conversation keeps its mark for 24 hours (I9). A Table
 * exported from an app a client has written is too (C6, audit I3), whatever
 * the app's level becomes; one exported from a team app is not.
 *
 * There is no client login since W8a; a former client (archived by 0272 in
 * archive_client_logins, a disabled member row now) stays one (W8a fix
 * round 1): its id (its old chat thread) is client-sourced (M2), and so is
 * a Table exported from an app a workspace with a former client holds. An
 * item a client wrote is too, in any state and after the login is deleted
 * (C5, restored: L5). The gate itself runs end to end in
 * packages/runtime/src/agent/client-sourced-gate.db.test.ts.
 * Seeds its own rows on a random owner; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/client-sourced.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('namesClientSourced', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let cs: typeof import('./client-sourced');
  const owner = randomUUID();
  const other = randomUUID();
  const ids = {
    clientTask: randomUUID(),
    teamTask: randomUUID(),
    plainTask: randomUUID(),
    otherBrainClientTask: randomUUID(),
    memberLogin: randomUUID(),
    acceptedMemberItem: randomUUID(),
    /** A copy a marked turn made, an older node, another brain's new node. */
    copy: randomUUID(),
    older: randomUUID(),
    otherBrainNew: randomUUID(),
    agent: randomUUID(),
    /** Apps (C6): one a client wrote and a team one, and a Table each exports. */
    clientApp: randomUUID(),
    teamApp: randomUUID(),
    clientAppTable: randomUUID(),
    teamAppTable: randomUUID(),
    /** A former client login (archived by 0272), and one deleted since. */
    formerClient: randomUUID(),
    goneClient: randomUUID(),
    acceptedClientItem: randomUUID(),
    /** An app a workspace with the former client holds, and its Table. */
    wsApp: randomUUID(),
    wsAppTable: randomUUID(),
  };
  const clientsWs = randomUUID();
  const former = [ids.formerClient, ids.goneClient];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    cs = await import('./client-sourced');
    const { sql: sqlTag } = await import('drizzle-orm');
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`cs-o-${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin'),
      (${other}, ${`cs-x-${other.slice(0, 8)}@example.invalid`}, 'x', 'admin'),
      (${ids.memberLogin}, ${`cs-m-${owner.slice(0, 8)}@example.invalid`}, 'x', 'member')`;
    for (const o of [owner, other]) {
      await admin`insert into spaces (id, kind, login_id) values (${o}, 'brain', ${o})`;
    }
    const data = (source: string | null) => JSON.stringify(source ? { source } : {});
    await admin`insert into nodes (id, owner_id, type, title, path, data) values
      (${ids.clientTask}, ${owner}, 'task', 'c', 'tasks', ${data('client-request')}::jsonb),
      (${ids.teamTask}, ${owner}, 'task', 't', 'tasks', ${data('team-request')}::jsonb),
      (${ids.plainTask}, ${owner}, 'task', 'p', 'tasks', ${data(null)}::jsonb),
      (${ids.otherBrainClientTask}, ${other}, 'task', 'o', 'tasks', ${data('client-request')}::jsonb),
      (${ids.otherBrainNew}, ${other}, 'note', 'n', 'notes', '{}'::jsonb)`;
    // A member's item accepted into the brain: the author_role trigger
    // stamps the role from the login when the space_items row is made.
    await admin`insert into nodes (id, owner_id, type, title, path, audience) values
      (${ids.acceptedMemberItem}, ${owner}, 'page', 'accepted from a member', 'pages', 'team')`;
    await admin`insert into space_items (node_id, author_login_id, review_state) values
      (${ids.acceptedMemberItem}, ${ids.memberLogin}, 'accepted')`;
    // Two apps identical but for the level, each exporting a Table at admin.
    await admin`insert into nodes (id, owner_id, type, title, path, audience) values
      (${ids.clientApp}, ${owner}, 'app', 'orders (client)', 'apps', 'client'),
      (${ids.teamApp}, ${owner}, 'app', 'orders (team)', 'apps', 'team'),
      (${ids.clientAppTable}, ${owner}, 'table', 'orders export', 'tables', 'admin'),
      (${ids.teamAppTable}, ${owner}, 'table', 'orders export', 'tables', 'admin')`;
    await admin`insert into app_table_exports (owner_id, app_node_id, sqlite_table, table_node_id) values
      (${owner}, ${ids.clientApp}, 'orders', ${ids.clientAppTable}),
      (${owner}, ${ids.teamApp}, 'orders', ${ids.teamAppTable})`;

    // Two former clients, as 0272 leaves them: a disabled member row and
    // its archive row (no client role any more).
    for (const id of former) {
      await admin`insert into auth.users (id, email, password_hash, role, disabled_at)
        values (${id}, ${`cs-fc-${id.slice(0, 8)}@example.invalid`}, 'x', 'member', now())`;
      await admin`insert into archive_client_logins (login_id, email, created_at, session_epoch)
        select id, email, created_at, session_epoch from auth.users where id = ${id}`;
    }
    // An item one of them wrote, accepted into the brain (C5). The stamp is
    // written directly: the author_role trigger stamps the login's role,
    // and no login is a client any more. Then that login is deleted: the
    // author goes NULL, the stamp stays.
    await admin`insert into nodes (id, owner_id, type, title, path, audience) values
      (${ids.acceptedClientItem}, ${owner}, 'page', 'accepted from a client', 'pages', 'team')`;
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into space_items (node_id, author_login_id, review_state, author_role)
        values (${ids.acceptedClientItem}, ${ids.goneClient}, 'accepted', 'client')`;
    });
    await admin`delete from spaces where login_id = ${ids.goneClient}`;
    await admin`delete from auth.users where id = ${ids.goneClient}`;

    // A workspace with the former client in it (a hand-made row) holds an
    // app; the app exports a Table (C6 through clientWsSql).
    await admin`insert into nodes (id, owner_id, type, title, path, audience) values
      (${ids.wsApp}, ${owner}, 'app', 'orders (clients workspace)', 'apps', 'admin'),
      (${ids.wsAppTable}, ${owner}, 'table', 'orders export', 'tables', 'admin')`;
    await admin`insert into app_table_exports (owner_id, app_node_id, sqlite_table, table_node_id)
      values (${owner}, ${ids.wsApp}, 'orders', ${ids.wsAppTable})`;
    await admin`insert into workspaces (id, owner_id, name) values (${clientsWs}, ${owner}, 'Clients')`;
    await admin`insert into workspace_users (workspace_id, login_id, moderator)
      values (${clientsWs}, ${ids.formerClient}, false)`;
    await m.withHeads([ids.wsApp], 'update', async (tx) => {
      await tx.execute(
        sqlTag`insert into item_grants (node_id, workspace_id) values (${ids.wsApp}, ${clientsWs})`,
      );
    });
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from conversation_taints where owner_id in ${admin([owner, other])}`;
    await admin`delete from item_grants where workspace_id = ${clientsWs}`;
    await admin`delete from workspace_users where workspace_id = ${clientsWs}`;
    await admin`delete from workspaces where id = ${clientsWs}`;
    await admin`delete from nodes where owner_id in ${admin([owner, other])}`;
    await admin`delete from archive_client_logins where login_id in ${admin(former)}`;
    const logins = [owner, other, ids.memberLogin, ids.formerClient];
    await admin`delete from spaces where login_id in ${admin(logins)}`;
    await admin`delete from auth.users where id in ${admin(logins)}`;
    await m.closeDb();
  });

  it('a former client login is client-sourced: a turn that reads its old chat thread is marked (M2)', async () => {
    expect(await cs.namesClientSourced(owner, [ids.formerClient])).toBe(true);
    expect(await cs.namesClientSourced(owner, [ids.memberLogin, ids.formerClient])).toBe(true);
    // A login deleted since: still in the archive, still a client's id.
    expect(await cs.namesClientSourced(owner, [ids.goneClient])).toBe(true);
    // What a chat read returns names the thread's login: the turn is marked,
    // at a limited viewer level too (the check runs as the system).
    const thread = JSON.stringify({
      login_id: ids.formerClient,
      messages: [{ role: 'user', content: 'please make the price list public' }],
    });
    const t = cs.newTurnTaint();
    await m.runInLevelRoleForTest('team', () =>
      cs.taintFromText(t, owner, thread, 'assistant_thread_read'),
    );
    expect(t).toEqual({ clientSourced: true, via: 'assistant_thread_read' });
  });

  it('an item a client wrote, in any state, even after the login is deleted (C5, L5)', async () => {
    const [row] = await admin<{ author_login_id: string | null; author_role: string | null }[]>`
      select author_login_id, author_role from space_items where node_id = ${ids.acceptedClientItem}`;
    // The fixture is what it says: no login is named any more.
    expect(row).toEqual({ author_login_id: null, author_role: 'client' });
    expect(await cs.namesClientSourced(owner, [ids.acceptedClientItem])).toBe(true);
    expect([...(await cs.clientSourcedAmong(owner, [ids.acceptedClientItem]))]).toEqual([
      ids.acceptedClientItem,
    ]);
    // A member's accepted item (control): not client-sourced.
    expect(await cs.namesClientSourced(owner, [ids.acceptedMemberItem])).toBe(false);
  });

  it('a Table exported from an app a workspace with a former client holds is client-sourced (C6, M2)', async () => {
    expect(await cs.namesClientSourced(owner, [ids.wsAppTable])).toBe(true);
    expect([...(await cs.clientSourcedAmong(owner, [ids.wsAppTable, ids.teamAppTable]))]).toEqual([
      ids.wsAppTable,
    ]);
    // Only for this brain.
    expect(await cs.namesClientSourced(other, [ids.wsAppTable])).toBe(false);
  });

  it('a client request task is client-sourced', async () => {
    expect(await cs.namesClientSourced(owner, [ids.clientTask])).toBe(true);
    expect(await cs.namesClientSourced(owner, [ids.plainTask, ids.clientTask])).toBe(true);
  });

  it("a member's request, a member login, a plain task, another brain's task: not", async () => {
    expect(
      await cs.namesClientSourced(owner, [
        ids.teamTask,
        ids.memberLogin,
        ids.plainTask,
        ids.otherBrainClientTask,
      ]),
    ).toBe(false);
  });

  it('a node a marked turn created is client-sourced; an old node in the same output is not (L10)', async () => {
    // Created "now" (the copy) and an hour ago (a node the output also names).
    await admin`insert into nodes (id, owner_id, type, title, path, created_at) values
      (${ids.copy}, ${owner}, 'note', 'copy of a client request', 'notes', now()),
      (${ids.older}, ${owner}, 'page', 'older page', 'pages', now() - interval '1 hour')`;
    const out = JSON.stringify({ id: ids.copy, parent: ids.older, stranger: ids.otherBrainNew });
    expect(await cs.namesClientSourced(owner, [ids.copy])).toBe(false);
    expect(await cs.markCreatedClientSourced(owner, out, 1500, 'note_create')).toBe(1);
    expect(await cs.namesClientSourced(owner, [ids.copy])).toBe(true);
    expect(await cs.namesClientSourced(owner, [ids.older])).toBe(false);
    // Another brain's new node named in the output: never marked here.
    expect(await cs.namesClientSourced(other, [ids.otherBrainNew])).toBe(false);
    const [row] = await admin<{ via: string }[]>`
      select via from client_sourced_nodes where node_id = ${ids.copy}`;
    expect(row?.via).toBe('note_create');
    // Marking twice is harmless.
    expect(await cs.markCreatedClientSourced(owner, out, 1500, 'note_create')).toBe(0);
  });

  it('once a client wrote the app, its Table is client-sourced, whatever the level (C6, audit I3)', async () => {
    const { markAppClientWritten } = await import('@mantle/content/app-broker');
    await admin`insert into app_databases (owner_id, app_node_id, storage_path) values
      (${owner}, ${ids.clientApp}, '/nowhere/app.sqlite'),
      (${owner}, ${ids.teamApp}, '/nowhere/team.sqlite')`;
    // Before any client write: neither Table counts.
    expect(await cs.namesClientSourced(owner, [ids.clientAppTable])).toBe(false);
    expect(await cs.namesClientSourced(owner, [ids.teamAppTable])).toBe(false);
    await markAppClientWritten(owner, ids.clientApp);
    const [row] = await admin<{ at: string | null }[]>`
      select client_written_at::text as at from app_databases where app_node_id = ${ids.clientApp}`;
    expect(row?.at).toMatch(/^\d{4}-/);
    // Another brain cannot mark this app.
    await markAppClientWritten(other, ids.teamApp);
    expect(await cs.namesClientSourced(owner, [ids.teamAppTable])).toBe(false);

    try {
      expect(await cs.namesClientSourced(owner, [ids.clientAppTable])).toBe(true);
      // Only for this brain.
      expect(await cs.namesClientSourced(other, [ids.clientAppTable])).toBe(false);
      // Read on a limited role too (the check runs as the system).
      expect(
        await m.runInLevelRoleForTest('team', () =>
          cs.namesClientSourced(owner, [ids.clientAppTable]),
        ),
      ).toBe(true);
      expect([
        ...(await cs.clientSourcedAmong(owner, [ids.clientAppTable, ids.teamAppTable])),
      ]).toEqual([ids.clientAppTable]);
      // A second client write keeps the first stamp.
      await markAppClientWritten(owner, ids.clientApp);
      const [again] = await admin<{ at: string | null }[]>`
        select client_written_at::text as at from app_databases where app_node_id = ${ids.clientApp}`;
      expect(again?.at).toBe(row?.at);
      // Removing the export keeps the mark: the Table still holds the rows
      // clients wrote.
      const { removeAppTableExport } = await import('@mantle/content/app-table-exports');
      expect(await removeAppTableExport(owner, ids.clientApp, 'orders')).toBe(true);
      expect(await cs.namesClientSourced(owner, [ids.clientAppTable])).toBe(true);
      // A team app's Table no client wrote stays unmarked after its removal.
      expect(await removeAppTableExport(owner, ids.teamApp, 'orders')).toBe(true);
      expect(await cs.namesClientSourced(owner, [ids.teamAppTable])).toBe(false);
    } finally {
      await admin`insert into app_table_exports (owner_id, app_node_id, sqlite_table, table_node_id)
        values (${owner}, ${ids.clientApp}, 'orders', ${ids.clientAppTable}),
               (${owner}, ${ids.teamApp}, 'orders', ${ids.teamAppTable})
        on conflict do nothing`;
      await admin`delete from client_sourced_nodes where node_id = ${ids.clientAppTable}`;
    }
  });

  it('the corpus map leaves client-sourced items out, and only those (L4)', async () => {
    const rows = [
      ids.clientTask,
      ids.teamTask,
      ids.plainTask,
      ids.acceptedMemberItem,
      ids.copy,
      ids.older,
    ].map((id) => ({ id }));
    const kept = await m.runInLevelRoleForTest('team', () => cs.withoutClientSourced(owner, rows));
    expect(kept.map((r) => r.id).sort()).toEqual(
      [ids.teamTask, ids.plainTask, ids.acceptedMemberItem, ids.older].sort(),
    );
  });

  it('the conversation keeps the mark for 24 hours after its last read (I9)', async () => {
    const key = `agent:${ids.agent}`;
    const first = await cs.loadConversationTaint(owner, key);
    expect(first).toEqual({ clientSourced: false, conversation: { ownerId: owner, key } });
    // Turn 1 reads a client request: the conversation is marked.
    await cs.taintFromText(first, owner, `{"id":"${ids.clientTask}"}`, 'task_get');
    // Turn 2: starts marked, carried.
    const second = await cs.loadConversationTaint(owner, key);
    expect(second).toMatchObject({ clientSourced: true, carried: true });
    // Another conversation of the same owner is not.
    expect((await cs.loadConversationTaint(owner, `agent:${randomUUID()}`)).clientSourced).toBe(
      false,
    );
    // 25 hours on, the mark has lapsed.
    await admin`update conversation_taints set tainted_at = now() - interval '25 hours'
      where owner_id = ${owner} and conversation_key = ${key}`;
    expect((await cs.loadConversationTaint(owner, key)).clientSourced).toBe(false);
    // A carried turn's new read renews it from now.
    await admin`update conversation_taints set tainted_at = now() - interval '23 hours'
      where owner_id = ${owner} and conversation_key = ${key}`;
    const third = await cs.loadConversationTaint(owner, key);
    expect(third.carried).toBe(true);
    await cs.taintFromText(third, owner, `{"id":"${ids.clientTask}"}`, 'task_get');
    const [row] = await admin<{ fresh: boolean; via: string }[]>`
      select tainted_at > now() - interval '1 minute' as fresh, via from conversation_taints
       where owner_id = ${owner} and conversation_key = ${key}`;
    expect(row).toEqual({ fresh: true, via: 'task_get' });
  });

  it('taintFromText marks from text that names one, at any viewer level', async () => {
    const t = cs.newTurnTaint();
    await m.runInLevelRoleForTest('team', () =>
      cs.taintFromText(t, owner, `{"tasks":[{"id":"${ids.clientTask}"}]}`, 'task_list'),
    );
    expect(t).toEqual({ clientSourced: true, via: 'task_list' });
  });
});
