/**
 * The Telegram allowlist is the boundary, in BOTH directions, and it is a
 * per-owner boundary.
 *
 * `telegram_send` enforces it properly: it looks the chat up with
 * `eq(telegramChats.userId, ctx.ownerId)` and refuses unless the row says
 * `allowed`. `telegram_react` and `telegram_edit` reach the same Telegram API
 * with the same account and did neither — they called `accountForChat(chatId)`
 * and went straight to the wire.
 *
 * `accountForChat` looks like it scopes and does not: its parameter is named
 * `_chatId` and it returns the first enabled account on the box. So those two
 * tools would act on ANY chat id handed to them, including one that is pending
 * or blocked, and (where a box has more than one owner) somebody else's chat.
 *
 * `telegram_mark_processed` had the read-side version of the same hole: it
 * updated telegram_messages by id with no owner clause, so it could silence an
 * inbound message on another owner's assistant — the message is simply never
 * answered, and nothing errors.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  whereArgs: [] as unknown[],
  updateWhere: [] as unknown[],
  reacted: [] as unknown[],
  edited: [] as unknown[],
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const chain: Record<string, unknown> = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn(function (this: unknown, a: unknown) {
      h.whereArgs.push(a);
      return this;
    }),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: (r: (v: unknown) => void, j?: (e: unknown) => void) =>
      Promise.resolve(h.selectQueue.shift() ?? []).then(r, j),
  };
  const upd = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn(function (this: unknown, a: unknown) {
      h.updateWhere.push(a);
      return this;
    }),
    returning: vi.fn(async () => [{ id: 'm1' }]),
  };
  return {
    ...actual,
    db: { ...actual.db, select: vi.fn(() => chain), update: vi.fn(() => upd) },
  };
});

vi.mock('@mantle/telegram', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  accountForChat: vi.fn(async () => ({ id: 'acc-1', botToken: 't', enabled: true })),
  reactToMessage: vi.fn(async (...a: unknown[]) => void h.reacted.push(a)),
  editMessage: vi.fn(async (...a: unknown[]) => void h.edited.push(a)),
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
}));

import { paramsOf } from './test-support';
import { TELEGRAM_TOOLS, TELEGRAM_OPERATOR_TOOLS } from './builtins-telegram';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const OWNER = 'owner-1';
const ctx: ToolHandlerContext = { ownerId: OWNER };
const all = [...TELEGRAM_TOOLS, ...TELEGRAM_OPERATOR_TOOLS];
const tool = (slug: string): BuiltinToolDef => {
  const d = all.find((t) => t.slug === slug);
  if (!d) throw new Error(`${slug} is not a telegram tool any more`);
  return d;
};
const scoped = () => h.whereArgs.some((w) => paramsOf(w).includes(OWNER));

beforeEach(() => {
  h.selectQueue.length = 0;
  h.whereArgs.length = 0;
  h.updateWhere.length = 0;
  h.reacted.length = 0;
  h.edited.length = 0;
});

describe.each([
  ['telegram_react', { chat_id: '123', message_id: '9', emoji: '👍' }, () => h.reacted],
  ['telegram_edit', { chat_id: '123', message_id: '9', text: 'x' }, () => h.edited],
])('%s', (slug, input, sent) => {
  it('checks the chat belongs to the caller before touching the wire', async () => {
    h.selectQueue.push([{ status: 'allowed' }]);
    await tool(slug).handler(input, ctx);
    expect(h.whereArgs.length, 'no chat lookup at all').toBeGreaterThan(0);
    expect(scoped(), 'chat lookup not scoped to the owner').toBe(true);
  });

  it('REFUSES a chat that is not on the allowlist, and sends nothing', async () => {
    h.selectQueue.push([{ status: 'pending' }]);
    const res = await tool(slug).handler(input, ctx);
    expect(res.ok).toBe(false);
    expect(sent(), 'reached Telegram despite the allowlist').toEqual([]);
  });

  it('REFUSES a chat the caller does not own, and sends nothing', async () => {
    h.selectQueue.push([]); // owner-scoped lookup returns nothing
    const res = await tool(slug).handler(input, ctx);
    expect(res.ok).toBe(false);
    expect(sent()).toEqual([]);
  });
});

describe('telegram_mark_processed', () => {
  it('scopes the message to the caller before marking it', async () => {
    h.selectQueue.push([{ id: 'm1' }]);
    await tool('telegram_mark_processed').handler({ id: 'm1' }, ctx);
    const anywhere = [...h.whereArgs, ...h.updateWhere];
    expect(
      anywhere.some((w) => paramsOf(w).includes(OWNER)),
      'unscoped update',
    ).toBe(true);
  });

  it('refuses a message the caller does not own', async () => {
    h.selectQueue.push([]);
    const res = await tool('telegram_mark_processed').handler({ id: 'other' }, ctx);
    expect(res.ok).toBe(false);
  });
});
