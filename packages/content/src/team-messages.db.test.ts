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
  }, 60_000);

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
  it('admin readers get a private reply redacted; the member reads it in full (S3)', async () => {
    const tm = await import('./team-messages');
    await m.systemDb.execute(sqlTag`
      insert into team_messages (owner_id, contact_id, login_id, direction, text, used_private, created_at)
      values (${ownerId}, null, ${chatty}, 'outbound', 'your draft says: secret plan', true, now())`);
    const admin = await tm.listTeamThread(ownerId, '', { loginId: chatty });
    expect(admin.map((r) => r.text)).toEqual(['first', 'the reply', tm.PRIVATE_REPLY_PLACEHOLDER]);
    const own = await tm.listTeamThread(ownerId, '', { loginId: chatty, withPrivate: true });
    expect(own.at(-1)?.text).toBe('your draft says: secret plan');
    // The turn's history is the member's own read.
    const history = await tm.recentTeamMessages(ownerId, '', 20, chatty);
    expect(history.at(-1)?.text).toBe('your draft says: secret plan');
    // The admin index previews the last message: redacted too.
    const [c] = (await tm.listMemberChatActivity(ownerId)).filter((r) => r.loginId === chatty);
    expect(c?.lastMessageText).toBe(tm.PRIVATE_REPLY_PLACEHOLDER);
    expect(JSON.stringify(await tm.listMemberChatActivity(ownerId))).not.toContain('secret plan');
  });

  it('names each row by role: a client with a thread is a client, never a team member (audit B26)', async () => {
    const client = randomUUID();
    const quietClient = randomUUID();
    const formerMember = randomUUID();
    const ids = [client, quietClient, formerMember];
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${client}, ${`client-${tag}@example.invalid`}, 'x', 'client', null),
        (${quietClient}, ${`qclient-${tag}@example.invalid`}, 'x', 'client', null),
        (${formerMember}, ${`former-${tag}@example.invalid`}, 'x', 'admin', 'Former')`);
    try {
      await m.systemDb.execute(sqlTag`
        insert into team_messages (owner_id, contact_id, login_id, direction, text, created_at) values
          (${ownerId}, null, ${client}, 'inbound', 'hello from a client', now()),
          (${ownerId}, null, ${formerMember}, 'inbound', 'old thread', now() - interval '1 hour')`);
      const { listMemberChatActivity } = await import('./team-messages');
      const all = await listMemberChatActivity(ownerId);
      const byId = new Map(all.map((r) => [r.loginId, r]));
      // Members: role member. A client with a thread: role client, inactive.
      expect(byId.get(chatty)).toMatchObject({ role: 'member', active: true });
      expect(byId.get(quiet)).toMatchObject({ role: 'member' });
      expect(byId.get(client)).toMatchObject({
        role: 'client',
        active: false,
        name: `client-${tag}`,
        messageCount: 1,
      });
      // A client without a thread is not on the roster at all.
      expect(byId.has(quietClient)).toBe(false);
      // A former member (an admin now) keeps its old thread, with no role.
      const former = byId.get(formerMember)!;
      expect(former).toMatchObject({ name: 'Former', active: false, messageCount: 1 });
      expect(former.role).toBeUndefined();
      // No row claims a role outside the two it may name.
      for (const r of all) expect([undefined, 'member', 'client']).toContain(r.role);
    } finally {
      for (const id of ids) {
        await m.systemDb.execute(sqlTag`delete from team_messages where login_id = ${id}`);
        await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${id}`);
        await m.systemDb.execute(sqlTag`delete from auth.users where id = ${id}`);
      }
    }
  });
});
