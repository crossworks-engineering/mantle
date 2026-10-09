/**
 * A Telegram turn runs only for an admin-level agent (access matrix T21,
 * option 3), on a real migrated Postgres: `handleTelegramMessage` reads the
 * agent's level and the bot's agent's level from the database at the turn,
 * so a chat paired before its agent was lowered is refused as well. A
 * refused chat gets one plain reply and no turn (no model, no tool).
 *
 * No real bot: the transport's sends are faked and the turn itself
 * (`runTelegramTurn`, where the model would run) is a spy, so the test sees
 * exactly whether a turn would have started.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/agent/telegram-level.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({ sent: [] as unknown[][], turns: [] as unknown[] }));
vi.mock('@mantle/telegram', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendMessage: vi.fn(async (...a: unknown[]) => {
    h.sent.push(a);
    return [1];
  }),
  sendChatAction: vi.fn(async () => {}),
}));
vi.mock('./telegram/turn', () => ({
  runTelegramTurn: vi.fn(async (input: unknown) => {
    h.turns.push(input);
  }),
}));
vi.mock('@mantle/tracing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startTrace: async (_init: unknown, fn: () => Promise<unknown>) => fn(),
}));

const REFUSAL =
  'This chat is turned off: only an admin-level agent answers on Telegram. Ask the owner.';

describe.skipIf(!URL)('a Telegram turn needs an admin-level agent (T21)', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof ensureTestAnchor>[0];
  let handleTelegramMessage: (id: string) => Promise<void>;
  const tag = `tg-turn-${randomUUID().slice(0, 8)}`;
  const agent = { admin: randomUUID(), team: randomUUID(), lowered: randomUUID() };
  const channel = { admin: randomUUID(), team: randomUUID(), lowered: randomUUID() };
  const account = { admin: randomUUID(), team: randomUUID(), lowered: randomUUID() };
  const chat = { admin: randomUUID(), team: randomUUID(), lowered: randomUUID() };
  const created = { nodes: [] as string[], messages: [] as string[] };
  let seq = 0;
  let anchor = '';

  /** One inbound message on a chat, as the poller stores it. */
  const inbound = async (k: keyof typeof chat, text = 'hello'): Promise<string> => {
    const node = randomUUID();
    const msg = randomUUID();
    await sql`insert into nodes (id, owner_id, type, title, path)
              values (${node}, ${anchor}, 'telegram_message', ${text}, 'inbox.telegram_test')`;
    await sql`insert into telegram_messages
        (id, node_id, account_id, chat_id, telegram_message_id, telegram_update_id,
         from_user_id, from_name, text, sent_at, direction)
      values (${msg}, ${node}, ${account[k]}, ${chat[k]}, ${String(++seq)}, ${seq},
              '42', 'Sam', ${text}, now(), 'inbound')`;
    created.nodes.push(node);
    created.messages.push(msg);
    return msg;
  };
  const processed = async (id: string) =>
    (
      (await sql`select processed from telegram_messages where id = ${id}`) as unknown as {
        processed: boolean;
      }[]
    )[0]!.processed;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    anchor = await ensureTestAnchor(sql);
    // The runtime reads its owner once at import.
    process.env.ALLOWED_USER_ID = anchor;
    ({ handleTelegramMessage } = await import('./runtime'));
    // `local` needs no key, so an admin agent reaches the turn itself.
    await sql`insert into agents (id, owner_id, slug, name, provider, model, system_prompt, audience)
      values
      (${agent.admin}, ${anchor}, ${`${tag}-admin`}, 'Ada', 'local', 'm', 'p', 'admin'),
      (${agent.team}, ${anchor}, ${`${tag}-team`}, 'Helper', 'local', 'm', 'p', 'team'),
      (${agent.lowered}, ${anchor}, ${`${tag}-lowered`}, 'Lowered', 'local', 'm', 'p', 'admin')`;
    for (const k of ['admin', 'team', 'lowered'] as const) {
      await sql`insert into channels (id, owner_id, agent_id, type, display_name, credentials_enc)
                values (${channel[k]}, ${anchor}, ${agent[k]}, 'telegram', ${`@${tag}_${k}`}, '\\x00')`;
      await sql`insert into telegram_accounts (id, user_id, bot_username, branch_path, channel_id)
                values (${account[k]}, ${anchor}, ${`${tag}_${k}`}, 'inbox.telegram_test', ${channel[k]})`;
      // Every chat is paired: the refusal must not lean on the allowlist.
      await sql`insert into telegram_chats
                  (id, account_id, user_id, telegram_chat_id, chat_type, allowlist_status)
                values (${chat[k]}, ${account[k]}, ${anchor}, ${`${tag}-${k}`}, 'private', 'allowed')`;
    }
  }, 120_000);

  afterAll(async () => {
    if (!sql) return;
    if (created.messages.length > 0) {
      await sql`delete from telegram_messages where id in ${sql(created.messages)}`;
      await sql`delete from nodes where id in ${sql(created.nodes)}`;
    }
    await sql`delete from telegram_chats where id in ${sql(Object.values(chat))}`;
    await sql`delete from telegram_accounts where id in ${sql(Object.values(account))}`;
    await sql`delete from channels where id in ${sql(Object.values(channel))}`;
    await sql`delete from agents where id in ${sql(Object.values(agent))}`;
    await m.closeDb();
  });

  beforeEach(() => {
    h.sent.length = 0;
    h.turns.length = 0;
  });

  it("a paired chat on a team agent's bot gets one plain reply and no turn", async () => {
    const msg = await inbound('team');
    await handleTelegramMessage(msg);
    expect(h.turns).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]![1]).toBe(`${tag}-team`);
    expect(h.sent[0]![2]).toBe(REFUSAL);
    // Claimed, so it is not retried into a second reply.
    expect(await processed(msg)).toBe(true);
  });

  it('an admin agent lowered after its chat was paired is refused from the next message', async () => {
    const before = await inbound('lowered');
    await handleTelegramMessage(before);
    expect(h.turns).toHaveLength(1);

    await sql`update agents set audience = 'client' where id = ${agent.lowered}`;
    h.turns.length = 0;
    const after = await inbound('lowered');
    await handleTelegramMessage(after);
    expect(h.turns).toHaveLength(0);
    expect(h.sent.map((s) => s[2])).toEqual([REFUSAL]);
  });

  it("a chat pinned to an admin agent on a below-admin agent's bot is refused", async () => {
    await sql`update telegram_chats set responder_agent_id = ${agent.admin} where id = ${chat.team}`;
    try {
      await handleTelegramMessage(await inbound('team'));
      expect(h.turns).toHaveLength(0);
      expect(h.sent.map((s) => s[2])).toEqual([REFUSAL]);
    } finally {
      await sql`update telegram_chats set responder_agent_id = null where id = ${chat.team}`;
    }
  });

  it('an admin agent on an admin bot runs its turn as before', async () => {
    await handleTelegramMessage(await inbound('admin'));
    expect(h.turns).toHaveLength(1);
    expect(h.sent.map((s) => s[2])).not.toContain(REFUSAL);
  });
});
