/**
 * Only an admin-level agent is on Telegram (access matrix T21, option 3), on
 * a real migrated Postgres. A paired chat acts as the owner, so:
 *
 *  - pairing a chat is refused when the bot's agent, or the agent the chat
 *    is pinned to, is team, client or public: by the telegram_pair tool and
 *    by the pairing screen's approve route, with a refusal that names the
 *    level and a `code` the screen keys on. Blocking stays open;
 *  - linking a bot to a below-admin agent is refused before the token
 *    reaches Telegram, and so is pinning a chat to one;
 *  - lowering an agent that has a bot, or answers a paired chat, is refused
 *    (point 3: refuse, not warn), and goes through once neither holds.
 *
 * No real bot: the Telegram transport's send is faked and getMe meets a
 * stubbed fetch. The owner is the test anchor, with `getOwnerOr401` faked
 * (no session is minted).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/telegram-level.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const who = vi.hoisted(() => ({ anchor: '' }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({ id: who.anchor, actor: { id: who.anchor, email: 'a' } })),
}));
const sent = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@mantle/telegram', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendMessage: vi.fn(async (...a: unknown[]) => {
    sent.calls.push(a);
    return [1];
  }),
}));

describe.skipIf(!URL)('Telegram is for admin-level agents only (T21)', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof ensureTestAnchor>[0];
  const tag = `tg-level-${randomUUID().slice(0, 8)}`;
  const agent = { admin: randomUUID(), team: randomUUID(), lower: randomUUID(), pin: randomUUID() };
  const channel = { admin: randomUUID(), team: randomUUID(), lower: randomUUID() };
  const account = { admin: randomUUID(), team: randomUUID(), lower: randomUUID() };
  const chat = {
    onTeamBot: randomUUID(),
    pinnedToTeam: randomUUID(),
    onAdminBot: randomUUID(),
    pinnedToPin: randomUUID(),
  };
  const code = { onTeamBot: 'a1a1a1', pinnedToTeam: 'b2b2b2', onAdminBot: 'c3c3c3' };

  const statusOf = async (id: string) =>
    (
      (await sql`select allowlist_status as s, pairing_code as c from telegram_chats
                 where id = ${id}`) as unknown as { s: string; c: string | null }[]
    )[0]!;
  const levelOf = async (id: string) =>
    (
      (await sql`select audience from agents where id = ${id}`) as unknown as { audience: string }[]
    )[0]!.audience;
  const json = (body: unknown) => ({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    who.anchor = await ensureTestAnchor(sql);
    const o = who.anchor;
    await sql`insert into agents (id, owner_id, slug, name, model, system_prompt, audience) values
      (${agent.admin}, ${o}, ${`${tag}-admin`}, 'Ada', 'm', 'p', 'admin'),
      (${agent.team}, ${o}, ${`${tag}-team`}, 'Helper', 'm', 'p', 'team'),
      (${agent.lower}, ${o}, ${`${tag}-lower`}, 'Lowered', 'm', 'p', 'admin'),
      (${agent.pin}, ${o}, ${`${tag}-pin`}, 'Pinned', 'm', 'p', 'admin')`;
    // A team agent's bot is the state from before T21: it can no longer be
    // made through the app, which is part of what is under test.
    for (const k of ['admin', 'team', 'lower'] as const) {
      await sql`insert into channels (id, owner_id, agent_id, type, display_name, credentials_enc)
                values (${channel[k]}, ${o}, ${agent[k]}, 'telegram', ${`@${tag}_${k}_bot`}, '\\x00')`;
      await sql`insert into telegram_accounts (id, user_id, bot_username, branch_path, channel_id)
                values (${account[k]}, ${o}, ${`${tag}_${k}_bot`}, 'inbox.telegram_test', ${channel[k]})`;
    }
    await sql`insert into telegram_chats
        (id, account_id, user_id, telegram_chat_id, chat_type, title, allowlist_status,
         pairing_code, pairing_expires_at, responder_agent_id) values
      (${chat.onTeamBot}, ${account.team}, ${o}, '9001', 'private', 'Sam', 'pending',
       ${code.onTeamBot}, now() + interval '1 hour', null),
      (${chat.pinnedToTeam}, ${account.admin}, ${o}, '9002', 'private', 'Kim', 'pending',
       ${code.pinnedToTeam}, now() + interval '1 hour', ${agent.team}),
      (${chat.onAdminBot}, ${account.admin}, ${o}, '9003', 'private', 'Lee', 'pending',
       ${code.onAdminBot}, now() + interval '1 hour', null),
      (${chat.pinnedToPin}, ${account.admin}, ${o}, '9004', 'private', 'Max', 'allowed',
       null, null, ${agent.pin})`;
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from telegram_chats where id in ${sql(Object.values(chat))}`;
    await sql`delete from telegram_accounts where id in ${sql(Object.values(account))}`;
    await sql`delete from channels where id in ${sql(Object.values(channel))}`;
    await sql`delete from agents where id in ${sql(Object.values(agent))}`;
    await m.closeDb();
  });

  const pair = async (c: string) => {
    const { BUILTIN_TOOLS } = await import('@mantle/tools');
    const tool = BUILTIN_TOOLS.find((t) => t.slug === 'telegram_pair')!;
    return tool.handler({ code: c }, { ownerId: who.anchor });
  };

  it("telegram_pair refuses a team agent's bot, naming its level, and pairs nothing", async () => {
    const res = await pair(code.onTeamBot);
    expect(res.ok).toBe(false);
    const error = res.ok ? '' : res.error;
    expect(error).toContain('Helper is a team-level agent');
    expect(error).toContain("Only an admin-level agent's bot can be paired");
    expect(error).toContain('acts as the owner');
    expect(await statusOf(chat.onTeamBot)).toEqual({ s: 'pending', c: code.onTeamBot });
  });

  it('telegram_pair refuses a chat pinned to a team agent, on an admin bot', async () => {
    const res = await pair(code.pinnedToTeam);
    expect(res.ok ? '' : res.error).toContain('Helper is a team-level agent');
    expect((await statusOf(chat.pinnedToTeam)).s).toBe('pending');
  });

  it("the pairing screen's Approve is refused with the level code; Block still works", async () => {
    const { POST } = await import('../app/api/agents/[id]/telegram/chats/route');
    const post = (status: string) =>
      POST(
        new Request('http://x/api', {
          method: 'POST',
          ...json({ chatId: chat.onTeamBot, status }),
        }),
        {
          params: Promise.resolve({ id: agent.team }),
        },
      );
    const approve = await post('allowed');
    expect(approve.status).toBe(400);
    const body = (await approve.json()) as { error: string; code?: string };
    expect(body.code).toBe('agent_below_admin');
    expect(body.error).toContain('Helper is a team-level agent');
    expect((await statusOf(chat.onTeamBot)).s).toBe('pending');

    const block = await post('denied');
    expect(block.status).toBe(200);
    expect((await statusOf(chat.onTeamBot)).s).toBe('denied');
  });

  it('an admin agent pairs as before, on the tool and the screen', async () => {
    sent.calls.length = 0;
    const res = await pair(code.onAdminBot);
    expect(res.ok).toBe(true);
    expect((await statusOf(chat.onAdminBot)).s).toBe('allowed');
    expect(sent.calls[0]?.[2]).toBe('Paired! Say hi to Ada.');
  });

  it('linking a bot to a team agent is refused before the token reaches Telegram', async () => {
    const { POST } = await import('../app/api/agents/[id]/telegram/route');
    const connect = (id: string) =>
      POST(
        new Request('http://x/api', { method: 'POST', ...json({ token: '123456:ABCDEFGHIJ' }) }),
        {
          params: Promise.resolve({ id }),
        },
      );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 401 }));
    try {
      const refused = await connect(agent.team);
      expect(refused.status).toBe(400);
      const body = (await refused.json()) as { error: string; code?: string };
      expect(body.code).toBe('agent_below_admin');
      expect(body.error).toContain('Only an admin-level agent can have a Telegram bot');
      expect(fetchSpy).not.toHaveBeenCalled();

      // An admin agent gets past the level check to Telegram (here a 401).
      const admin = await connect(agent.admin);
      expect(((await admin.json()) as { error: string }).error).toContain('(401)');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('a chat cannot be pinned to a team agent', async () => {
    const { PATCH } = await import('../app/api/telegram/chats/[id]/route');
    const pin = (responderAgentId: string) =>
      PATCH(new Request('http://x/api', { method: 'PATCH', ...json({ responderAgentId }) }), {
        params: Promise.resolve({ id: chat.onAdminBot }),
      });
    const refused = await pin(agent.team);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { code?: string }).code).toBe('agent_below_admin');
    expect((await pin(agent.pin)).status).toBe(200);
    await sql`update telegram_chats set responder_agent_id = null where id = ${chat.onAdminBot}`;
  });

  it('lowering an agent with a bot is refused, and goes through once the bot is off', async () => {
    const { setAgentAudience } = await import('@mantle/content');
    const refusal = await setAgentAudience(who.anchor, agent.lower, 'team').catch((e: Error) => e);
    expect(refusal).toMatchObject({ code: 'telegram_paired' });
    expect((refusal as Error).message).toContain(`has a Telegram bot (@${tag}_lower_bot)`);
    expect((refusal as Error).message).toContain('Disconnect the bot first');
    expect(await levelOf(agent.lower)).toBe('admin');

    // Raising or keeping admin is never in the way.
    await expect(setAgentAudience(who.anchor, agent.lower, 'admin')).resolves.toMatchObject({
      audience: 'admin',
    });

    await sql`update channels set enabled = false where id = ${channel.lower}`;
    await expect(setAgentAudience(who.anchor, agent.lower, 'team')).resolves.toMatchObject({
      audience: 'team',
    });
  });

  it('lowering an agent that answers a paired chat is refused, on the route too', async () => {
    const { PATCH } = await import('../app/api/access/agents/[slug]/route');
    const lower = () =>
      PATCH(new Request('http://x/api', { method: 'PATCH', ...json({ audience: 'client' }) }), {
        params: Promise.resolve({ slug: `${tag}-pin` }),
      });
    const refused = await lower();
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { error: string; code?: string };
    expect(body.code).toBe('telegram_paired');
    expect(body.error).toContain('answers 1 paired Telegram chat');
    expect(await levelOf(agent.pin)).toBe('admin');

    await sql`update telegram_chats set allowlist_status = 'denied' where id = ${chat.pinnedToPin}`;
    expect((await lower()).status).toBe(200);
    expect(await levelOf(agent.pin)).toBe('client');
  });
});
