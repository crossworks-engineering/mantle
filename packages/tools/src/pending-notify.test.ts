/**
 * Where a queued call's Telegram card goes (pending-notify.ts): the chat of
 * the login it was queued for, except an elevated call (A5 step 6d fix
 * round 1), whose asker may not approve it: the owner's. The card carries
 * the elevated reason and the client-sourced note. The database, the
 * Telegram client and the preferences are stood in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  row: null as null | { loginId: string | null; elevated: unknown },
  asked: [] as string[],
  cards: [] as Array<Record<string, unknown>>,
}));

vi.mock('drizzle-orm', () => {
  const tag = () => ({});
  return { and: tag, eq: tag, desc: tag, sql: tag };
});
vi.mock('@mantle/db', () => {
  const chain = (rows: () => unknown[]) => {
    const self: Record<string, unknown> = {
      from: () => self,
      where: () => self,
      orderBy: () => self,
      limit: () => Promise.resolve(rows()),
    };
    return self;
  };
  return {
    // The card's route by its definer (mantle_pending_card_route): the
    // deciding login (an elevated call's: the owner) and its chat, asked for
    // that login (the settings area, in SQL).
    db: {
      execute: async () => {
        if (!h.row) return [];
        const who = h.row.elevated ? 'owner-1' : (h.row.loginId ?? 'owner-1');
        h.asked.push(who);
        return [{ loginId: who, accountId: 'acct', telegramChatId: 'chat-of-the-login' }];
      },
      select: (fields: Record<string, unknown>) =>
        chain(() =>
          'telegramChatId' in fields
            ? [{ accountId: 'acct', telegramChatId: 'chat-of-the-login' }]
            : h.row
              ? [h.row]
              : [],
        ),
    },
    asSystem: (fn: () => Promise<unknown>) => fn(),
    systemWork: (fn: () => Promise<unknown>) => fn(),
    executeWrite: async () => {},
    loginHasArea: async (login: string) => {
      h.asked.push(login);
      return true;
    },
    pendingToolCalls: { loginId: 'login_id', elevated: 'elevated' },
    telegramChats: {},
  };
});
vi.mock('@mantle/telegram', () => ({
  accountById: async () => ({ id: 'acct' }),
  sendApprovalCard: async (_a: unknown, _c: string, card: Record<string, unknown>) => {
    h.cards.push(card);
    return 1;
  },
}));
vi.mock('@mantle/content', () => ({
  loadProfilePreferences: async () => ({ reminderChannel: 'telegram' }),
  appUrl: (path: string) => `https://brain.example.invalid${path}`,
}));
vi.mock('@mantle/runs', () => ({ registerPendingCreatedNotifier: () => {} }));

const { notifyPendingCreated } = await import('./pending-notify');

const OWNER = 'owner-1';

beforeEach(() => {
  h.asked = [];
  h.cards = [];
});

describe('the approval card (A5 step 6d fix round 1)', () => {
  it("an ordinary call's card goes to the login it was queued for", async () => {
    h.row = { loginId: 'asker', elevated: null };
    await notifyPendingCreated({ ownerId: OWNER, pendingId: 'p1', toolSlug: 't', args: {} });
    expect(h.asked).toEqual(['asker']);
  });

  it('a card that shows four keys names the rest', async () => {
    h.row = { loginId: 'asker', elevated: null };
    await notifyPendingCreated({
      ownerId: OWNER,
      pendingId: 'p3',
      toolSlug: 'api_tool_update',
      args: {
        slug: 's',
        name: 'n',
        description: 'd',
        url: 'u',
        enabled: true,
        external_access: true,
      },
    });
    expect(String(h.cards[0]!.argsPreview).split('\n').at(-1)).toBe(
      '+2 more: enabled, external_access',
    );
  });

  describe('a tap approves only what the card showed whole', () => {
    const previewOf = async (args: Record<string, unknown>) => {
      h.row = { loginId: 'asker', elevated: null };
      await notifyPendingCreated({ ownerId: OWNER, pendingId: 'p4', toolSlug: 't', args });
      return h.cards[0]!;
    };

    it.each<[string, Record<string, unknown>]>([
      ['no args', {}],
      ['a grant', { agent_slug: 'team-assistant', group_slug: 'geo-tools' }],
      ['short values of each kind', { a: 's', b: 1, c: true, d: null }],
      ['a value of 200 characters', { a: 'x'.repeat(200) }],
      ['a line of exactly 600 characters', { a: 'x'.repeat(598) }],
      ['an emoji with no selector', { name: 'launch \u{1F600}' }],
    ])('%s keeps Approve', async (_what, args) => {
      expect((await previewOf(args)).previewWhole).toBe(true);
    });

    it.each<[string, Record<string, unknown>]>([
      ['a value over the cap', { body: 'x'.repeat(601) }],
      ['a line one over the cap', { a: 'x'.repeat(599) }],
      ['a newline in a value', { body: 'first\nsecond' }],
      ['a bidi override in a value', { url: 'https://a.example.invalid/\u202Eb' }],
      ['a zero-width character in a value', { group_slug: 'geo\u200B-tools' }],
      ['a line separator in a value', { name: 'a\u2028b' }],
      ['a paragraph separator in a value', { name: 'a\u2029b' }],
      ['a variation selector in a value', { name: 'a\ufe0fb' }],
      ['a supplementary variation selector in a value', { name: 'a\u{E0100}b' }],
      ['a blank letter in a value', { name: 'a\u3164b' }],
      ['a combining grapheme joiner in a value', { name: 'a\u034fb' }],
      ['an emoji with a selector, the accepted cost', { name: '\u2764\ufe0f' }],
      ['a control character in a key', { 'a\nb': 'v' }],
      ['a count of tool names', { slug: 'g', tool_slugs: ['a', 'b'] }],
      ['an object', { slug: 's', headers: { a: 'b' } }],
      ['a +N more line', { a: 1, b: 2, c: 3, d: 4, e: 5 }],
      ['a hidden value', { secret_ref: 'svc/label' }],
      [
        'a line cut at its cap',
        Object.fromEntries(['k'.repeat(300), 'j'.repeat(300), 'i'].map((k) => [k, 'v'])),
      ],
    ])('%s has no Approve', async (_what, args) => {
      const card = await previewOf(args);
      expect(card.previewWhole).toBe(false);
      expect(card.pendingUrl).toBe('https://brain.example.invalid/pending');
    });
  });

  it('a character a card does not show as it is never reaches the card', async () => {
    h.row = { loginId: 'asker', elevated: null };
    await notifyPendingCreated({
      ownerId: OWNER,
      pendingId: 'p5',
      toolSlug: 't',
      args: { body: 'first\nsecond\u202E', 'k\ney': 'v' },
    });
    expect(String(h.cards[0]!.argsPreview).split('\n')).toEqual([
      'body=first\uFFFDsecond\uFFFD',
      'k\uFFFDey=v',
    ]);
  });

  it('a character with no glyph of its own shows as the replacement too', async () => {
    h.row = { loginId: 'asker', elevated: null };
    await notifyPendingCreated({
      ownerId: OWNER,
      pendingId: 'p9',
      toolSlug: 't',
      args: { a: 'x\uFE0Fy', b: 'x\u{E0100}y', c: 'x\u3164y', d: 'x\u034Fy' },
    });
    expect(String(h.cards[0]!.argsPreview).split('\n')).toEqual([
      'a=x\uFFFDy',
      'b=x\uFFFDy',
      'c=x\uFFFDy',
      'd=x\uFFFDy',
    ]);
  });

  it('a preview stays at its cap, well under the 4096 of a Telegram message', async () => {
    h.row = { loginId: 'asker', elevated: null };
    await notifyPendingCreated({
      ownerId: OWNER,
      pendingId: 'p6',
      toolSlug: 't',
      args: { a: 'x'.repeat(5000), b: 'y'.repeat(5000), [`k${'z'.repeat(5000)}`]: 1 },
    });
    expect(String(h.cards[0]!.argsPreview).length).toBeLessThanOrEqual(600);
    expect(h.cards[0]!.previewWhole).toBe(false);
  });

  it('a cut at the cap keeps a whole code point, never half an emoji', async () => {
    h.row = { loginId: 'asker', elevated: null };
    // 'a=' and 594 x's reach unit 596: the cut at 597 falls inside the emoji.
    const before = `a=${'x'.repeat(594)}`;
    await notifyPendingCreated({
      ownerId: OWNER,
      pendingId: 'p8',
      toolSlug: 't',
      args: { a: `${'x'.repeat(594)}\u{1F600}${'y'.repeat(50)}` },
    });
    expect(h.cards[0]!.argsPreview).toBe(`${before}…`);
    expect(h.cards[0]!.previewWhole).toBe(false);
  });

  describe("a run's budget pause", () => {
    const pause = (title: string) =>
      notifyPendingCreated({
        ownerId: OWNER,
        pendingId: 'p7',
        toolSlug: 'run_budget',
        args: {
          question: `A run has spent $6.10 of its $5.00 budget and is PAUSED. Approve to raise the budget by another $5.00 and resume; reject to cancel the run. Run: "${title}"`,
          run_id: '00000000-0000-4000-8000-000000000001',
          budget_micro_usd: 5_000_000,
          spent_micro_usd: 6_100_000,
        },
      });

    it('keeps its tap, with its title and figures on the card', async () => {
      h.row = { loginId: null, elevated: null };
      await pause('Monthly report');
      const card = h.cards[0]!;
      expect(card.previewWhole).toBe(true);
      expect(card.argsPreview).toContain('$6.10 of its $5.00');
      expect(card.argsPreview).toContain('Monthly report');
    });

    it('a long title loses the tap and keeps the figures', async () => {
      h.row = { loginId: null, elevated: null };
      await pause('t'.repeat(2000));
      const card = h.cards[0]!;
      expect(card.previewWhole).toBe(false);
      expect(card.argsPreview).toContain('$6.10 of its $5.00');
    });
  });

  it("an elevated call's card goes to the owner, never its asker, and says why", async () => {
    h.row = { loginId: 'asker', elevated: { elevated: true, reason: 'why' } };
    await notifyPendingCreated({
      ownerId: OWNER,
      pendingId: 'p2',
      toolSlug: 't',
      args: {},
      elevated: { elevated: true, reason: 'why' },
      clientSourced: { via: 'task_get' },
    });
    expect(h.asked).toEqual([OWNER]);
    expect(h.cards[0]).toMatchObject({ elevated: 'why', clientSourced: 'task_get' });
  });
});
