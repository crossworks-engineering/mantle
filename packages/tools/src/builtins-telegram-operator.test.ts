/**
 * Behavioural tests for each user's Telegram operator tools: telegram_pair,
 * telegram_edit, telegram_react, telegram_mark_processed, telegram_pending.
 * The send tool has its own file.
 *
 * Telegram per paired user (workspaces W7d): every tool here acts only on
 * the chats paired to the caller's own login, the anchor included (its own
 * chats, no longer every chat), and `telegram_pair` pairs a chat to the
 * caller and nobody else: the login comes from the call (its MCP
 * connection, its scope, the anchor's stdio), never from the arguments.
 * The pairing rules themselves (the code, the workspace, the race) live in
 * @mantle/telegram pairing.ts and are proved against a database in
 * server/web/server/w7d-telegram.db.test.ts; here the transport and that
 * module are stubbed, the tools' wiring and guards are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const selectQueue: unknown[][] = [];
const whereArgs: unknown[] = [];
let updateReturn: unknown[] = [];

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const select = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    where: vi.fn(function (this: unknown, arg: unknown) {
      whereArgs.push(arg);
      return this;
    }),
    limit: vi.fn().mockReturnThis(),
    then: (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
      Promise.resolve(selectQueue.shift() ?? []).then(res, rej),
  };
  const update = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn(function (this: unknown, arg: unknown) {
      whereArgs.push(arg);
      return this;
    }),
    returning: vi.fn(async () => updateReturn),
    then: (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
      Promise.resolve(updateReturn).then(res, rej),
  };
  return {
    ...actual,
    db: { ...actual.db, select: vi.fn(() => select), update: vi.fn(() => update) },
  };
});
vi.mock('@mantle/telegram', () => ({
  accountById: vi.fn(),
  pairedChatOf: vi.fn(),
  pairChatWithCode: vi.fn(),
  sendMessage: vi.fn(),
  editMessage: vi.fn(),
  reactToMessage: vi.fn(),
}));

import * as dbmod from '@mantle/db';
import {
  accountById,
  editMessage,
  pairChatWithCode,
  pairedChatOf,
  reactToMessage,
  sendMessage,
} from '@mantle/telegram';
import {
  TELEGRAM_NO_LOGIN_ERROR,
  TELEGRAM_OPERATOR_TOOLS,
  telegram_send,
} from './builtins-telegram';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const pair = TELEGRAM_OPERATOR_TOOLS.find((t) => t.slug === 'telegram_pair')!;
const edit = TELEGRAM_OPERATOR_TOOLS.find((t) => t.slug === 'telegram_edit')!;
const react = TELEGRAM_OPERATOR_TOOLS.find((t) => t.slug === 'telegram_react')!;
const markProcessed = TELEGRAM_OPERATOR_TOOLS.find((t) => t.slug === 'telegram_mark_processed')!;
const pending = TELEGRAM_OPERATOR_TOOLS.find((t) => t.slug === 'telegram_pending')!;

const ANCHOR = 'o1';
// The anchor's own stdio MCP: an owner surface that names no login.
const stdio: ToolHandlerContext = { ownerId: ANCHOR, surface: { kind: 'owner', via: 'mcp' } };
// A member's own MCP connection (one surface for every login since W7b).
const member: ToolHandlerContext = {
  ownerId: ANCHOR,
  surface: { kind: 'owner', via: 'mcp', loginId: 'member-1' },
};
// A peer that names no login.
const noLogin: ToolHandlerContext = {
  ownerId: ANCHOR,
  surface: { kind: 'owner', via: 'federation' },
};
const ACCOUNT = { id: 'acct-1', token: 'secret', enabled: true };
const CHAT = '12345';
const CODE = 'a1b2c3';
const PAIRED = { id: 'chat-row-1', accountId: 'acct-1', telegramChatId: CHAT };

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): unknown {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output;
}

/** Bound parameter values of a drizzle SQL tree, in order. */
function paramsOf(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  const o = node as { queryChunks?: unknown[]; value?: unknown; encoder?: unknown };
  if (Array.isArray(o.queryChunks)) for (const c of o.queryChunks) paramsOf(c, out);
  else if ('value' in o && 'encoder' in o) out.push(o.value);
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  whereArgs.length = 0;
  updateReturn = [];
  vi.mocked(accountById).mockResolvedValue(ACCOUNT as never);
  vi.mocked(pairedChatOf).mockResolvedValue(PAIRED as never);
  vi.mocked(pairChatWithCode).mockResolvedValue({
    ok: true,
    already: false,
    chat: { id: 'chat-row-1', telegramChatId: CHAT, label: 'Alex', agentName: 'Saskia' },
  } as never);
  vi.mocked(sendMessage).mockResolvedValue([1] as never);
  vi.mocked(editMessage).mockResolvedValue(undefined as never);
  vi.mocked(reactToMessage).mockResolvedValue(undefined as never);
});

describe('operator surface', () => {
  it('is MCP-only: none of these can ever be granted to an agent', () => {
    for (const t of [pair, edit, react, markProcessed, pending]) {
      expect(t.mcpOnly, `${t.slug} must be mcpOnly`).toBe(true);
    }
  });
});

describe('telegram_pair: only the user pairs their own chat (W7d, answer 1A)', () => {
  it("pairs the chat to the caller's own login: a member's MCP connection", async () => {
    const res = await pair.handler({ code: CODE }, member);
    expect(pairChatWithCode).toHaveBeenCalledWith({
      ownerId: ANCHOR,
      loginId: 'member-1',
      code: CODE,
    });
    expect(outputOf(res)).toMatch(/paired chat 12345 \(Alex\) to you/);
  });

  it("the anchor's stdio MCP pairs to the anchor", async () => {
    await pair.handler({ code: CODE }, stdio);
    expect(vi.mocked(pairChatWithCode).mock.calls[0]![0]).toMatchObject({ loginId: ANCHOR });
  });

  it('never takes a login from the arguments', async () => {
    await pair.handler({ code: CODE, login_id: 'someone-else', loginId: 'someone-else' }, member);
    expect(vi.mocked(pairChatWithCode).mock.calls[0]![0]).toMatchObject({ loginId: 'member-1' });
  });

  it('a call that names no login pairs nothing', async () => {
    expect(errorOf(await pair.handler({ code: CODE }, noLogin))).toBe(TELEGRAM_NO_LOGIN_ERROR);
    expect(pairChatWithCode).not.toHaveBeenCalled();
  });

  it("hands the pairing module's refusal back as the error", async () => {
    vi.mocked(pairChatWithCode).mockResolvedValue({
      ok: false,
      error: 'you are not a user of this workspace',
      code: 'not_a_workspace_user',
    } as never);
    expect(errorOf(await pair.handler({ code: CODE }, member))).toMatch(/not a user/);
  });

  it('a chat already paired to the caller is a no-op', async () => {
    vi.mocked(pairChatWithCode).mockResolvedValue({
      ok: true,
      already: true,
      chat: { id: 'c', telegramChatId: CHAT, label: 'Alex', agentName: null },
    } as never);
    expect(outputOf(await pair.handler({ code: CODE }, member))).toBe('already paired to you');
  });

  it('refuses a malformed code before any lookup', async () => {
    expect(errorOf(await pair.handler({ code: 'zzz' }, member))).toMatch(/six hex digits/);
    expect(pairChatWithCode).not.toHaveBeenCalled();
  });
});

describe('telegram_edit / telegram_react: own chats only, before the wire', () => {
  it("looks the chat up among the caller's own chats and edits on that chat's bot", async () => {
    const res = await edit.handler({ chat_id: CHAT, message_id: '9', text: 'new' }, member);
    expect(pairedChatOf).toHaveBeenCalledWith({
      ownerId: ANCHOR,
      loginId: 'member-1',
      telegramChatId: CHAT,
    });
    expect(accountById).toHaveBeenCalledWith('acct-1');
    expect(editMessage).toHaveBeenCalledWith(ACCOUNT, CHAT, '9', 'new', expect.anything());
    expect(outputOf(res)).toBe('edited');
  });

  it("refuses another user's chat (the anchor's included) and touches nothing", async () => {
    vi.mocked(pairedChatOf).mockResolvedValue(null as never);
    expect(
      errorOf(await edit.handler({ chat_id: CHAT, message_id: '9', text: 'x' }, member)),
    ).toMatch(/not one of your paired chats/);
    expect(
      errorOf(await react.handler({ chat_id: CHAT, message_id: '9', emoji: '👍' }, member)),
    ).toMatch(/not one of your paired chats/);
    expect(editMessage).not.toHaveBeenCalled();
    expect(reactToMessage).not.toHaveBeenCalled();
  });

  it('a call that names no login touches nothing', async () => {
    expect(
      errorOf(await react.handler({ chat_id: CHAT, message_id: '9', emoji: '👍' }, noLogin)),
    ).toBe(TELEGRAM_NO_LOGIN_ERROR);
    expect(pairedChatOf).not.toHaveBeenCalled();
    expect(reactToMessage).not.toHaveBeenCalled();
  });

  it('surfaces a transport failure as a tool error', async () => {
    vi.mocked(reactToMessage).mockRejectedValue(new Error('REACTION_INVALID'));
    const res = await react.handler({ chat_id: CHAT, message_id: '9', emoji: '🦄' }, stdio);
    expect(errorOf(res)).toMatch(/react failed: REACTION_INVALID/);
  });
});

describe('telegram_pending / telegram_mark_processed: own chats only', () => {
  it("lists only the caller's own allowed chats", async () => {
    selectQueue.push([]);
    await pending.handler({}, member);
    const params = paramsOf(whereArgs[0]);
    expect(params).toEqual(expect.arrayContaining([ANCHOR, 'member-1', 'allowed']));
  });

  it("the anchor lists its own chats, no longer every user's", async () => {
    selectQueue.push([]);
    await pending.handler({}, stdio);
    expect(paramsOf(whereArgs[0])).toEqual(expect.arrayContaining([ANCHOR, 'allowed']));
    // Two ANCHOR values: the brain and the login.
    expect(paramsOf(whereArgs[0]).filter((p) => p === ANCHOR)).toHaveLength(2);
  });

  it("marks a message only in the caller's own chat, else reports the miss", async () => {
    selectQueue.push([]); // not one of member-1's chats
    const res = await markProcessed.handler({ id: 'm1' }, member);
    expect(errorOf(res)).toMatch(/no such message in your chats/);
    expect(paramsOf(whereArgs[0])).toEqual(expect.arrayContaining([ANCHOR, 'member-1']));
    expect(dbmod.db.update).not.toHaveBeenCalled();
  });

  it('marks it when it is theirs', async () => {
    selectQueue.push([{ id: 'm1' }]);
    updateReturn = [{ id: 'm1' }];
    expect(outputOf(await markProcessed.handler({ id: 'm1' }, member))).toBe('marked processed');
  });
});

describe('telegram_send on direct MCP: only to the caller own chats (W7d)', () => {
  it("a member's MCP sends only to a chat paired to that member", async () => {
    await telegram_send.handler({ chat_id: CHAT, text: 'hi' }, member);
    expect(vi.mocked(pairedChatOf).mock.calls[0]![0]).toMatchObject({ loginId: 'member-1' });
  });

  it("refuses the anchor's chat to another login's MCP", async () => {
    vi.mocked(pairedChatOf).mockResolvedValue(null as never);
    const res = await telegram_send.handler({ chat_id: CHAT, text: 'hi' }, member);
    expect(res.ok).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
