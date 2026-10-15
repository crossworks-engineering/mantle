/**
 * The Telegram poller's wait after a failed poll (A10 #10 fix round 2): std
 * backoffMs since round 1, the same delays as main's hand loop. It doubles
 * from 1 s, caps at 60 s, and a poll that goes through resets it to 1 s
 * (main: `min(backoff * 2, 60 s)`, reset to the base on success).
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  start: null as null | (() => Promise<() => Promise<void>>),
  sleeps: [] as number[],
  /** Each poll's outcome, in order; past the end a poll never settles. */
  script: [] as Array<'fail' | 'ok'>,
  done: null as null | (() => void),
}));

vi.mock('./_runner', () => ({
  runWorker: (_name: string, start: () => Promise<() => Promise<void>>) => {
    h.start = start;
  },
}));
vi.mock('@mantle/config', () => ({ env: () => 'set' }));
vi.mock('../lib/telegram-approval', () => ({ telegramApprovalHandlers: {} }));
vi.mock('@mantle/content', () => ({ registerRecallEmbedder: () => {} }));
vi.mock('@mantle/embeddings', () => ({ embedBatch: async () => [] }));
vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));
vi.mock('@mantle/db', () => {
  const channels = { __t: 'channels' };
  const telegramAccounts = { __t: 'accounts' };
  const channel = { id: 'ch-1', type: 'telegram', displayName: 'Test bot', enabled: true };
  const account = { id: 'acc-1', channelId: 'ch-1' };
  return {
    channels,
    telegramAccounts,
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const rows = table === channels ? [channel] : [account];
            return Object.assign(Promise.resolve(rows), { limit: async () => rows });
          },
        }),
      }),
    },
  };
});
vi.mock('@mantle/telegram', () => ({
  evictBot: () => {},
  pollOnce: async () => {
    const next = h.script.shift();
    if (next === 'fail') throw new Error('getUpdates failed');
    if (next === 'ok') return { delivered: 0, updatesReceived: 0 };
    h.done?.();
    return new Promise(() => {});
  },
}));
vi.mock('@mantle/std', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sleep: async (ms: number) => {
    h.sleeps.push(ms);
  },
}));

describe('telegram poller backoff (same delays as main)', () => {
  it('doubles from 1 s, caps at 60 s, and resets after a poll that goes through', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    h.script = [
      ...Array<'fail'>(8).fill('fail'),
      'ok',
      'fail',
      'fail',
      'ok',
      'ok',
      'fail',
    ];
    const finished = new Promise<void>((resolve) => {
      h.done = resolve;
    });
    await import('./telegram-poll');
    const stop = await h.start!();
    await finished;
    await stop();
    err.mockRestore();
    log.mockRestore();

    // main: wait = backoff; backoff = min(backoff * 2, 60_000); success -> 1_000.
    const main: number[] = [];
    let backoff = 1_000;
    for (const step of [...Array(8).fill('fail'), 'ok', 'fail', 'fail', 'ok', 'ok', 'fail']) {
      if (step === 'ok') {
        backoff = 1_000;
        continue;
      }
      main.push(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
    expect(h.sleeps).toEqual(main);
    expect(h.sleeps).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 1_000, 2_000, 1_000,
    ]);
  });
});
