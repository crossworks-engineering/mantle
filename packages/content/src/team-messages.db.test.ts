/**
 * The owner's member-chat index on a real, migrated Postgres (users are the
 * team, 2026-09-26): every member login shows, with its own thread's size and
 * last message; an admin login with no thread does not; another owner's rows
 * never count. Seeds its own logins and rows, removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/team-messages.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('listMemberChatActivity', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = randomUUID().slice(0, 8);
  const ownerId = randomUUID();
  const otherOwner = randomUUID();
  const chatty = randomUUID();
  const quiet = randomUUID();
  const admin = randomUUID();
  const logins: string[] = [chatty, quiet, admin];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${chatty}, ${`chatty-${tag}@example.invalid`}, 'x', 'member', 'Chatty'),
        (${quiet}, ${`quiet-${tag}@example.invalid`}, 'x', 'member', null),
        (${admin}, ${`admin-${tag}@example.invalid`}, 'x', 'admin', null)`);
    await m.systemDb.execute(sqlTag`
      insert into team_messages (owner_id, contact_id, login_id, direction, text, created_at) values
        (${ownerId}, null, ${chatty}, 'inbound', 'first', now() - interval '2 minutes'),
        (${ownerId}, null, ${chatty}, 'outbound', 'the reply', now() - interval '1 minute'),
        (${otherOwner}, null, ${quiet}, 'inbound', 'elsewhere', now())`);
  });

  afterAll(async () => {
    await m.systemDb.execute(
      sqlTag`delete from team_messages where owner_id in (${ownerId}, ${otherOwner})`,
    );
    await m.systemDb.execute(
      sqlTag`delete from spaces where login_id in (${chatty}, ${quiet}, ${admin})`,
    );
    await m.systemDb.execute(
      sqlTag`delete from auth.users where id in (${chatty}, ${quiet}, ${admin})`,
    );
    await m.closeDb();
  });

  it('lists member logins with their own thread, newest activity first', async () => {
    const { listMemberChatActivity } = await import('./team-messages');
    const rows = (await listMemberChatActivity(ownerId)).filter((r) => logins.includes(r.loginId));
    expect(rows.map((r) => r.loginId)).toEqual([chatty, quiet]);
    const [c, q] = rows;
    expect(c).toMatchObject({
      name: 'Chatty',
      active: true,
      messageCount: 2,
      lastMessageText: 'the reply',
      lastMessageDirection: 'outbound',
    });
    // The other owner's row never counts; the name falls back to the email.
    expect(q).toMatchObject({ name: `quiet-${tag}`, messageCount: 0, lastMessageAt: null });
  });
});
