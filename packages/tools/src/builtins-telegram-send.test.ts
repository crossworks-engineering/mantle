/**
 * Behavioural tests for telegram_send — the one Telegram tool an agent can
 * hold. It is outward-facing (a message leaves the brain), so the shape that
 * matters is the email_send one: every guard must hold BEFORE anything reaches
 * the transport. A test that only checks the error string would pass for a
 * tool that sent the message and then complained.
 *
 * Telegram per paired user (workspaces W7d): the chat must be allowlisted
 * AND paired to the caller's own login (`pairedChatOf` in @mantle/telegram,
 * stubbed here), and the message goes out on THAT chat's bot (`accountById`),
 * never the first enabled bot on the box. The tool's ordering and guards are
 * real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/telegram', () => ({
  pairedChatOf: vi.fn(),
  accountById: vi.fn(),
  sendMessage: vi.fn(),
  editMessage: vi.fn(),
  reactToMessage: vi.fn(),
  pairChatWithCode: vi.fn(),
}));

import { accountById, pairedChatOf, sendMessage } from '@mantle/telegram';
import { telegram_send, TELEGRAM_NO_LOGIN_ERROR } from './builtins-telegram';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

/** A signed-in login's web chat with its assistant. */
const ctx: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'web', loginId: 'login-a' } };
const ACCOUNT = { id: 'acct-2', token: 'secret', enabled: true };
const CHAT = '12345';
const PAIRED = { id: 'chat-pk', accountId: 'acct-2', telegramChatId: CHAT };

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pairedChatOf).mockResolvedValue(PAIRED as never);
  vi.mocked(accountById).mockResolvedValue(ACCOUNT as never);
  vi.mocked(sendMessage).mockResolvedValue([42] as never);
});

describe('telegram_send', () => {
  it("looks the chat up among the caller's own paired chats only (W7d)", async () => {
    await telegram_send.handler({ chat_id: CHAT, text: 'hi' }, ctx);
    expect(pairedChatOf).toHaveBeenCalledWith({
      ownerId: 'o1',
      loginId: 'login-a',
      telegramChatId: CHAT,
    });
  });

  it('a Telegram turn sends only to chats of the login its chat is paired to', async () => {
    await telegram_send.handler(
      { chat_id: CHAT, text: 'hi' },
      { ownerId: 'o1', surface: { kind: 'telegram', telegramChatId: '9', loginId: 'login-b' } },
    );
    expect(vi.mocked(pairedChatOf).mock.calls[0]![0]).toMatchObject({ loginId: 'login-b' });
  });

  it('is confirm-gated — a message leaves the brain', () => {
    expect(telegram_send.requiresConfirm).toBe(true);
  });

  it('requires chat_id and text, and touches nothing without them', async () => {
    expect(errorOf(await telegram_send.handler({ chat_id: CHAT }, ctx))).toMatch(
      /chat_id \+ text required/,
    );
    expect(errorOf(await telegram_send.handler({ text: 'hi' }, ctx))).toMatch(
      /chat_id \+ text required/,
    );
    expect(pairedChatOf).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a call that names no login, before any lookup', async () => {
    const res = await telegram_send.handler({ chat_id: CHAT, text: 'hi' }, { ownerId: 'o1' });
    expect(errorOf(res)).toBe(TELEGRAM_NO_LOGIN_ERROR);
    expect(pairedChatOf).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("refuses another user's chat (or an unpaired one) like an unknown one, before the wire", async () => {
    vi.mocked(pairedChatOf).mockResolvedValue(null as never);
    const res = await telegram_send.handler({ chat_id: CHAT, text: 'hi' }, ctx);
    expect(errorOf(res)).toMatch(/not one of your paired chats/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("refuses when the chat's bot is gone or off, before the wire", async () => {
    vi.mocked(accountById).mockResolvedValue({ ...ACCOUNT, enabled: false } as never);
    const res = await telegram_send.handler({ chat_id: CHAT, text: 'hi' }, ctx);
    expect(errorOf(res)).toMatch(/no enabled telegram bot/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends on the chat's own bot with threading and markdown options", async () => {
    const res = await telegram_send.handler(
      { chat_id: CHAT, text: 'hello', reply_to: '7', markdown: true },
      ctx,
    );
    expect(accountById).toHaveBeenCalledWith('acct-2');
    expect(sendMessage).toHaveBeenCalledWith(ACCOUNT, CHAT, 'hello', {
      replyTo: '7',
      markdown: true,
    });
    expect(outputOf(res)).toEqual({ messageIds: [42] });
  });

  it('defaults to plain text with no threading', async () => {
    await telegram_send.handler({ chat_id: CHAT, text: 'hello' }, ctx);
    const opts = vi.mocked(sendMessage).mock.calls[0]![3] as {
      replyTo?: string;
      markdown?: boolean;
    };
    // MarkdownV2 rejects unescaped punctuation, so an accidental markdown
    // default would turn ordinary prose into a transport error.
    expect(opts.markdown).toBeFalsy();
    expect(opts.replyTo).toBeUndefined();
  });

  it('surfaces a transport failure as a tool error, not a throw', async () => {
    vi.mocked(sendMessage).mockRejectedValue(new Error('429 Too Many Requests'));
    const res = await telegram_send.handler({ chat_id: CHAT, text: 'hello' }, ctx);
    expect(errorOf(res)).toMatch(/429/);
  });
});
