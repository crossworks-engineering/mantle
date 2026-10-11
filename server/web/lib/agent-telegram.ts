/**
 * Per-agent Telegram bot binding for the /settings/agents form. The binding
 * (which agent) + the sealed bot token live in the generic `channels` table
 * (docs/comms-channels.md); `telegram_accounts` is the transport-specific
 * poll-state extension, linked 1:1 via `channel_id`. Any agent can attach a
 * bot — `role` no longer gates transport.
 *
 * Connect flow: validate the token via Telegram's getMe (also yields the bot
 * username + branch path), upsert the account's poll-state row, then write the
 * channel (token + binding) via `upsertTelegramChannel`.
 */
import { and, desc, eq } from 'drizzle-orm';
import {
  agents,
  asSystem,
  authUsers,
  channels,
  db,
  telegramAccounts,
  telegramChats,
} from '@mantle/db';
import {
  disableTelegramChannel,
  loginModeratesBot,
  pairChatWithCode,
  previewChatPairing,
  setChatPairing,
  upsertTelegramChannel,
  type PairingRefusal,
} from '@mantle/telegram';
import type {
  AgentTelegramBinding,
  AgentTelegramChat,
  ModeratedTelegramChat,
  MyTelegramChat,
  TelegramPairPreview,
  TelegramPairResult,
} from '@mantle/client-types';
export type {
  AgentTelegramBinding,
  AgentTelegramChat,
  ModeratedTelegramChat,
  MyTelegramChat,
  TelegramPairPreview,
  TelegramPairResult,
};

/** Thrown for user-fixable problems (bad token, username already taken, a
 *  pairing refusal). The API layer surfaces `.message` to the form, and
 *  `.code` when set, so the screen can tell a standing refusal apart. */
export class TelegramTokenError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function getMe(token: string): Promise<{ id: number; username: string }> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  } catch {
    throw new TelegramTokenError('Could not reach Telegram. Check your connection and try again.');
  }
  if (res.status === 401) throw new TelegramTokenError('Telegram rejected this token (401).');
  if (!res.ok) throw new TelegramTokenError(`Telegram getMe failed (HTTP ${res.status}).`);
  const body = (await res.json().catch(() => null)) as {
    ok: boolean;
    result?: { id: number; username?: string };
  } | null;
  if (!body?.ok || !body.result?.username) {
    throw new TelegramTokenError('Telegram accepted the request but returned no bot username.');
  }
  return { id: body.result.id, username: body.result.username };
}

type AccountRow = typeof telegramAccounts.$inferSelect;

function toBinding(account: AccountRow, channelEnabled: boolean): AgentTelegramBinding {
  return {
    accountId: account.id,
    botUsername: account.botUsername,
    // The channel is the source of truth for enabled/disabled now.
    enabled: channelEnabled,
    lastPollAt: account.lastPollAt?.toISOString() ?? null,
    lastPollError: account.lastPollError,
  };
}

/** The account row + its channel.enabled for the agent's telegram channel. */
async function accountForAgent(
  ownerId: string,
  agentId: string,
): Promise<{ account: AccountRow; channelEnabled: boolean } | null> {
  const [row] = await db
    .select({ account: telegramAccounts, channelEnabled: channels.enabled })
    .from(telegramAccounts)
    .innerJoin(channels, eq(telegramAccounts.channelId, channels.id))
    .where(
      and(
        eq(channels.ownerId, ownerId),
        eq(channels.agentId, agentId),
        eq(channels.type, 'telegram'),
      ),
    )
    .limit(1);
  return row ? { account: row.account, channelEnabled: row.channelEnabled } : null;
}

/** The agent that owns the channel linked to an account, if any. */
async function channelAgentForAccount(accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ agentId: channels.agentId })
    .from(channels)
    .innerJoin(telegramAccounts, eq(telegramAccounts.channelId, channels.id))
    .where(eq(telegramAccounts.id, accountId))
    .limit(1);
  return row?.agentId ?? null;
}

/** The bot currently bound to this agent, or null. */
export async function getAgentTelegram(
  ownerId: string,
  agentId: string,
): Promise<AgentTelegramBinding | null> {
  const found = await accountForAgent(ownerId, agentId);
  return found ? toBinding(found.account, found.channelEnabled) : null;
}

/**
 * Validate `token`, then bind its bot to `agentId` — updating the agent's
 * existing bound bot, adopting an existing same-username account (e.g. a
 * CLI-seeded bot), or inserting a new account. The token + agent binding land
 * on the `channels` row (`upsertTelegramChannel`); the account row holds only
 * poll state. Re-enables the channel.
 */
export async function connectAgentTelegram(
  ownerId: string,
  agentId: string,
  token: string,
): Promise<AgentTelegramBinding> {
  const trimmed = token.trim();
  if (!trimmed) throw new TelegramTokenError('Paste a bot token.');
  // Any workspace's assistant may have a bot (workspaces W7d): its chats are
  // paired to users of its workspace, each answered as that user.
  const me = await getMe(trimmed);
  const branchPath = `inbox.telegram_${me.username.toLowerCase()}`;

  const byAgent = (await accountForAgent(ownerId, agentId))?.account;
  const [byUsername] = await db
    .select()
    .from(telegramAccounts)
    .where(and(eq(telegramAccounts.userId, ownerId), eq(telegramAccounts.botUsername, me.username)))
    .limit(1);

  // The bot is already owned by a different agent's channel — refuse to steal it.
  if (byUsername) {
    const owner = await channelAgentForAccount(byUsername.id);
    if (owner && owner !== agentId) {
      throw new TelegramTokenError(`@${me.username} is already linked to another agent.`);
    }
  }

  const target = byAgent ?? byUsername;
  let accountId: string;
  if (target) {
    accountId = target.id;
    // Pointing this row at a *different* bot? Telegram update-ids are per-bot,
    // so the old bot's offset is meaningless for the new one — carrying it over
    // can skip past the new bot's early messages. Reset so its stream is read
    // from the start. (Same-bot token rotation keeps the offset.)
    const botChanged = target.botUsername !== me.username;
    await db
      .update(telegramAccounts)
      .set({
        botUsername: me.username,
        branchPath,
        enabled: true,
        lastPollError: null,
        ...(botChanged ? { lastUpdateOffset: 0 } : {}),
        updatedAt: new Date(),
      })
      .where(eq(telegramAccounts.id, accountId));
  } else {
    const [inserted] = await db
      .insert(telegramAccounts)
      .values({
        userId: ownerId,
        botUsername: me.username,
        branchPath,
        enabled: true,
      })
      .returning({ id: telegramAccounts.id });
    accountId = inserted!.id;
  }

  // The channel holds the token (sealed under the channel id) + the agent
  // binding, and links the account via channel_id. This is the source of truth.
  await upsertTelegramChannel({
    ownerId,
    agentId,
    accountId,
    botUsername: me.username,
    branchPath,
    token: trimmed,
    enabled: true,
  });

  const binding = await getAgentTelegram(ownerId, agentId);
  if (!binding) throw new Error('failed to read back telegram binding');
  return binding;
}

/**
 * Unlink the bot from the agent and stop polling. Disables the channel (the
 * poll gate) and the account; keeps both rows + message history (a hard delete
 * would cascade telegram_chats + telegram_messages).
 */
export async function disconnectAgentTelegram(ownerId: string, agentId: string): Promise<void> {
  // Disable the channel — the poll gate. Keeps the row + history.
  await disableTelegramChannel(ownerId, agentId);
  // Also flip the account's own enabled flag for consistency (vestigial poll
  // state now that the channel gates polling).
  const found = await accountForAgent(ownerId, agentId);
  if (found) {
    await db
      .update(telegramAccounts)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(telegramAccounts.id, found.account.id));
  }
}

const STATUS_ORDER: Record<AgentTelegramChat['status'], number> = {
  pending: 0,
  allowed: 1,
  denied: 2,
};

/** A login's name for a list: its display name, else its email. */
function nameOf(row: { displayName: string | null; email: string | null }): string | null {
  return row.displayName?.trim() || row.email || null;
}

/**
 * Chats this agent's bot has seen — pending pairing requests first, then
 * allowed, then denied; recent within each, each with the user it is
 * paired to (workspaces W7d). For the Settings screen of the bot, where a
 * Moderator or an Admin user blocks or unpairs a chat; pairing itself is the
 * user's own, with the chat's code (pairMyTelegramChat).
 */
export async function listAgentTelegramChats(
  ownerId: string,
  agentId: string,
): Promise<AgentTelegramChat[]> {
  const binding = await getAgentTelegram(ownerId, agentId);
  if (!binding) return [];
  return chatsOfBot(ownerId, binding.accountId);
}

/** Every chat of bot `accountId`, with the user each is paired to, sorted
 *  for a list. The caller has checked who may see them. */
async function chatsOfBot(ownerId: string, accountId: string): Promise<AgentTelegramChat[]> {
  const rows = await asSystem(
    () =>
      db
        .select({
          chat: telegramChats,
          displayName: authUsers.displayName,
          email: authUsers.email,
        })
        .from(telegramChats)
        .leftJoin(authUsers, eq(authUsers.id, telegramChats.loginId))
        .where(and(eq(telegramChats.userId, ownerId), eq(telegramChats.accountId, accountId))),
    'login-telegram',
  );
  return rows
    .map(({ chat: r, displayName, email }) => ({
      id: r.id,
      telegramChatId: r.telegramChatId,
      label: r.title ?? (r.username ? `@${r.username}` : r.telegramChatId),
      status: r.allowlistStatus,
      lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
      loginId: r.loginId ?? null,
      pairedTo: r.loginId ? nameOf({ displayName, email }) : null,
    }))
    .sort((a, b) => {
      const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (s !== 0) return s;
      return (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '');
    });
}

/** The HTTP status a pairing refusal answers with. */
export function pairingRefusalStatus(r: PairingRefusal): number {
  switch (r.code) {
    case 'not_found':
    case 'no_such_code':
      return 404;
    case 'not_a_workspace_user':
    case 'not_allowed':
      return 403;
    case 'too_many_attempts':
      return 429;
    default:
      return 409;
  }
}

/**
 * Block or unpair a chat on this agent's bot (Settings), by `actorLoginId`:
 * a Moderator of the bot's workspace, an Admin user with the users area, or
 * the chat's own user (workspaces W7d). Never pairs: only the user pairs
 * their own chat, with its code. Throws TelegramTokenError on a refusal.
 */
export async function setAgentTelegramChat(args: {
  ownerId: string;
  actorLoginId: string;
  agentId: string;
  chatId: string;
  action: 'block' | 'unpair';
}): Promise<void> {
  const binding = await getAgentTelegram(args.ownerId, args.agentId);
  if (!binding) throw new TelegramTokenError('No bot is linked to this agent.');
  const r = await setChatPairing({
    ownerId: args.ownerId,
    actorLoginId: args.actorLoginId,
    chatId: args.chatId,
    action: args.action,
    accountId: binding.accountId,
  });
  if (!r.ok) throw new TelegramTokenError('Chat not found for this bot.', r.code);
}

/**
 * What the code would pair, without pairing (POST /api/telegram/pair with no
 * `confirm`, W7d fix round 1, M3): the chat, its bot and assistant, and the
 * token the confirm carries back. Or a refusal.
 */
export async function previewMyTelegramChat(args: {
  ownerId: string;
  loginId: string;
  code: string;
}): Promise<TelegramPairPreview | PairingRefusal> {
  const r = await previewChatPairing(args);
  if (!r.ok) return r;
  return {
    ok: true,
    paired: false,
    already: r.already,
    chat: r.preview.chat,
    bot: r.preview.bot,
    agentName: r.preview.agentName,
    previewToken: r.previewToken,
  };
}

/**
 * Pair the chat holding `code` to the signed-in login (POST
 * /api/telegram/pair with `confirm: true`, workspaces W7d): only for a bot
 * whose assistant's workspace that login is a user of, and only with the
 * preview's token (required, W7d+e): the chat that preview showed, for this
 * code, within ten minutes. The answer, or a refusal.
 */
export async function pairMyTelegramChat(args: {
  ownerId: string;
  loginId: string;
  code: string;
  previewToken: string;
}): Promise<TelegramPairResult | PairingRefusal> {
  const r = await pairChatWithCode(args);
  if (!r.ok) return r;
  return {
    ok: true,
    already: r.already,
    chat: {
      id: r.chat.id,
      telegramChatId: r.chat.telegramChatId,
      label: r.chat.label,
      agentName: r.chat.agentName,
    },
  };
}

/** The signed-in login's own paired chats (GET /api/telegram/my-chats). */
export async function listMyTelegramChats(
  ownerId: string,
  loginId: string,
): Promise<MyTelegramChat[]> {
  const rows = await asSystem(
    () =>
      db
        .select({
          id: telegramChats.id,
          telegramChatId: telegramChats.telegramChatId,
          title: telegramChats.title,
          username: telegramChats.username,
          lastMessageAt: telegramChats.lastMessageAt,
          botUsername: telegramAccounts.botUsername,
          agentName: agents.name,
          agentSlug: agents.slug,
        })
        .from(telegramChats)
        .innerJoin(telegramAccounts, eq(telegramAccounts.id, telegramChats.accountId))
        .leftJoin(channels, eq(channels.id, telegramAccounts.channelId))
        .leftJoin(agents, eq(agents.id, channels.agentId))
        .where(
          and(
            eq(telegramChats.userId, ownerId),
            eq(telegramChats.loginId, loginId),
            eq(telegramChats.allowlistStatus, 'allowed'),
          ),
        )
        .orderBy(desc(telegramChats.lastMessageAt)),
    'login-telegram',
  );
  return rows.map((r) => ({
    id: r.id,
    telegramChatId: r.telegramChatId,
    label: r.title ?? (r.username ? `@${r.username}` : r.telegramChatId),
    botUsername: r.botUsername,
    agentName: r.agentName ?? null,
    agentSlug: r.agentSlug ?? null,
    lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
  }));
}

/** Unpair one of the signed-in login's own chats (DELETE
 *  /api/telegram/my-chats/:id). False when it is not theirs. */
export async function unpairMyTelegramChat(
  ownerId: string,
  loginId: string,
  chatId: string,
): Promise<boolean> {
  const r = await setChatPairing({ ownerId, actorLoginId: loginId, chatId, action: 'unpair' });
  return r.ok;
}

/**
 * The chats of every bot the signed-in login moderates (GET
 * /api/telegram/moderated-chats, workspaces W7d): bots whose assistant's
 * workspace it is a Moderator of, or every bot for an Admin user with the
 * users area (loginModeratesBot). Empty for anyone else.
 */
export async function listModeratedTelegramChats(
  ownerId: string,
  loginId: string,
): Promise<ModeratedTelegramChat[]> {
  const bots = await asSystem(
    () =>
      db
        .select({
          accountId: telegramAccounts.id,
          botUsername: telegramAccounts.botUsername,
          agentName: agents.name,
          agentSlug: agents.slug,
        })
        .from(telegramAccounts)
        .leftJoin(channels, eq(channels.id, telegramAccounts.channelId))
        .leftJoin(agents, eq(agents.id, channels.agentId))
        .where(eq(telegramAccounts.userId, ownerId)),
    'login-telegram',
  );
  const out: ModeratedTelegramChat[] = [];
  for (const bot of bots) {
    if (!(await loginModeratesBot({ ownerId, loginId, accountId: bot.accountId }))) continue;
    for (const chat of await chatsOfBot(ownerId, bot.accountId)) {
      out.push({
        ...chat,
        botUsername: bot.botUsername,
        agentName: bot.agentName ?? null,
        agentSlug: bot.agentSlug ?? null,
      });
    }
  }
  return out;
}

/**
 * Block or unpair chat `chatId` by `actorLoginId` (POST
 * /api/telegram/chats/:id/block|unpair, workspaces W7d): its own user, a
 * Moderator of its bot's workspace, or an Admin user with the users area.
 * Null when done, else the refusal (a chat the login may not touch reads
 * as not found).
 */
export async function moderateTelegramChat(args: {
  ownerId: string;
  actorLoginId: string;
  chatId: string;
  action: 'block' | 'unpair';
}): Promise<PairingRefusal | null> {
  const r = await setChatPairing(args);
  return r.ok ? null : r;
}

/** The answer of POST /api/telegram/chats/:id/block and /unpair (any login
 *  but a client): `{ ok: true }`, 400 for a bad id, 404 for a chat the
 *  login may not touch. */
export async function moderateTelegramChatResponse(
  login: { kind: string; ownerId: string; loginId: string },
  rawId: string,
  action: 'block' | 'unpair',
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId)) {
    return { status: 400, body: { error: 'Invalid id.' } };
  }
  if (login.kind === 'client') return { status: 404, body: { error: 'Not found.' } };
  const refused = await moderateTelegramChat({
    ownerId: login.ownerId,
    actorLoginId: login.loginId,
    chatId: rawId,
    action,
  });
  if (refused) return { status: 404, body: { error: 'Not found.' } };
  return { status: 200, body: { ok: true } };
}
