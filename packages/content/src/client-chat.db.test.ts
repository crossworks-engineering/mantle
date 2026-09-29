/**
 * The client chat's DB helpers (client logins C4) on Postgres:
 *   - clientTurnMayRun: an active client at the queued epoch runs; a bumped
 *     epoch, a disabled login, a member or an unknown login does not.
 *   - clientChatUsageSince: a client login's queued turns and its client
 *     turn tokens today; a member's use is not a client's.
 *   - a client request (client_request_create's task): an admin's action
 *     marks it reviewed (it may be indexed from then on), and the Requests
 *     list flags it fromClient.
 * Seeds its own rows on a random owner; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/client-chat.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('client chat helpers', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let logins: typeof import('./client-logins');
  let ledger: typeof import('./member-turn-ledger');
  let requests: typeof import('./team-requests');
  const clientTask = randomUUID();
  const memberTask = randomUUID();
  const owner = randomUUID();
  const client = randomUUID();
  const disabled = randomUUID();
  const member = randomUUID();
  const all = [owner, client, disabled, member];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    logins = await import('./client-logins');
    ledger = await import('./member-turn-ledger');
    requests = await import('./team-requests');
    const e = (id: string) => `cc-${id.slice(0, 8)}@example.invalid`;
    await admin`insert into auth.users (id, email, password_hash, role, session_epoch, disabled_at) values
      (${owner}, ${e(owner)}, 'x', 'admin', 0, null),
      (${client}, ${e(client)}, 'x', 'client', 4, null),
      (${disabled}, ${e(disabled)}, 'x', 'client', 0, now()),
      (${member}, ${e(member)}, 'x', 'member', 0, null)`;
    await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
    const task = (source: string, login: string) =>
      JSON.stringify({ source, status: 'open', teamRequest: { loginId: login } });
    await admin`insert into nodes (id, owner_id, type, title, path, tags, data) values
      (${clientTask}, ${owner}, 'task', 'c', 'tasks', ${['team-request', 'client-request']}, ${task('client-request', client)}::jsonb),
      (${memberTask}, ${owner}, 'task', 'm', 'tasks', ${['team-request']}, ${task('team-request', member)}::jsonb)`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from nodes where id in ${admin([clientTask, memberTask])}`;
    await admin`delete from member_turn_ledger where owner_id = ${owner}`;
    await admin`delete from traces where owner_id = ${owner}`;
    await admin`delete from spaces where login_id in ${admin(all)}`;
    await admin`delete from auth.users where id in ${admin(all)}`;
    await m.closeDb();
  });

  it('clientTurnMayRun: the queued epoch of an active client only', async () => {
    expect(await logins.clientTurnMayRun(client, 4)).toBe(true);
    expect(await logins.clientTurnMayRun(client, 3)).toBe(false);
    expect(await logins.clientTurnMayRun(disabled, 0)).toBe(false);
    expect(await logins.clientTurnMayRun(member, 0)).toBe(false);
    expect(await logins.clientTurnMayRun(randomUUID(), 0)).toBe(false);
  });

  it("clientChatUsageSince: a client's turns and tokens today, not a member's", async () => {
    const since = new Date(Date.now() - 60_000);
    for (const [login, n] of [
      [client, 3],
      [member, 5],
    ] as const) {
      for (let i = 0; i < n; i++) {
        await admin`insert into member_turn_ledger (turn_id, owner_id, login_id)
          values (${`t-${login}-${i}`}, ${owner}, ${login})`;
      }
    }
    for (const [login, role, tokens] of [
      [client, 'client', 700],
      [member, 'member', 900],
    ] as const) {
      await admin`insert into traces (owner_id, kind, subject_kind, tokens_in, tokens_out, data)
        values (${owner}, 'responder_turn', 'team_turn', ${tokens}, 0,
                ${JSON.stringify({ login_id: login, login_role: role })}::jsonb)`;
    }
    const usage = await ledger.clientChatUsageSince(owner, since);
    expect(usage.get(client)).toEqual({ turns: 3, tokens: 700 });
    expect(usage.has(member)).toBe(false);
  });

  it('the Requests list flags a client request; a member request is not flagged', async () => {
    const rows = await requests.listTeamRequests(owner, { status: 'all' });
    const by = new Map(rows.map((r) => [r.taskId, r]));
    expect(by.get(clientTask)).toMatchObject({ loginId: client, fromClient: true });
    expect(by.get(memberTask)?.fromClient).toBeUndefined();
  });

  it("an admin's action marks a client request reviewed, once", async () => {
    expect(await requests.markTeamRequestReviewed(owner, clientTask)).toBe(true);
    expect(await requests.markTeamRequestReviewed(owner, clientTask)).toBe(false);
    const [row] = await admin<{ reviewed: string | null }[]>`
      select data->>'reviewed_at' as reviewed from nodes where id = ${clientTask}`;
    expect(row!.reviewed).toBeTruthy();
  });
});
