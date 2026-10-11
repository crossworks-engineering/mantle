/**
 * 0271 (workspaces W7d): telegram_chats.login_id, on a scratch database
 * migrated to just before it.
 *
 *  - every allowed chat is stamped with the anchor login (until W7d every
 *    paired chat acted as the brain owner);
 *  - an allowed chat whose login is then not a user of the workspace of an
 *    assistant it runs as (its bot's, or its responder override's) goes back
 *    to pending with no login; nobody is added to a workspace;
 *  - a pending or blocked chat is left as it is;
 *  - the messages of a chat stamped with the anchor are the anchor's
 *    (nodes.login_id, W7d fix round 1, L5), with no notify and updated_at
 *    kept; those of a chat sent back to pending are left with none;
 *  - re-runnable: a second run changes nothing.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/telegram-chat-login-0271.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabaseBefore } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const TAG = '0271_telegram_chat_login';

describe.skipIf(!URL)('0271: a Telegram chat belongs to a user', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: ReturnType<typeof postgres>;
  const owner = randomUUID();
  const agent = { admin: randomUUID(), team: randomUUID(), ops: randomUUID() };
  const channel = { admin: randomUUID(), team: randomUUID(), ops: randomUUID() };
  const account = { admin: randomUUID(), team: randomUUID(), ops: randomUUID() };
  const chat = {
    adminBot: randomUUID(),
    teamBot: randomUUID(),
    opsBot: randomUUID(),
    pinnedToOps: randomUUID(),
    pending: randomUUID(),
    blocked: randomUUID(),
  };
  const ws = { admin: '', team: '', ops: '' };
  let usersBefore = 0;
  const msgNode = { adminBot: '', opsBot: '' };
  const heard: string[] = [];
  let listener: Awaited<ReturnType<ReturnType<typeof postgres>['listen']>> | undefined;
  const nodeRow = async (id: string) =>
    (
      await sql<{ login: string | null; updated: string }[]>`
        select login_id::text as login, updated_at::text as updated from nodes where id = ${id}`
    )[0]!;
  let updatedBefore = '';

  const rows = async () =>
    Object.fromEntries(
      (
        await sql<{ id: string; s: string; login: string | null }[]>`
          select id::text, allowlist_status::text as s, login_id::text as login
            from telegram_chats where id in ${sql(Object.values(chat))}`
      ).map((r) => [r.id, { s: r.s, login: r.login }]),
    );

  const run = async () => {
    const file = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', `${TAG}.sql`),
      'utf8',
    );
    const statements = file
      .split('--> statement-breakpoint')
      .map((x) => x.trim())
      .filter(Boolean);
    await sql.begin(async (tx) => {
      for (const stmt of statements) await tx.unsafe(stmt);
    });
  };

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, TAG);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner, display_name)
      values (${owner}, ${`tg71-${owner.slice(0, 6)}@example.invalid`}, 'x', 'admin', true, 'O')`;
    await sql`select * from mantle_ws_migrate_locked()`;
    ws.admin = String(
      (await sql`select id::text as id from workspaces where owner_id = ${owner} and is_admin`)[0]!
        .id,
    );
    ws.team = String(
      (
        await sql`select id::text as id from workspaces
                  where owner_id = ${owner} and bridge_key = 'team'`
      )[0]!.id,
    );
    // The anchor is a user of Team; Ops is a workspace it is not in.
    await sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.team}, ${owner}, true) on conflict (workspace_id, login_id) do nothing`;
    ws.ops = String(
      (
        await sql`insert into workspaces (owner_id, name) values (${owner}, 'Ops')
                  returning id::text as id`
      )[0]!.id,
    );
    await sql`delete from workspace_users where workspace_id = ${ws.ops}`;
    for (const k of ['admin', 'team', 'ops'] as const) {
      await sql`insert into agents (id, owner_id, slug, name, model, system_prompt, role)
        values (${agent[k]}, ${owner}, ${`tg71-${k}`}, ${k}, 'test/model', 'x', 'responder')`;
      await sql`update agents set workspace_id = ${ws[k]} where id = ${agent[k]}`;
      await sql`insert into channels (id, owner_id, agent_id, type, display_name, credentials_enc)
        values (${channel[k]}, ${owner}, ${agent[k]}, 'telegram', ${`@tg71_${k}`}, '\\x00')`;
      await sql`insert into telegram_accounts (id, user_id, bot_username, branch_path, channel_id)
        values (${account[k]}, ${owner}, ${`tg71_${k}_bot`}, 'inbox.telegram_test', ${channel[k]})`;
    }
    await sql`insert into telegram_chats
        (id, account_id, user_id, telegram_chat_id, chat_type, allowlist_status, responder_agent_id)
      values
        (${chat.adminBot}, ${account.admin}, ${owner}, '7101', 'private', 'allowed', null),
        (${chat.teamBot}, ${account.team}, ${owner}, '7102', 'private', 'allowed', null),
        (${chat.opsBot}, ${account.ops}, ${owner}, '7103', 'private', 'allowed', null),
        (${chat.pinnedToOps}, ${account.admin}, ${owner}, '7104', 'private', 'allowed', ${agent.ops}),
        (${chat.pending}, ${account.admin}, ${owner}, '7105', 'private', 'pending', null),
        (${chat.blocked}, ${account.admin}, ${owner}, '7106', 'private', 'denied', null)`;
    usersBefore = Number(
      (await sql`select count(*)::int as n from workspace_users`)[0]!.n as number,
    );
    // One message on the anchor's chat, one on the chat that goes back to
    // pending, as the poller stored them before 0271 (no login).
    for (const k of ['adminBot', 'opsBot'] as const) {
      const [n] = await sql<{ id: string }[]>`
        insert into nodes (owner_id, type, title, path)
        values (${owner}, 'telegram_message', ${`tg71 ${k}`}, 'inbox.telegram_test')
        returning id::text`;
      msgNode[k] = n!.id;
      await sql`insert into telegram_messages (node_id, account_id, chat_id, telegram_message_id,
                                               text, sent_at, direction)
        select ${n!.id}, c.account_id, c.id, ${k}, ${k}, now(), 'inbound'
          from telegram_chats c where c.id = ${chat[k]}`;
    }
    updatedBefore = (await nodeRow(msgNode.adminBot)).updated;
    listener = await sql.listen('node_ingested', (id) => heard.push(id));
    await scratch.migrateRest();
  }, 240_000);

  afterAll(async () => {
    await listener?.unlisten();
    await sql?.end();
    await scratch?.drop();
  });

  it("stamps every allowed chat with the anchor; a chat outside its user's workspace goes back to pending", async () => {
    expect(await rows()).toEqual({
      [chat.adminBot]: { s: 'allowed', login: owner },
      [chat.teamBot]: { s: 'allowed', login: owner },
      // Ops has no user who is the anchor: back to pending, no login.
      [chat.opsBot]: { s: 'pending', login: null },
      // A responder override counts too.
      [chat.pinnedToOps]: { s: 'pending', login: null },
      [chat.pending]: { s: 'pending', login: null },
      [chat.blocked]: { s: 'denied', login: null },
    });
  });

  it("stamps the anchor's chat's messages with the anchor, quietly (L5)", async () => {
    const anchors = await nodeRow(msgNode.adminBot);
    expect(anchors.login).toBe(owner);
    // updated_at kept: the extractor's drain window is not reopened.
    expect(anchors.updated).toBe(updatedBefore);
    // The chat sent back to pending has no login: its message keeps none.
    expect((await nodeRow(msgNode.opsBot)).login).toBeNull();
    // No extractor notify for the stamped node.
    await new Promise((r) => setTimeout(r, 200));
    expect(heard).not.toContain(msgNode.adminBot);
  });

  it('adds nobody to a workspace', async () => {
    expect(Number((await sql`select count(*)::int as n from workspace_users`)[0]!.n)).toBe(
      usersBefore,
    );
    expect((await sql`select 1 from workspace_users where workspace_id = ${ws.ops}`).length).toBe(
      0,
    );
  });

  it('the login key nulls on a deleted login', async () => {
    const fk = await sql`select confdeltype from pg_constraint
                          where conname = 'telegram_chats_login_id_fk'`;
    expect(fk[0]?.confdeltype).toBe('n');
  });

  it('is re-runnable: a second run changes nothing', async () => {
    const before = await rows();
    const nodesBefore = [await nodeRow(msgNode.adminBot), await nodeRow(msgNode.opsBot)];
    await run();
    expect(await rows()).toEqual(before);
    expect([await nodeRow(msgNode.adminBot), await nodeRow(msgNode.opsBot)]).toEqual(nodesBefore);
  });
});
