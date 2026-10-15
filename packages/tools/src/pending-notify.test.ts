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
    db: {
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
