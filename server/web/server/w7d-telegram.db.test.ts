/**
 * Workspaces W7d, Telegram per paired user, on a migrated scratch database:
 * the anchor, a second Admin user (A2), Team members (M a user, D a
 * Moderator), a login outside Team (X) and a client (K); the Admin
 * assistant's bot and the Team assistant's bot.
 *
 *  - Pairing: only the user pairs their own chat, with its code, for a bot
 *    whose assistant's workspace they are a user of (the web route and the
 *    telegram_pair tool); a client never pairs; the owner's Settings route
 *    no longer pairs (403).
 *  - Block and unpair: the chat's own user, a Moderator of its bot's
 *    workspace, or an Admin user with the users area; anyone else reads
 *    404 and changes nothing.
 *  - Approvals: a card goes only to a chat of the call's own login (the
 *    anchor's for a call with none), only while that login holds the
 *    settings area; a tap decides as the chat's login, by /api/pending's
 *    rule.
 *  - Replay and the operator tools read only the asking login's chats.
 *
 * Only the Telegram Bot API and the outside hosts are faked.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w7d-telegram.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  login: null as unknown,
  session: null as unknown,
  sent: [] as Array<{ chatId: string; text: string }>,
  cards: [] as Array<{ chatId: string; pendingId: string }>,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChatLoginOr401: vi.fn(async () => h.login),
  getOwnerOr401: vi.fn(async () => h.session),
}));
vi.mock('@mantle/telegram', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendMessage: vi.fn(async (_a: unknown, chatId: string, text: string) => {
    h.sent.push({ chatId, text });
    return [1];
  }),
  sendApprovalCard: vi.fn(async (_a: unknown, chatId: string, card: { pendingId: string }) => {
    h.cards.push({ chatId, pendingId: card.pendingId });
  }),
}));

describe.skipIf(!URL)('W7d: Telegram per paired user', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let dir = '';
  const owner = randomUUID(); // the anchor
  const admin2 = randomUUID(); // A2: a user of Admin
  const member = randomUUID(); // M: a user of Team
  const mod = randomUUID(); // D: a Moderator of Team
  const outsider = randomUUID(); // X: in no workspace of these bots
  const client = randomUUID(); // K
  const tag = `w7d${randomUUID().slice(0, 6)}`;
  let adminWs = '';
  let teamWs = '';
  const agent = { admin: randomUUID(), team: randomUUID() };
  const channel = { admin: randomUUID(), team: randomUUID() };
  const account = { admin: randomUUID(), team: randomUUID() };
  const chat = {
    member: randomUUID(),
    outsider: randomUUID(),
    memberOnAdminBot: randomUUID(),
    admin2: randomUUID(),
    anchor: randomUUID(),
    client: randomUUID(),
  };
  const code = {
    member: 'aa0001',
    outsider: 'aa0002',
    memberOnAdminBot: 'aa0003',
    admin2: 'aa0004',
    client: 'aa0006',
  };

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const role = (login: string) =>
    login === owner || login === admin2 ? 'admin' : login === client ? 'client' : 'member';
  const as = (login: string) => {
    const user = {
      id: owner,
      email: `${login}@example.invalid`,
      actor: { id: login, email: `${login}@example.invalid`, displayName: null, isOwner: false },
    };
    h.login = {
      kind: role(login),
      ownerId: owner,
      loginId: login,
      source: 'web',
      user,
      displayName: null,
      email: user.email,
    };
    h.session = user;
  };
  const json = (body: unknown) =>
    new Request('http://x/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const chatRow = async (id: string) =>
    (
      await x<{ s: string; login: string | null; code: string | null }>(sql`
        select allowlist_status::text as s, login_id::text as login, pairing_code as code
          from telegram_chats where id = ${id}`)
    )[0]!;
  const pairRoute = async (login: string, c: string) => {
    as(login);
    const route = await import('@/app/api/telegram/pair/route');
    return route.POST(json({ code: c }));
  };
  const moderate = async (login: string, id: string, action: 'block' | 'unpair') => {
    as(login);
    const route =
      action === 'block'
        ? await import('@/app/api/telegram/chats/[id]/block/route')
        : await import('@/app/api/telegram/chats/[id]/unpair/route');
    return route.POST(new Request('http://x/api', { method: 'POST' }), params(id));
  };
  const resetChat = async (id: string, c: string | null) =>
    x(sql`update telegram_chats
             set allowlist_status = 'pending', login_id = null, pairing_code = ${c},
                 pairing_expires_at = now() + interval '1 hour', pairing_replies = 0
           where id = ${id}`);
  const allow = async (id: string, login: string) =>
    x(sql`update telegram_chats
             set allowlist_status = 'allowed', login_id = ${login}, pairing_code = null
           where id = ${id}`);

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w7d-telegram-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    delete process.env.MANTLE_ADMIN_READS;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"offline in the W7d test"}', { status: 503 })),
    );
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${admin2}, ${`${tag}-a2@example.invalid`}, 'x', false, 'admin', 'Second'),
      (${member}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member'),
      (${mod}, ${`${tag}-d@example.invalid`}, 'x', false, 'member', 'Mod'),
      (${outsider}, ${`${tag}-x@example.invalid`}, 'x', false, 'member', 'Outsider'),
      (${client}, ${`${tag}-k@example.invalid`}, 'x', false, 'client', 'Client')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    teamWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and bridge_key = 'team'`)
    )[0]!.id;
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${adminWs}, ${admin2}, false)
      on conflict (workspace_id, login_id) do update set moderator = false`);
    await x(sql`delete from workspace_users
                 where workspace_id = ${teamWs} and login_id in (${member}, ${mod}, ${outsider})`);
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${teamWs}, ${member}, false), (${teamWs}, ${mod}, true)`);
    for (const [k, ws] of [
      ['admin', adminWs],
      ['team', teamWs],
    ] as const) {
      await x(sql`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
        values (${agent[k]}, ${owner}, ${`${tag}-${k}`}, ${k}, 'fake/model', 'p', 'responder', ${ws})`);
      await x(sql`insert into channels (id, owner_id, agent_id, type, display_name, credentials_enc)
        values (${channel[k]}, ${owner}, ${agent[k]}, 'telegram', ${`@${tag}_${k}`}, '\\x00')`);
      await x(sql`insert into telegram_accounts (id, user_id, bot_username, branch_path, channel_id)
        values (${account[k]}, ${owner}, ${`${tag}_${k}_bot`}, 'inbox.telegram_test', ${channel[k]})`);
    }
    await x(sql`insert into telegram_chats
        (id, account_id, user_id, telegram_chat_id, chat_type, title, allowlist_status)
      values
        (${chat.member}, ${account.team}, ${owner}, '8001', 'private', 'Mia', 'pending'),
        (${chat.outsider}, ${account.team}, ${owner}, '8002', 'private', 'Xan', 'pending'),
        (${chat.memberOnAdminBot}, ${account.admin}, ${owner}, '8003', 'private', 'Mia', 'pending'),
        (${chat.admin2}, ${account.admin}, ${owner}, '8004', 'private', 'Abe', 'pending'),
        (${chat.anchor}, ${account.admin}, ${owner}, '8005', 'private', 'Own', 'allowed'),
        (${chat.client}, ${account.team}, ${owner}, '8006', 'private', 'Kay', 'pending')`);
    await allow(chat.anchor, owner);
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    h.sent = [];
    h.cards = [];
    const { resetPairingAttempts } = await import('@mantle/telegram');
    resetPairingAttempts();
    for (const k of ['member', 'outsider', 'memberOnAdminBot', 'admin2', 'client'] as const) {
      await resetChat(chat[k], code[k]);
    }
  });

  // ── Pairing ──────────────────────────────────────────────────────────────

  it("a member pairs their own chat with its code, and it is theirs (not the anchor's)", async () => {
    const res = await pairRoute(member, code.member);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      already: false,
      chat: { id: chat.member, telegramChatId: '8001', agentName: 'team' },
    });
    expect(await chatRow(chat.member)).toEqual({ s: 'allowed', login: member, code: null });
    expect(h.sent).toEqual([{ chatId: '8001', text: 'Paired! Say hi to team.' }]);
    // Their own list has it; nobody else's does.
    as(member);
    const mine = await import('@/app/api/telegram/my-chats/route');
    const list = (await (await mine.GET()).json()) as { chats: { id: string }[] };
    expect(list.chats.map((c) => c.id)).toEqual([chat.member]);
    as(admin2);
    const theirs = (await (await mine.GET()).json()) as { chats: { id: string }[] };
    expect(theirs.chats).toEqual([]);
    // The same code again pairs nothing.
    const again = await pairRoute(mod, code.member);
    expect(again.status).toBe(404);
    expect((await chatRow(chat.member)).login).toBe(member);
  });

  it("a login that is not a user of the bot's workspace cannot pair to it", async () => {
    const res = await pairRoute(outsider, code.outsider);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_a_workspace_user' });
    expect(await chatRow(chat.outsider)).toEqual({
      s: 'pending',
      login: null,
      code: code.outsider,
    });
    // A member is not a user of Admin: the Admin assistant's bot is not theirs.
    const admin = await pairRoute(member, code.memberOnAdminBot);
    expect(admin.status).toBe(403);
    expect((await chatRow(chat.memberOnAdminBot)).s).toBe('pending');
  });

  it('a client cannot pair', async () => {
    const res = await pairRoute(client, code.client);
    expect(res.status).toBe(403);
    expect((await chatRow(chat.client)).s).toBe('pending');
  });

  it('telegram_pair pairs to the calling login, never the anchor', async () => {
    const tool = t.BUILTIN_TOOLS.find((d) => d.slug === 'telegram_pair')!;
    const res = await tool.handler(
      { code: code.admin2 },
      { ownerId: owner, surface: { kind: 'owner', via: 'mcp', loginId: admin2 } },
    );
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(await chatRow(chat.admin2)).toEqual({ s: 'allowed', login: admin2, code: null });
    // A member's own MCP pairs only to a bot of a workspace it is in.
    const refused = await tool.handler(
      { code: code.memberOnAdminBot },
      { ownerId: owner, surface: { kind: 'owner', via: 'mcp', loginId: member } },
    );
    expect(refused.ok).toBe(false);
    expect((await chatRow(chat.memberOnAdminBot)).s).toBe('pending');
  });

  it("the owner's Settings route no longer pairs: 403, the chat stays pending", async () => {
    as(owner);
    const route = await import('@/app/api/agents/[id]/telegram/chats/route');
    const res = await route.POST(
      json({ chatId: chat.outsider, status: 'allowed' }),
      params(agent.team),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'pair_with_code' });
    expect((await chatRow(chat.outsider)).s).toBe('pending');
  });

  // ── Block and unpair ────────────────────────────────────────────────────

  it("a non-moderator cannot unpair or block someone else's chat", async () => {
    await allow(chat.member, member);
    // The outsider is in no workspace of the bot. (An Admin user with the
    // users area may, below.)
    expect((await moderate(outsider, chat.member, 'unpair')).status).toBe(404);
    expect((await moderate(outsider, chat.member, 'block')).status).toBe(404);
    // A member of Team who does not moderate it, on the anchor's chat.
    expect((await moderate(member, chat.anchor, 'unpair')).status).toBe(404);
    expect(await chatRow(chat.member)).toEqual({ s: 'allowed', login: member, code: null });
    expect((await chatRow(chat.anchor)).login).toBe(owner);
  });

  it("a Moderator of the bot's workspace unpairs or blocks it, never pairs it", async () => {
    await allow(chat.member, member);
    const res = await moderate(mod, chat.member, 'unpair');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await chatRow(chat.member)).toEqual({ s: 'pending', login: null, code: null });
    await allow(chat.member, member);
    expect((await moderate(mod, chat.member, 'block')).status).toBe(200);
    expect(await chatRow(chat.member)).toEqual({ s: 'denied', login: null, code: null });
    // A Moderator of Team is not one of the Admin bot.
    expect((await moderate(mod, chat.anchor, 'block')).status).toBe(404);
    expect((await chatRow(chat.anchor)).s).toBe('allowed');
  });

  it('an Admin user with the users area blocks a chat of any bot; the user unpairs their own', async () => {
    await allow(chat.member, member);
    expect((await moderate(admin2, chat.member, 'block')).status).toBe(200);
    expect((await chatRow(chat.member)).s).toBe('denied');
    await allow(chat.member, member);
    as(member);
    const mine = await import('@/app/api/telegram/my-chats/[id]/route');
    expect(
      (await mine.DELETE(new Request('http://x/', { method: 'DELETE' }), params(chat.member)))
        .status,
    ).toBe(200);
    expect(await chatRow(chat.member)).toEqual({ s: 'pending', login: null, code: null });
  });

  it('the moderated list holds only the bots the login moderates', async () => {
    const list = async (login: string) => {
      as(login);
      const route = await import('@/app/api/telegram/moderated-chats/route');
      const body = (await (await route.GET()).json()) as { chats: { id: string }[] };
      return new Set(body.chats.map((c) => c.id));
    };
    const mods = await list(mod);
    expect(mods.has(chat.member)).toBe(true);
    expect(mods.has(chat.anchor)).toBe(false);
    expect((await list(member)).size).toBe(0);
    const anchors = await list(owner);
    expect(anchors.has(chat.member) && anchors.has(chat.anchor)).toBe(true);
  });

  // ── Approvals and their cards ───────────────────────────────────────────

  it("a card goes only to a chat of the call's own login, while it holds the settings area", async () => {
    await allow(chat.admin2, admin2);
    await allow(chat.member, member);
    const pending = async (login: string | null) =>
      (
        await x<{
          id: string;
        }>(sql`insert into pending_tool_calls (owner_id, tool_slug, args, login_id)
          values (${owner}, 'note_create', '{}'::jsonb, ${login}) returning id::text`)
      )[0]!.id;
    const forAdmin2 = await pending(admin2);
    const forAnchor = await pending(null);
    const forMember = await pending(member);
    expect(await t.resolveApprovalChat(owner, admin2)).toMatchObject({ telegramChatId: '8004' });
    expect(await t.resolveApprovalChat(owner, owner)).toMatchObject({ telegramChatId: '8005' });
    // A member has a paired chat but decides no approvals: no card.
    expect(await t.resolveApprovalChat(owner, member)).toBeNull();
    for (const id of [forAdmin2, forAnchor, forMember]) {
      await t.notifyPendingCreated({
        ownerId: owner,
        pendingId: id,
        toolSlug: 'note_create',
        args: {},
      });
    }
    expect(h.cards).toEqual([
      { chatId: '8004', pendingId: forAdmin2 },
      { chatId: '8005', pendingId: forAnchor },
    ]);

    // A tap decides as the chat's login, by /api/pending's rule.
    const { telegramApprovalHandlers } = await import('@/lib/telegram-approval');
    const tap = (loginId: string, pendingId: string) =>
      telegramApprovalHandlers.onApproval!({
        ownerId: owner,
        loginId,
        decision: 'reject',
        pendingId,
      });
    expect((await tap(member, forMember)).ok).toBe(false);
    expect((await tap(admin2, forAnchor)).ok).toBe(false);
    expect((await tap(admin2, forAdmin2)).ok).toBe(true);
    expect((await tap(owner, forAnchor)).ok).toBe(true);
    const status = async (id: string) =>
      (
        await x<{ s: string }>(
          sql`select status::text as s from pending_tool_calls where id = ${id}`,
        )
      )[0]!.s;
    expect(await status(forMember)).toBe('pending');
    expect(await status(forAdmin2)).toBe('rejected');
    expect(await status(forAnchor)).toBe('rejected');
  });

  // ── Replay, the operator tools, outbound lookups ─────────────────────────

  it("replay and the operator tools read only the asking login's own chats", async () => {
    await allow(chat.member, member);
    const message = async (chatId: string, text: string, login: string | null) => {
      const [node] = await x<{
        id: string;
      }>(sql`insert into nodes (owner_id, type, title, path, login_id)
        values (${owner}, 'telegram_message', ${text}, 'inbox.telegram_test', ${login})
        returning id::text`);
      await x(sql`insert into telegram_messages (node_id, account_id, chat_id, telegram_message_id,
                                                text, sent_at, direction, processed)
        select ${node!.id}, c.account_id, c.id, ${randomUUID().slice(0, 8)}, ${text}, now(),
               'inbound', false
          from telegram_chats c where c.id = ${chatId}`);
    };
    await message(chat.member, `${tag} member secret`, member);
    await message(chat.anchor, `${tag} anchor note`, owner);
    await message(chat.anchor, `${tag} legacy anchor note`, null);

    const replay = t.REPLAY_TOOLS.find((d) => d.slug === 'replay_window')!;
    const texts = async (login: string) => {
      const res = await replay.handler(
        { from: '2000-01-01', to: '2100-01-01', surface: 'telegram' },
        { ownerId: owner, surface: { kind: 'web', loginId: login } },
      );
      if (!res.ok) throw new Error(res.error);
      return JSON.stringify(res.output);
    };
    const theirs = await texts(member);
    expect(theirs).toContain(`${tag} member secret`);
    expect(theirs).not.toContain(`${tag} anchor note`);
    const anchors = await texts(owner);
    expect(anchors).toContain(`${tag} anchor note`);
    expect(anchors).toContain(`${tag} legacy anchor note`);
    expect(anchors).not.toContain(`${tag} member secret`);

    const pendingTool = t.BUILTIN_TOOLS.find((d) => d.slug === 'telegram_pending')!;
    const inbox = async (ctx: import('@mantle/tools').ToolHandlerContext) => {
      const res = await pendingTool.handler({ limit: 50 }, ctx);
      if (!res.ok) throw new Error(res.error);
      return JSON.stringify(res.output);
    };
    const memberInbox = await inbox({
      ownerId: owner,
      surface: { kind: 'owner', via: 'mcp', loginId: member },
    });
    expect(memberInbox).toContain(`${tag} member secret`);
    expect(memberInbox).not.toContain(`${tag} anchor note`);
    const anchorInbox = await inbox({ ownerId: owner, surface: { kind: 'owner', via: 'mcp' } });
    expect(anchorInbox).toContain(`${tag} anchor note`);
    expect(anchorInbox).not.toContain(`${tag} member secret`);

    const { pairedChatOf } = await import('@mantle/telegram');
    expect(
      await pairedChatOf({ ownerId: owner, loginId: member, telegramChatId: '8001' }),
    ).toMatchObject({ id: chat.member });
    expect(
      await pairedChatOf({ ownerId: owner, loginId: owner, telegramChatId: '8001' }),
    ).toBeNull();
  });

  it('a user removed from the workspace no longer serves the chat', async () => {
    await allow(chat.member, member);
    const { chatLoginRefusal } = await import('@mantle/telegram');
    const ask = () =>
      chatLoginRefusal({
        ownerId: owner,
        loginId: member,
        accountId: account.team,
        responderAgentId: null,
      });
    expect(await ask()).toBeNull();
    await x(
      sql`delete from workspace_users where workspace_id = ${teamWs} and login_id = ${member}`,
    );
    expect(await ask()).toBe('not_a_user');
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${teamWs}, ${member}, false)`);
    expect(await ask()).toBeNull();
  });
});
