/**
 * Behavioural tests for the owner's Telegram operator tools: telegram_pair,
 * telegram_edit, telegram_react, telegram_mark_processed. The send tool has
 * its own file; these four had nothing.
 *
 * `telegram_pair` is the one that matters most. It moves the allowlist, the
 * trust boundary that decides who may talk to the brain at all, so the test
 * pins EXACTLY what it writes: status flips to allowed, the pairing code and
 * its expiry are cleared (a code must not be reusable), the reply counter
 * resets. It also pins the guards that keep a stale or foreign code from
 * pairing anything: the lookup is scoped to the caller's owner id, an
 * expired code refuses, an already-allowed chat is a no-op. The confirmation
 * DM is best-effort and must never undo a pairing that already landed.
 *
 * `edit` and `react` are outward-facing like send: every guard must hold
 * before the transport is touched. `mark_processed` is a single UPDATE whose
 * only interesting property is that a miss is reported, not swallowed.
 *
 * The transport (@mantle/telegram) is stubbed; the db chains are stubbed at
 * select/update with a queue of select results consumed in call order.
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
    __update: update,
  };
});
vi.mock('@mantle/telegram', () => ({
  accountForChat: vi.fn(),
  sendMessage: vi.fn(),
  editMessage: vi.fn(),
  reactToMessage: vi.fn(),
}));

import * as dbmod from '@mantle/db';
import { accountForChat, editMessage, reactToMessage, sendMessage } from '@mantle/telegram';
import { TELEGRAM_OPERATOR_TOOLS } from './builtins-telegram';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const update = (dbmod as unknown as { __update: { set: ReturnType<typeof vi.fn> } }).__update;

const pair = TELEGRAM_OPERATOR_TOOLS.find((t) => t.slug === 'telegram_pair')!;
const edit = TELEGRAM_OPERATOR_TOOLS.find((t) => t.slug === 'telegram_edit')!;
const react = TELEGRAM_OPERATOR_TOOLS.find((t) => t.slug === 'telegram_react')!;
const markProcessed = TELEGRAM_OPERATOR_TOOLS.find((t) => t.slug === 'telegram_mark_processed')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const ACCOUNT = { id: 'acct-1', token: 'secret', channelId: null };
const CHAT = '12345';
const CODE = 'a1b2c3';

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

/** A chat row mid-pairing: code issued, not yet allowed, not yet expired. */
function pendingChat(extra: Record<string, unknown> = {}) {
  return {
    id: 'chat-row-1',
    accountId: 'acct-1',
    userId: 'o1',
    telegramChatId: CHAT,
    title: 'Alex',
    username: null,
    allowlistStatus: 'pending',
    pairingCode: CODE,
    pairingExpiresAt: new Date(Date.now() + 60_000),
    pairingReplies: 2,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  whereArgs.length = 0;
  updateReturn = [];
  vi.mocked(accountForChat).mockResolvedValue(ACCOUNT as never);
  vi.mocked(sendMessage).mockResolvedValue([1] as never);
  vi.mocked(editMessage).mockResolvedValue(undefined as never);
  vi.mocked(reactToMessage).mockResolvedValue(undefined as never);
});

describe('operator surface', () => {
  it('is MCP-only: none of these can ever be granted to an agent', () => {
    for (const t of [pair, edit, react, markProcessed]) {
      expect(t.mcpOnly, `${t.slug} must be mcpOnly`).toBe(true);
    }
  });
});

describe('telegram_pair', () => {
  it('rejects a malformed code without a lookup', async () => {
    expect(errorOf(await pair.handler({ code: 'xyz' }, ctx))).toMatch(/six hex digits/);
    expect(errorOf(await pair.handler({ code: 'a1b2c3d' }, ctx))).toMatch(/six hex digits/);
    expect(dbmod.db.select).not.toHaveBeenCalled();
  });

  it("looks the code up under the CALLER's owner id and writes nothing on a miss", async () => {
    selectQueue.push([]);
    const res = await pair.handler({ code: CODE }, ctx);
    expect(errorOf(res)).toMatch(/no pending pairing/);
    // Another owner's pending code must not be approvable from here.
    expect(paramsOf(whereArgs[0])).toEqual([CODE, 'o1']);
    expect(dbmod.db.update).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('treats an already-allowed chat as done, writing nothing', async () => {
    selectQueue.push([pendingChat({ allowlistStatus: 'allowed' })]);
    expect(outputOf(await pair.handler({ code: CODE }, ctx))).toBe('already paired');
    expect(dbmod.db.update).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('refuses an expired code without touching the allowlist', async () => {
    selectQueue.push([pendingChat({ pairingExpiresAt: new Date(Date.now() - 1) })]);
    const res = await pair.handler({ code: CODE }, ctx);
    expect(errorOf(res)).toMatch(/code expired/);
    expect(dbmod.db.update).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('allowlists the chat and burns the code in ONE write, then confirms by DM', async () => {
    selectQueue.push([pendingChat()], [ACCOUNT]);
    const res = await pair.handler({ code: CODE.toUpperCase() }, ctx);
    // Exactly this shape: status flips, the code and its expiry go (a code
    // must not pair twice), the reply counter resets for any future re-pair.
    expect(update.set).toHaveBeenCalledTimes(1);
    expect(update.set).toHaveBeenCalledWith({
      allowlistStatus: 'allowed',
      pairingCode: null,
      pairingExpiresAt: null,
      pairingReplies: 0,
      updatedAt: expect.any(Date),
    });
    // ...against the resolved row, not the code (whereArgs: chat lookup,
    // then the update, then the account lookup).
    expect(paramsOf(whereArgs[1])).toEqual(['chat-row-1']);
    expect(sendMessage).toHaveBeenCalledWith(ACCOUNT, CHAT, 'Paired! Say hi to your assistant.');
    expect(outputOf(res)).toBe(`paired chat ${CHAT} (Alex)`);
  });

  it('names the agent bound to the bot in the confirmation', async () => {
    selectQueue.push([pendingChat()], [{ ...ACCOUNT, channelId: 'ch-1' }], [{ name: 'Rea' }]);
    await pair.handler({ code: CODE }, ctx);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'acct-1' }),
      CHAT,
      'Paired! Say hi to Rea.',
    );
  });

  it('keeps the pairing when the confirmation DM fails', async () => {
    selectQueue.push([pendingChat()], [ACCOUNT]);
    vi.mocked(sendMessage).mockRejectedValue(new Error('403 blocked'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await pair.handler({ code: CODE }, ctx);
      // The allowlist change already landed; a failed courtesy DM must not
      // read as "not paired" and invite a retry that finds no code.
      expect(outputOf(res)).toMatch(/^paired chat/);
      expect(update.set).toHaveBeenCalledTimes(1);
    } finally {
      quiet.mockRestore();
    }
  });

  it('still pairs when the bot account row is gone, just without a DM', async () => {
    selectQueue.push([pendingChat()], []);
    const res = await pair.handler({ code: CODE }, ctx);
    expect(outputOf(res)).toMatch(/^paired chat/);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('telegram_edit', () => {
  it('requires chat_id, message_id and text, touching nothing without them', async () => {
    expect(errorOf(await edit.handler({ chat_id: CHAT, message_id: '7' }, ctx))).toMatch(
      /chat_id \+ message_id \+ text required/,
    );
    expect(errorOf(await edit.handler({ chat_id: CHAT, text: 'x' }, ctx))).toMatch(/required/);
    expect(accountForChat).not.toHaveBeenCalled();
    expect(editMessage).not.toHaveBeenCalled();
  });

  it('refuses when no enabled account owns the chat, before the wire', async () => {
    selectQueue.push([{ status: 'allowed' }]); // the owner+allowlist gate
    vi.mocked(accountForChat).mockResolvedValue(null as never);
    const res = await edit.handler({ chat_id: CHAT, message_id: '7', text: 'x' }, ctx);
    expect(errorOf(res)).toMatch(/no enabled telegram account/);
    expect(editMessage).not.toHaveBeenCalled();
  });

  it('edits through the resolved account with the markdown flag', async () => {
    selectQueue.push([{ status: 'allowed' }]); // the owner+allowlist gate
    const res = await edit.handler(
      { chat_id: CHAT, message_id: '7', text: 'done', markdown: true },
      ctx,
    );
    expect(editMessage).toHaveBeenCalledWith(ACCOUNT, CHAT, '7', 'done', { markdown: true });
    expect(outputOf(res)).toBe('edited');
  });

  it('surfaces a transport failure as a tool error, not a throw', async () => {
    selectQueue.push([{ status: 'allowed' }]); // the owner+allowlist gate
    vi.mocked(editMessage).mockRejectedValue(new Error('message is not modified'));
    const res = await edit.handler({ chat_id: CHAT, message_id: '7', text: 'x' }, ctx);
    expect(errorOf(res)).toMatch(/edit failed: message is not modified/);
  });
});

describe('telegram_react', () => {
  it('requires all three fields, touching nothing without them', async () => {
    expect(errorOf(await react.handler({ chat_id: CHAT, message_id: '7' }, ctx))).toMatch(
      /chat_id \+ message_id \+ emoji required/,
    );
    expect(accountForChat).not.toHaveBeenCalled();
    expect(reactToMessage).not.toHaveBeenCalled();
  });

  it('refuses when no enabled account owns the chat, before the wire', async () => {
    selectQueue.push([{ status: 'allowed' }]); // the owner+allowlist gate
    vi.mocked(accountForChat).mockResolvedValue(null as never);
    const res = await react.handler({ chat_id: CHAT, message_id: '7', emoji: '👍' }, ctx);
    expect(errorOf(res)).toMatch(/no enabled telegram account/);
    expect(reactToMessage).not.toHaveBeenCalled();
  });

  it('reacts through the resolved account', async () => {
    selectQueue.push([{ status: 'allowed' }]); // the owner+allowlist gate
    const res = await react.handler({ chat_id: CHAT, message_id: '7', emoji: '👍' }, ctx);
    expect(reactToMessage).toHaveBeenCalledWith(ACCOUNT, CHAT, '7', '👍');
    expect(outputOf(res)).toBe('reacted');
  });

  it('surfaces a rejected emoji as a tool error', async () => {
    selectQueue.push([{ status: 'allowed' }]); // the owner+allowlist gate
    vi.mocked(reactToMessage).mockRejectedValue(new Error('REACTION_INVALID'));
    const res = await react.handler({ chat_id: CHAT, message_id: '7', emoji: '🦆' }, ctx);
    expect(errorOf(res)).toMatch(/react failed: REACTION_INVALID/);
  });
});

describe('telegram_mark_processed', () => {
  it('requires an id and writes nothing without one', async () => {
    expect(errorOf(await markProcessed.handler({}, ctx))).toMatch(/id required/);
    expect(dbmod.db.update).not.toHaveBeenCalled();
  });

  it('reports a miss rather than a silent success', async () => {
    selectQueue.push([{ id: 'm1' }]); // the owner-scoped message lookup
    updateReturn = [];
    expect(errorOf(await markProcessed.handler({ id: 'm-ghost' }, ctx))).toMatch(/no such message/);
  });

  it('flips processed with a timestamp on the named row', async () => {
    selectQueue.push([{ id: 'm1' }]); // the owner-scoped message lookup
    updateReturn = [{ id: 'm1' }];
    const res = await markProcessed.handler({ id: 'm1' }, ctx);
    expect(update.set).toHaveBeenCalledWith({ processed: true, processedAt: expect.any(Date) });
    expect(outputOf(res)).toBe('marked processed');
  });
});
