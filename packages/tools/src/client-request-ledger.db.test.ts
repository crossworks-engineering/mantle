/**
 * client_request_create's caps count a ledger (client logins C5 audit fix
 * I12): a client files its 10 requests of the day, an admin deletes every
 * one of them, and the 11th is still refused. The per-message cap (3) counts
 * the same ledger. The real handler on Postgres; the requests are filed on
 * the shared test anchor and removed by id after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/client-request-ledger.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('client request caps count the filing ledger', () => {
  type Db = typeof import('@mantle/db');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let admin: Admin;
  let ownerId = '';
  let tool: typeof import('./builtins-client').client_request_create;
  const loginId = randomUUID();
  const tag = `ledger-${loginId.slice(0, 8)}`;
  const ctx = (messageId: string) =>
    ({
      ownerId,
      surface: { kind: 'client', loginId, contactName: 'Casey', inboundMessageId: messageId },
    }) as never;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    ownerId = await ensureTestAnchor(admin);
    await admin`insert into auth.users (id, email, password_hash, role)
      values (${loginId}, ${`${tag}@example.invalid`}, 'x', 'client')`;
    tool = (await import('./builtins-client')).client_request_create;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from nodes where owner_id = ${ownerId}
      and data->'teamRequest'->>'loginId' = ${loginId}`;
    await admin`delete from spaces where login_id = ${loginId}`;
    // The ledger rows go with the login (ON DELETE CASCADE).
    await admin`delete from auth.users where id = ${loginId}`;
    await m.closeDb();
  });

  const file = (messageId: string, n: number) =>
    tool.handler({ title: `${tag} request ${n}`, body: 'Please.' }, ctx(messageId));

  it('3 a message: the 4th in the same message is refused, a new message files', async () => {
    const msg = randomUUID();
    for (let i = 0; i < 3; i++) expect((await file(msg, i)).ok).toBe(true);
    const fourth = await file(msg, 3);
    expect(fourth.ok).toBe(false);
    expect((fourth as { error: string }).error).toMatch(/3 requests per message/);
  });

  it('deleting the requests gives nothing back: the 11th of the day is refused', async () => {
    // 3 filed above; 7 more across new messages makes 10.
    for (let i = 0; i < 7; i++) expect((await file(randomUUID(), 10 + i)).ok).toBe(true);
    const [filed] = await admin<{ n: number }[]>`
      select count(*)::int as n from client_request_filings where login_id = ${loginId}`;
    expect(filed?.n).toBe(10);
    // An admin deletes every request the client filed.
    await admin`delete from nodes where owner_id = ${ownerId}
      and data->'teamRequest'->>'loginId' = ${loginId}`;
    const eleventh = await file(randomUUID(), 99);
    expect(eleventh.ok).toBe(false);
    expect((eleventh as { error: string }).error).toMatch(/10 requests in 24 hours/);
  });

  it('a day on, the client files again', async () => {
    await admin`update client_request_filings set created_at = now() - interval '25 hours'
      where login_id = ${loginId}`;
    expect((await file(randomUUID(), 100)).ok).toBe(true);
  });
});
