/**
 * Behavioural tests for telegram_send — the one Telegram tool an agent can
 * hold. It is outward-facing (a message leaves the brain), so the shape that
 * matters is the email_send one: every guard must hold BEFORE anything reaches
 * the transport. A test that only checks the error string would pass for a
 * tool that sent the message and then complained.
 *
 * Two gates sit in front of the wire, in order: an enabled account must own
 * the chat, and the chat must be on THIS owner's allowlist. The account lookup
 * is `accountForChat` from @mantle/telegram; the allowlist is a
 * `db.select().from(telegramChats).where().limit()` chain. Both are stubbed;
 * the tool's ordering and guards are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const chatRows: Array<{ status: string }> = [];
/** Every where clause the allowlist select is handed, in call order. Recorded
 *  rather than waved through: a `mockReturnThis()` where accepts any clause, so
 *  dropping the owner-id term from the handler would leave this file green. */
const whereArgs: unknown[] = [];

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(function (this: unknown, clause: unknown) {
      whereArgs.push(clause);
      return this;
    }),
    limit: vi.fn(async () => chatRows),
  };
  return { ...actual, db: { ...actual.db, select: vi.fn(() => chain) } };
});
vi.mock('@mantle/telegram', () => ({
  accountForChat: vi.fn(),
  sendMessage: vi.fn(),
  editMessage: vi.fn(),
  reactToMessage: vi.fn(),
}));

import { accountForChat, sendMessage } from '@mantle/telegram';
import { paramsOf } from './test-support';
import { telegram_send } from './builtins-telegram';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const ACCOUNT = { id: 'acct-1', token: 'secret' };
const CHAT = '12345';

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
  // clearAllMocks clears CALLS, not implementations — re-establish every
  // default so no test inherits a value set by the one before it.
  chatRows.splice(0, chatRows.length, { status: 'allowed' });
  whereArgs.length = 0;
  vi.mocked(accountForChat).mockResolvedValue(ACCOUNT as never);
  vi.mocked(sendMessage).mockResolvedValue([42] as never);
});

describe('telegram_send', () => {
  it('scopes the allowlist lookup to the caller', async () => {
    // Drop `eq(telegramChats.userId, ...)` and any owner's allowlisted chat
    // would satisfy the gate — the brain would message a stranger's contact.
    await telegram_send.handler({ chat_id: CHAT, text: 'hi' }, ctx);
    expect(paramsOf(whereArgs[0])).toEqual(expect.arrayContaining(['o1', CHAT]));
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
    expect(accountForChat).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('refuses when no enabled account owns the chat, before the wire', async () => {
    vi.mocked(accountForChat).mockResolvedValue(null as never);
    const res = await telegram_send.handler({ chat_id: CHAT, text: 'hi' }, ctx);
    expect(errorOf(res)).toMatch(/no enabled telegram account/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a chat that is not on the allowlist, before the wire', async () => {
    chatRows.splice(0, chatRows.length, { status: 'pending' });
    const res = await telegram_send.handler({ chat_id: CHAT, text: 'hi' }, ctx);
    // The allowlist is the trust boundary for who may talk to the brain at
    // all; an unlisted chat must never receive a message either.
    expect(errorOf(res)).toMatch(/not allowlisted/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('treats an unknown chat exactly like a blocked one', async () => {
    chatRows.splice(0, chatRows.length);
    const res = await telegram_send.handler({ chat_id: CHAT, text: 'hi' }, ctx);
    expect(errorOf(res)).toMatch(/not allowlisted/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends through the resolved account with threading and markdown options', async () => {
    const res = await telegram_send.handler(
      { chat_id: CHAT, text: 'hello', reply_to: '7', markdown: true },
      ctx,
    );
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
