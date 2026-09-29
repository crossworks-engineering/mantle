/**
 * namesClientSourced on Postgres (client logins C4, plan N18): a client
 * request task and a client login are client-sourced; a member's team
 * request, a member login, an ordinary task and another brain's client
 * request are not. Seeds its own rows on a random owner; removes them.
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
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from nodes where owner_id in ${admin([owner, other])}`;
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

  it('taintFromText marks from text that names one, at any viewer level', async () => {
    const t = cs.newTurnTaint();
    await m.withViewer('team', () =>
      cs.taintFromText(t, owner, `{"tasks":[{"id":"${ids.clientTask}"}]}`, 'task_list'),
    );
    expect(t).toEqual({ clientSourced: true, via: 'task_list' });
  });
});
