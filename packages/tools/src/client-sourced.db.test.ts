/**
 * namesClientSourced on Postgres (client logins C4, plan N18): a client
 * request task and a client login are client-sourced; a member's team
 * request, a member login, an ordinary task and another brain's client
 * request are not. An item a client wrote (client logins C5) is, in any state
 * and after the client login is deleted: an item accepted from a client's
 * space still taints a staff turn that read it. So is a node a marked turn
 * created (C5 audit fix L10); the corpus map leaves all of them out (L4);
 * a conversation keeps its mark for 24 hours (I9). A Table exported from an
 * app at client level is too (C6: clients write the app's rows), for as
 * long as the app stays at client level; one exported from a team app is
 * not. The gate itself runs end
 * to end in packages/runtime/src/agent/client-sourced-gate.db.test.ts.
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
    clientLogin: randomUUID(),
    memberLogin: randomUUID(),
    /** A client login whose item was accepted, then the login deleted. */
    goneClient: randomUUID(),
    acceptedClientItem: randomUUID(),
    acceptedMemberItem: randomUUID(),
    submittedClientItem: randomUUID(),
    /** A copy a marked turn made, an older node, another brain's new node. */
    copy: randomUUID(),
    older: randomUUID(),
    otherBrainNew: randomUUID(),
    agent: randomUUID(),
    /** Apps (C6) at client and team level, and a Table each exports. */
    clientApp: randomUUID(),
    teamApp: randomUUID(),
    clientAppTable: randomUUID(),
    teamAppTable: randomUUID(),
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    cs = await import('./client-sourced');
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`cs-o-${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin'),
      (${other}, ${`cs-x-${other.slice(0, 8)}@example.invalid`}, 'x', 'admin'),
      (${ids.clientLogin}, ${`cs-c-${owner.slice(0, 8)}@example.invalid`}, 'x', 'client'),
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
    // Items written in personal spaces (C5): the author_role trigger stamps
    // the role from the login when the space_items row is made.
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${ids.goneClient}, ${`cs-g-${owner.slice(0, 8)}@example.invalid`}, 'x', 'client')`;
    const [clientSpace] = await admin<{ id: string }[]>`
      select id from spaces where kind = 'personal' and login_id = ${ids.clientLogin}`;
    await admin`insert into nodes (id, owner_id, type, title, path, audience) values
      (${ids.acceptedClientItem}, ${owner}, 'page', 'accepted from a client', 'pages', 'team'),
      (${ids.acceptedMemberItem}, ${owner}, 'page', 'accepted from a member', 'pages', 'team'),
      (${ids.submittedClientItem}, ${clientSpace!.id}, 'page', 'submitted', 'pages', 'admin')`;
    await admin`insert into space_items (node_id, author_login_id, review_state) values
      (${ids.acceptedClientItem}, ${ids.goneClient}, 'accepted'),
      (${ids.acceptedMemberItem}, ${ids.memberLogin}, 'accepted'),
      (${ids.submittedClientItem}, ${ids.clientLogin}, 'submitted')`;
    // Two apps identical but for the level, each exporting a Table at admin.
    await admin`insert into nodes (id, owner_id, type, title, path, audience) values
      (${ids.clientApp}, ${owner}, 'app', 'orders (client)', 'apps', 'client'),
      (${ids.teamApp}, ${owner}, 'app', 'orders (team)', 'apps', 'team'),
      (${ids.clientAppTable}, ${owner}, 'table', 'orders export', 'tables', 'admin'),
      (${ids.teamAppTable}, ${owner}, 'table', 'orders export', 'tables', 'admin')`;
    await admin`insert into app_table_exports (owner_id, app_node_id, sqlite_table, table_node_id) values
      (${owner}, ${ids.clientApp}, 'orders', ${ids.clientAppTable}),
      (${owner}, ${ids.teamApp}, 'orders', ${ids.teamAppTable})`;
    // The client login goes: author_login_id goes NULL, the stamp stays.
    await admin`delete from spaces where login_id = ${ids.goneClient}`;
    await admin`delete from auth.users where id = ${ids.goneClient}`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from conversation_taints where owner_id in ${admin([owner, other])}`;
    await admin`delete from nodes where owner_id in ${admin([owner, other])}`;
    await admin`delete from nodes where id = ${ids.submittedClientItem}`;
    await admin`delete from spaces where login_id in ${admin([owner, other, ids.clientLogin, ids.memberLogin])}`;
    await admin`delete from auth.users where id in ${admin([owner, other, ids.clientLogin, ids.memberLogin])}`;
    await m.closeDb();
  });

  it('a client request task and a client login are client-sourced', async () => {
    expect(await cs.namesClientSourced(owner, [ids.clientTask])).toBe(true);
    expect(await cs.namesClientSourced(owner, [ids.clientLogin])).toBe(true);
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

  it('an item a client wrote, in any state, even after the login is deleted (C5)', async () => {
    const [row] = await admin<{ author_login_id: string | null; author_role: string | null }[]>`
      select author_login_id, author_role from space_items where node_id = ${ids.acceptedClientItem}`;
    // The fixture is what it says: no client login is named any more.
    expect(row).toEqual({ author_login_id: null, author_role: 'client' });
    expect(await cs.namesClientSourced(owner, [ids.acceptedClientItem])).toBe(true);
    expect(await cs.namesClientSourced(owner, [ids.submittedClientItem])).toBe(true);
    // A member's accepted item (control): not client-sourced.
    expect(await cs.namesClientSourced(owner, [ids.acceptedMemberItem])).toBe(false);
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

  it('a Table exported from an app at client level is client-sourced, from a team app not (C6)', async () => {
    expect(await cs.namesClientSourced(owner, [ids.clientAppTable])).toBe(true);
    expect(await cs.namesClientSourced(owner, [ids.teamAppTable])).toBe(false);
    // Only for this brain.
    expect(await cs.namesClientSourced(other, [ids.clientAppTable])).toBe(false);
    // Read on a limited role too (the check runs as the system).
    expect(
      await m.withViewer('team', () => cs.namesClientSourced(owner, [ids.clientAppTable])),
    ).toBe(true);
    expect([
      ...(await cs.clientSourcedAmong(owner, [ids.clientAppTable, ids.teamAppTable])),
    ]).toEqual([ids.clientAppTable]);
    // Raise the app above client before any client wrote it: its table
    // stops counting.
    await admin`update nodes set audience = 'team' where id = ${ids.clientApp}`;
    try {
      expect(await cs.namesClientSourced(owner, [ids.clientAppTable])).toBe(false);
    } finally {
      await admin`update nodes set audience = 'client' where id = ${ids.clientApp}`;
    }
  });

  it('once a client wrote the app, its Table stays client-sourced after a raise (audit I3)', async () => {
    const { markAppClientWritten } = await import('@mantle/content/app-broker');
    await admin`insert into app_databases (owner_id, app_node_id, storage_path) values
      (${owner}, ${ids.clientApp}, '/nowhere/app.sqlite'),
      (${owner}, ${ids.teamApp}, '/nowhere/team.sqlite')`;
    await markAppClientWritten(owner, ids.clientApp);
    const [row] = await admin<{ at: string | null }[]>`
      select client_written_at::text as at from app_databases where app_node_id = ${ids.clientApp}`;
    expect(row?.at).toMatch(/^\d{4}-/);
    // Another brain cannot mark this app.
    await markAppClientWritten(other, ids.teamApp);
    expect(await cs.namesClientSourced(owner, [ids.teamAppTable])).toBe(false);

    await admin`update nodes set audience = 'team' where id = ${ids.clientApp}`;
    try {
      expect(await cs.namesClientSourced(owner, [ids.clientAppTable])).toBe(true);
      expect([...(await cs.clientSourcedAmong(owner, [ids.clientAppTable]))]).toEqual([
        ids.clientAppTable,
      ]);
      // Even at admin level.
      await admin`update nodes set audience = 'admin' where id = ${ids.clientApp}`;
      expect(await cs.namesClientSourced(owner, [ids.clientAppTable])).toBe(true);
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
      await admin`update nodes set audience = 'client' where id = ${ids.clientApp}`;
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
      ids.acceptedClientItem,
      ids.acceptedMemberItem,
      ids.copy,
      ids.older,
    ].map((id) => ({ id }));
    const kept = await m.withViewer('team', () => cs.withoutClientSourced(owner, rows));
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
    await cs.taintFromText(third, owner, `{"id":"${ids.clientLogin}"}`, 'team_chat_read');
    const [row] = await admin<{ fresh: boolean; via: string }[]>`
      select tainted_at > now() - interval '1 minute' as fresh, via from conversation_taints
       where owner_id = ${owner} and conversation_key = ${key}`;
    expect(row).toEqual({ fresh: true, via: 'team_chat_read' });
  });

  it('taintFromText marks from text that names one, at any viewer level', async () => {
    const t = cs.newTurnTaint();
    await m.withViewer('team', () =>
      cs.taintFromText(t, owner, `{"tasks":[{"id":"${ids.clientTask}"}]}`, 'task_list'),
    );
    expect(t).toEqual({ clientSourced: true, via: 'task_list' });
  });
});
