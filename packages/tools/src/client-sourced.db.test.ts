/**
 * namesClientSourced on Postgres (client logins C4, plan N18): a client
 * request task and a client login are client-sourced; a member's team
 * request, a member login, an ordinary task and another brain's client
 * request are not. An item a client wrote (client logins C5) is, in any state
 * and after the client login is deleted: an item accepted from a client's
 * space still taints a staff turn that read it. Seeds its own rows on a
 * random owner; removes them.
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
      (${ids.otherBrainClientTask}, ${other}, 'task', 'o', 'tasks', ${data('client-request')}::jsonb)`;
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
    // The client login goes: author_login_id goes NULL, the stamp stays.
    await admin`delete from spaces where login_id = ${ids.goneClient}`;
    await admin`delete from auth.users where id = ${ids.goneClient}`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
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

  it('a staff turn that read an accepted client item sends a lowering to pending (C5)', async () => {
    // What execute-call.ts checks: the turn's taint, then isLoweringCall.
    const gated = (t: { clientSourced: boolean }, input: Record<string, unknown>) =>
      t.clientSourced === true && cs.isLoweringCall('access_set', input);
    const read = cs.newTurnTaint();
    await m.withViewer('team', () =>
      cs.taintFromText(read, owner, `{"id":"${ids.acceptedClientItem}","title":"x"}`, 'page_get'),
    );
    expect(read).toEqual({ clientSourced: true, via: 'page_get' });
    const target = { id: randomUUID() };
    expect(gated(read, { ...target, level: 'client' })).toBe(true);
    expect(gated(read, { ...target, level: 'public' })).toBe(true);
    expect(gated(read, { ...target, level: 'team' })).toBe(false);
    // A turn that read only the member's accepted item runs it.
    const control = cs.newTurnTaint();
    await cs.taintFromText(control, owner, `{"id":"${ids.acceptedMemberItem}"}`, 'page_get');
    expect(gated(control, { ...target, level: 'public' })).toBe(false);
  });

  it('taintFromText marks from text that names one, at any viewer level', async () => {
    const t = cs.newTurnTaint();
    await m.withViewer('team', () =>
      cs.taintFromText(t, owner, `{"tasks":[{"id":"${ids.clientTask}"}]}`, 'task_list'),
    );
    expect(t).toEqual({ clientSourced: true, via: 'task_list' });
  });
});
