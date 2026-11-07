/**
 * WP4's binding decision: **Telegram announces questions, it never answers
 * them.** A chat card can only say yes or no, but a run's question asks *what*
 * to do — often across several sub-questions whose options don't fit in a
 * message at all. A tapped "✅" would be recorded as the operator's answer and
 * the run would carry on having learned nothing.
 *
 * Its own file (not outbound.test.ts) because it needs the bot client mocked,
 * and that suite deliberately tests pure functions with no mocks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ chatId: string; text: string; opts?: Record<string, unknown> }> = [];
const edits: Array<{ text: string; opts?: Record<string, unknown> }> = [];

vi.mock('./client', () => ({
  botFor: async () => ({
    api: {
      sendMessage: async (chatId: string, text: string, opts?: Record<string, unknown>) => {
        sent.push({ chatId, text, opts });
        return { message_id: 42 };
      },
      editMessageText: async (
        _chatId: string,
        _messageId: number,
        text: string,
        opts?: Record<string, unknown>,
      ) => {
        edits.push({ text, opts });
      },
    },
  }),
}));

vi.mock('@mantle/db', () => ({
  db: {},
  telegramAccounts: { __table: 'telegram_accounts' },
}));

vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));

const { editMessage, sendApprovalCard } = await import('./outbound');

const ACCOUNT = { id: 'acct-1' } as never;
/** A preview that showed every value. */
const WHOLE = { previewWhole: true, pendingUrl: 'https://brain.example.invalid/pending' };

beforeEach(() => {
  sent.length = 0;
  edits.length = 0;
});

describe('editMessage: a card never keeps its buttons under new words', () => {
  it.each([
    ['plain', {}, undefined],
    ['markdown', { markdown: true }, 'MarkdownV2'],
  ])('%s: every edit clears the buttons', async (_name, options, parseMode) => {
    await editMessage(ACCOUNT, 'chat-1', '7', 'new words', options);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toBe('new words');
    expect(edits[0]!.opts?.reply_markup).toEqual({ inline_keyboard: [] });
    expect(edits[0]!.opts?.parse_mode).toBe(parseMode);
  });
});

describe('sendApprovalCard', () => {
  it('sends a runner QUESTION with no buttons at all', async () => {
    await sendApprovalCard(ACCOUNT, 'chat-1', {
      ...WHOLE,
      pendingId: 'row-1',
      toolSlug: 'ask_human',
      question: 'Which environment should the release go to?',
    });
    expect(sent).toHaveLength(1);
    const msg = sent[0]!;
    // The load-bearing assertion: nothing tappable, so nothing to mis-answer.
    expect(msg.opts?.reply_markup).toBeUndefined();
    expect(msg.text).toContain('Which environment should the release go to?');
    expect(msg.text).toMatch(/needs your answer/i);
    expect(msg.text).toMatch(/Mantle/); // says where to go
    expect(msg.text).not.toMatch(/Approve/);
  });

  it('still sends an ORDINARY tool approval as a two-button card', async () => {
    await sendApprovalCard(ACCOUNT, 'chat-1', {
      ...WHOLE,
      pendingId: 'row-2',
      toolSlug: 'email_send',
      argsPreview: 'to=someone@example.com',
    });
    const msg = sent[0]!;
    const keyboard = msg.opts?.reply_markup as { inline_keyboard?: unknown[][] } | undefined;
    expect(keyboard?.inline_keyboard?.[0]).toHaveLength(2);
    expect(msg.text).toContain('email_send');
    expect(msg.text).not.toMatch(/Pending screen/);
  });

  it('a card that cut or hid a value has no Approve: Reject, and the way to the Pending screen', async () => {
    await sendApprovalCard(ACCOUNT, 'chat-1', {
      pendingId: 'row-5',
      toolSlug: 'tool_group_ensure',
      argsPreview: 'slug=geo\ntool_slugs=[2]',
      previewWhole: false,
      pendingUrl: 'https://brain.example.invalid/pending',
    });
    const msg = sent[0]!;
    const keyboard = msg.opts?.reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    const buttons = keyboard.inline_keyboard.flat();
    expect(buttons.map((b) => b.callback_data)).toEqual(['mantle:reject:row-5']);
    expect(msg.text).toContain('https://brain.example.invalid/pending');
    expect(msg.text).toMatch(/approve on the Pending screen/);
  });

  it('says who must approve an elevated call, and warns when the turn read client text (A5 step 6d fix round 1)', async () => {
    await sendApprovalCard(ACCOUNT, 'chat-1', {
      ...WHOLE,
      pendingId: 'row-3',
      toolSlug: 'crm_update',
      elevated: 'An Admin user must approve it; the person asking cannot.',
      clientSourced: 'task_get',
    });
    const text = sent[0]!.text;
    expect(text).toContain('An Admin user must approve it; the person asking cannot.');
    expect(text).toContain('read text a client wrote (task_get)');
    expect(text).toContain('approve only if you asked for this yourself');
  });

  it('an ordinary card carries neither line', async () => {
    await sendApprovalCard(ACCOUNT, 'chat-1', {
      ...WHOLE,
      pendingId: 'row-4',
      toolSlug: 'note_create',
    });
    expect(sent[0]!.text).not.toMatch(/client wrote|Admin user/);
  });
});
