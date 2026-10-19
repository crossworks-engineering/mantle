/**
 * A Telegram turn runs as the user the chat is paired to (workspaces W7d), on
 * a migrated scratch database, through `handleTelegramMessage` and the real
 * turn (only the model and the Bot API are faked):
 *
 *  - a member's paired chat with the Team assistant's bot runs in the Team
 *    workspace as that member: their own thread (another member's turns
 *    never reach the prompt), both turns recorded under their login, and the
 *    reply goes back to the chat;
 *  - the anchor's chat with the Admin assistant's bot is unchanged: the
 *    anchor's turn scope of Admin and the anchor's thread;
 *  - a user removed from the workspace is refused on the next message, with
 *    one plain reply and no turn, and the chat goes back to pending; so is a
 *    chat with no login (W7d fix round 1, L4);
 *  - a photo on a second Admin user's chat is saved private to that user:
 *    another Admin user (the anchor) cannot read it (W7d fix round 1, M2).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/agent/telegram-w7d.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  sent: [] as Array<{ chatId: string; text: string }>,
  prompts: [] as string[],
  scopes: [] as unknown[],
}));

vi.mock('@mantle/telegram', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendMessage: vi.fn(async (_a: unknown, chatId: string, text: string) => {
    h.sent.push({ chatId, text });
    return [1];
  }),
  sendChatAction: vi.fn(async () => {}),
  // A photo's bytes (M2).
  downloadTelegramFile: vi.fn(async () => ({
    bytes: Buffer.from('w7d fix photo bytes'),
    mimeType: 'image/jpeg',
  })),
}));
// The inline look at the photo (a vision model) is not under test here.
vi.mock('@mantle/runtime/agent', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  extractAttachmentForTurn: vi.fn(async () => ({ kind: 'image', text: 'a cat', note: null })),
}));
// The model: records the prompt it is given and the scope its turn runs in.
vi.mock('@mantle/voice', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chat = async (req: { messages: unknown[] }) => {
    const db = await import('@mantle/db');
    h.scopes.push(db.currentScope());
    h.prompts.push(JSON.stringify(req.messages));
    return { text: 'hello from the assistant', model: 'fake/model' };
  };
  return {
    ...actual,
    getChatAdapter: vi.fn(() => ({ providerId: 'local', adapterName: 'fake-chat', chat })),
  };
});

describe.skipIf(!URL)('W7d: a Telegram turn runs as its paired user', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let handleTelegramMessage: (id: string) => Promise<void>;
  let dir = '';
  const owner = randomUUID();
  const member = randomUUID();
  const member2 = randomUUID();
  const admin2 = randomUUID(); // a second Admin user (M2)
  const tag = `w7dt${randomUUID().slice(0, 6)}`;
  const agent = { admin: randomUUID(), team: randomUUID() };
  const channel = { admin: randomUUID(), team: randomUUID() };
  const account = { admin: randomUUID(), team: randomUUID() };
  const chat = {
    member: randomUUID(),
    anchor: randomUUID(),
    unpaired: randomUUID(),
    admin2: randomUUID(),
  };
  let adminWs = '';
  let teamWs = '';
  let seq = 0;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  /** A fixture write to the four workspace tables, as the superuser: the
   *  app pools only read them under the runtime role. */
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  /** One inbound message on a chat, as the poller stores it. */
  const inbound = async (
    chatId: string,
    login: string | null,
    text: string,
    attachments: unknown[] = [],
  ): Promise<string> => {
    const [node] = await x<{
      id: string;
    }>(sql`insert into nodes (owner_id, type, title, path, login_id)
      values (${owner}, 'telegram_message', ${text}, 'inbox.telegram_test', ${login})
      returning id::text`);
    seq += 1;
    const [msg] = await x<{ id: string }>(sql`insert into telegram_messages
        (node_id, account_id, chat_id, telegram_message_id, telegram_update_id,
         from_user_id, from_name, text, sent_at, direction, attachments)
      select ${node!.id}, c.account_id, c.id, ${String(seq)}, ${seq}, '42', 'Sam', ${text},
             now(), 'inbound', ${JSON.stringify(attachments)}::jsonb
        from telegram_chats c where c.id = ${chatId}
      returning id::text`);
    return msg!.id;
  };
  const turnsOf = async (agentId: string) =>
    x<{ login: string; direction: string; text: string; channel: string }>(sql`
      select login_id::text as login, direction::text as direction, text, channel::text as channel
        from assistant_messages where agent_id = ${agentId} and channel = 'telegram'
       order by created_at`);

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w7d-turn-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.ALLOWED_USER_ID = owner;
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"offline in the W7d test"}', { status: 503 })),
    );
    m = await import('@mantle/db');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${member}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member'),
      (${member2}, ${`${tag}-n@example.invalid`}, 'x', false, 'member', 'Other'),
      (${admin2}, ${`${tag}-a@example.invalid`}, 'x', false, 'admin', 'Second')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    teamWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and name = 'Team' and not is_admin`)
    )[0]!.id;
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${teamWs}, ${member}, false), (${teamWs}, ${member2}, false),
      (${adminWs}, ${admin2}, false)
      on conflict (workspace_id, login_id) do nothing`);
    const memory = JSON.stringify({
      chunk_limit: 0,
      content_hit_limit: 0,
      corpus_map_limit: 0,
      fact_limit: 0,
      digest_limit: 0,
    });
    for (const [k, ws] of [
      ['admin', adminWs],
      ['team', teamWs],
    ] as const) {
      await x(sql`insert into agents (id, owner_id, slug, name, provider, model, system_prompt,
                                      role, workspace_id, memory_config, tool_group_slugs)
        values (${agent[k]}, ${owner}, ${`${tag}-${k}`}, ${k}, 'local', 'fake/model', 'p',
                'responder', ${ws}, ${memory}::jsonb, '{}')`);
      await x(sql`insert into channels (id, owner_id, agent_id, type, display_name, credentials_enc)
        values (${channel[k]}, ${owner}, ${agent[k]}, 'telegram', ${`@${tag}_${k}`}, '\\x00')`);
      await x(sql`insert into telegram_accounts (id, user_id, bot_username, branch_path, channel_id)
        values (${account[k]}, ${owner}, ${`${tag}_${k}`}, 'inbox.telegram_test', ${channel[k]})`);
    }
    await x(sql`insert into telegram_chats
        (id, account_id, user_id, telegram_chat_id, chat_type, allowlist_status, login_id)
      values
        (${chat.member}, ${account.team}, ${owner}, '9101', 'private', 'allowed', ${member}),
        (${chat.anchor}, ${account.admin}, ${owner}, '9102', 'private', 'allowed', ${owner}),
        (${chat.unpaired}, ${account.team}, ${owner}, '9103', 'private', 'allowed', null),
        (${chat.admin2}, ${account.admin}, ${owner}, '9104', 'private', 'allowed', ${admin2})`);
    // Earlier turns in the Team assistant's threads: the member's own, and
    // another member's that must never reach the member's prompt.
    await x(sql`insert into assistant_messages (owner_id, agent_id, login_id, direction, text, channel)
      values (${owner}, ${agent.team}, ${member}, 'inbound', ${`${tag} my earlier question`}, 'web'),
             (${owner}, ${agent.team}, ${member2}, 'inbound', ${`${tag} someone else secret`}, 'web')`);
    ({ handleTelegramMessage } = await import('./runtime'));
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    h.sent = [];
    h.prompts = [];
    h.scopes = [];
  });

  it('a member chats with the Team assistant as themselves: their own thread, their rows', async () => {
    await handleTelegramMessage(await inbound(chat.member, member, 'what did I ask before?'));
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain(`${tag} my earlier question`);
    expect(h.prompts[0]).not.toContain(`${tag} someone else secret`);
    expect(h.scopes[0]).toMatchObject({ kind: 'assistant', loginId: member, ws: [teamWs] });
    const rows = await turnsOf(agent.team);
    expect(rows.map((r) => [r.login, r.direction])).toEqual([
      [member, 'inbound'],
      [member, 'outbound'],
    ]);
    expect(h.sent).toEqual([{ chatId: '9101', text: 'hello from the assistant' }]);
  });

  it("the anchor's chat is unchanged: the anchor's turn scope of Admin and thread", async () => {
    await handleTelegramMessage(await inbound(chat.anchor, owner, 'hi there'));
    expect(h.scopes[0]).toMatchObject({ kind: 'assistant', loginId: owner, ws: [adminWs] });
    const rows = await turnsOf(agent.admin);
    expect(rows.every((r) => r.login === owner)).toBe(true);
    expect(rows).toHaveLength(2);
  });

  const chatState = async (id: string) =>
    (
      await x<{ s: string; login: string | null }>(sql`
        select allowlist_status::text as s, login_id::text as login
          from telegram_chats where id = ${id}`)
    )[0]!;

  it('a chat with no login is refused with one plain reply and no turn', async () => {
    await handleTelegramMessage(await inbound(chat.unpaired, null, 'hello?'));
    expect(h.prompts).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toMatch(/not paired to a user of this assistant/);
    // Back to pending, so the next message gets a code (L4).
    expect(await chatState(chat.unpaired)).toEqual({ s: 'pending', login: null });
  });

  it("a photo on another Admin user's chat is theirs: the anchor cannot read it (M2)", async () => {
    await handleTelegramMessage(
      await inbound(chat.admin2, admin2, '(photo)', [
        { kind: 'photo', file_id: 'pf-1', mime: 'image/jpeg' },
      ]),
    );
    expect(h.prompts).toHaveLength(1);
    const [file] = await x<{ id: string; login: string | null }>(sql`
      select id::text, login_id::text as login from nodes
       where owner_id = ${owner} and type = 'file'
       order by created_at desc limit 1`);
    expect(file?.login).toBe(admin2);
    const reads = async (login: string) =>
      m.withScope(await m.loginScopeFor(login), async () =>
        (
          (await m.db.execute(
            sql`select id::text from nodes where id = ${file!.id}`,
          )) as unknown as {
            id: string;
          }[]
        ).map((r) => r.id),
      );
    expect(await reads(admin2)).toEqual([file!.id]);
    expect(await reads(owner)).toEqual([]);
  });

  it('a user removed from the workspace is refused on the next message', async () => {
    const before = (await turnsOf(agent.team)).length;
    await su(
      sql`delete from workspace_users where workspace_id = ${teamWs} and login_id = ${member}`,
    );
    await handleTelegramMessage(await inbound(chat.member, member, 'still there?'));
    expect(h.prompts).toHaveLength(0);
    expect(h.sent.map((s) => s.text)).toEqual([expect.stringMatching(/not paired to a user/)]);
    expect((await turnsOf(agent.team)).length).toBe(before);
    // Back to pending with no login: the person pairs it again (L4).
    expect(await chatState(chat.member)).toEqual({ s: 'pending', login: null });
  });
});
