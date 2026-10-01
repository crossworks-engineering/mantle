/**
 * Member chat threads are per login, on a real migrated Postgres: two member
 * logins' threads never see each other's rows, neither through the member's
 * own read (the query GET /api/member/chat runs) nor through the admin's
 * `team_chat_read` with a `loginId`. Another brain's row under the same login
 * id never shows either. Seeds its own logins and rows, removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/builtins-team-chat.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolHandlerContext } from './types';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('member chat thread isolation', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  let tm: typeof import('@mantle/content');
  let read: (typeof import('./builtins-team'))['TEAM_TOOLS'][number];
  const tag = `thread-${randomUUID().slice(0, 8)}`;
  const ownerId = randomUUID();
  const otherOwner = randomUUID();
  const ann = randomUUID();
  const ben = randomUUID();

  const texts = (rows: { text: string }[]) => rows.map((r) => r.text);
  /** GET /api/member/chat's read: the member's own thread, private in full. */
  const memberRead = (loginId: string) =>
    tm.listTeamThread(ownerId, '', { loginId, limit: 50, withPrivate: true });
  /** The admin's read: `team_chat_read` with a loginId. */
  const adminRead = async (loginId: string) => {
    const ctx: ToolHandlerContext = { ownerId, surface: { kind: 'web' } }; // the owner (C4: none is not)
    const res = await read.handler({ loginId }, ctx);
    if (!res.ok) throw new Error(res.error);
    return (res.output as { messages: { text: string }[] }).messages;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    tm = await import('@mantle/content');
    sqlTag = (await import('drizzle-orm')).sql;
    const { TEAM_TOOLS } = await import('./builtins-team');
    read = TEAM_TOOLS.find((t) => t.slug === 'team_chat_read')!;
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${ann}, ${`${tag}-ann@example.invalid`}, 'x', 'member'),
        (${ben}, ${`${tag}-ben@example.invalid`}, 'x', 'member')`);
    await m.systemDb.execute(sqlTag`
      insert into team_messages (owner_id, contact_id, login_id, direction, text, used_private, created_at) values
        (${ownerId}, null, ${ann}, 'inbound', 'ann asks', false, now() - interval '4 minutes'),
        (${ownerId}, null, ${ben}, 'inbound', 'ben asks', false, now() - interval '3 minutes'),
        (${ownerId}, null, ${ann}, 'outbound', 'ann private answer', true, now() - interval '2 minutes'),
        (${ownerId}, null, ${ben}, 'outbound', 'ben answer', false, now() - interval '1 minute'),
        (${otherOwner}, null, ${ann}, 'inbound', 'elsewhere', false, now())`);
  });

  afterAll(async () => {
    if (!m) return;
    await m.systemDb.execute(
      sqlTag`delete from team_messages where owner_id in (${ownerId}, ${otherOwner})`,
    );
    await m.systemDb.execute(sqlTag`delete from spaces where login_id in (${ann}, ${ben})`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id in (${ann}, ${ben})`);
    await m.closeDb();
  });

  it("the member's own read returns only that login's rows", async () => {
    expect(texts(await memberRead(ann))).toEqual(['ann asks', 'ann private answer']);
    expect(texts(await memberRead(ben))).toEqual(['ben asks', 'ben answer']);
  });

  it("the admin's team_chat_read by loginId returns only that login's rows", async () => {
    expect(texts(await adminRead(ann))).toEqual(['ann asks', tm.PRIVATE_REPLY_PLACEHOLDER]);
    expect(texts(await adminRead(ben))).toEqual(['ben asks', 'ben answer']);
  });

  it('a login with no thread reads empty, never a neighbour', async () => {
    const stranger = randomUUID();
    expect(await memberRead(stranger)).toEqual([]);
    expect(await adminRead(stranger)).toEqual([]);
  });
});
