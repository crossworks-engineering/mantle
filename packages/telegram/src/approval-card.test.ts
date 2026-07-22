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

vi.mock('./client', () => ({
  botFor: async () => ({
    api: {
      sendMessage: async (chatId: string, text: string, opts?: Record<string, unknown>) => {
        sent.push({ chatId, text, opts });
        return { message_id: 42 };
      },
    },
  }),
}));

vi.mock('@mantle/db', () => ({
  db: {},
  telegramAccounts: { __table: 'telegram_accounts' },
}));

vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));

const { sendApprovalCard } = await import('./outbound');

const ACCOUNT = { id: 'acct-1' } as never;

beforeEach(() => {
  sent.length = 0;
});

describe('sendApprovalCard', () => {
  it('sends a runner QUESTION with no buttons at all', async () => {
    await sendApprovalCard(ACCOUNT, 'chat-1', {
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
      pendingId: 'row-2',
      toolSlug: 'email_send',
      argsPreview: 'to=someone@example.com',
    });
    const msg = sent[0]!;
    const keyboard = msg.opts?.reply_markup as { inline_keyboard?: unknown[][] } | undefined;
    expect(keyboard?.inline_keyboard?.[0]).toHaveLength(2);
    expect(msg.text).toContain('email_send');
  });
});
