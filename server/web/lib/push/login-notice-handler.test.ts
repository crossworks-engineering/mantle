// The push worker's handler for `login_notice`: from a NOTIFY payload to a
// send. The sends are stood in here; the same path with the real sends and a
// real NOTIFY is in push-targeting.db.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./login-notify', () => ({
  pushChatReply: vi.fn(),
  pushComment: vi.fn(),
  pushReviewResult: vi.fn(),
}));

import {
  SCHEMA_REMINDER_MS,
  createLoginNoticeHandler,
  warnIfSchemaBehind,
} from './login-notice-handler';
import type { PushResult } from './notify';

const LOGIN = '22222222-2222-4222-8222-222222222222';
const OTHER = '12121212-1212-4212-8212-121212121212';
const id = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const OK: PushResult = { attempted: 1, delivered: 1, dropped: 0 };

function harness(gatherMs = 20) {
  const calls: string[] = [];
  const send = {
    chat: vi.fn(async (n: { id: string }) => {
      calls.push(`chat ${n.id}`);
      return OK;
    }),
    review: vi.fn(async (loginId: string, state: string, ids: readonly string[]) => {
      calls.push(`review ${loginId} ${state} ${[...ids].sort().join(',')}`);
      return OK;
    }),
  };
  const lines: string[] = [];
  const handler = createLoginNoticeHandler({ gatherMs, send, log: (l) => lines.push(l) });
  return { handler, send, calls, lines };
}
const chat = (n: number) => JSON.stringify({ kind: 'chat', loginId: LOGIN, id: id(n) });
const comment = (n: number) => JSON.stringify({ kind: 'comment', id: id(n) });
const review = (n: number, state = 'accepted', loginId = LOGIN) =>
  JSON.stringify({ kind: 'review', loginId, id: id(n), state });

describe('the login_notice handler', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errors.mockRestore();
  });

  it('sends chat replies in the order they came; a comment event is no longer one', async () => {
    const { handler, calls, lines } = harness();
    handler.handle(chat(1));
    // The node_comments trigger may still fire on an old brain's rows:
    // comments are gone (2026-10-09), so it sends nothing.
    handler.handle(comment(2));
    handler.handle(chat(3));
    await handler.idle();
    expect(calls).toEqual([`chat ${id(1)}`, `chat ${id(3)}`]);
    expect(lines).toHaveLength(2);
  });

  it('drops a payload that is not a notice, and keeps going', async () => {
    const { handler, calls } = harness();
    for (const bad of ['not json', '{}', JSON.stringify({ kind: 'chat', id: 'x' })]) {
      handler.handle(bad);
    }
    handler.handle(chat(1));
    await handler.idle();
    expect(calls).toEqual([`chat ${id(1)}`]);
  });

  it('gathers a bundle into one review push per author and result', async () => {
    const { handler, send, calls } = harness();
    // Accept of a bundle: three items in one transaction, three events.
    handler.handle(review(1));
    handler.handle(review(2));
    handler.handle(review(3));
    // Another result for the same author, and the same result for another.
    handler.handle(review(4, 'returned'));
    handler.handle(review(5, 'accepted', OTHER));
    await handler.idle();
    expect(send.review).toHaveBeenCalledTimes(3);
    expect(calls.sort()).toEqual(
      [
        `review ${LOGIN} accepted ${[id(1), id(2), id(3)].sort().join(',')}`,
        `review ${LOGIN} returned ${id(4)}`,
        `review ${OTHER} accepted ${id(5)}`,
      ].sort(),
    );
  });

  it('one failed send does not stop the next', async () => {
    const { handler, send, calls } = harness();
    send.chat.mockRejectedValueOnce(new Error('relay down'));
    handler.handle(chat(1));
    handler.handle(chat(2));
    await handler.idle();
    expect(calls).toEqual([`chat ${id(2)}`]);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('says LOUDLY, once, that the database is behind the code', async () => {
    const { handler, send } = harness();
    const missing = Object.assign(new Error('Failed query'), {
      cause: { code: '42703', message: 'column "token_id" does not exist' },
    });
    send.chat.mockRejectedValue(missing);
    handler.handle(chat(1));
    handler.handle(comment(2));
    handler.handle(chat(3));
    await handler.idle();
    const loud = errors.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('THE DATABASE IS BEHIND THE CODE'),
    );
    expect(loud).toHaveLength(1);
    expect(String(loud[0]![0])).toContain('NO push is being sent');
    // And nothing else was logged for the same cause.
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('after the loud line, says at a low rate that pushes are still not sent', () => {
    const missing = Object.assign(new Error('Failed query'), {
      cause: { code: '42P01', message: 'relation "push_login_prefs" does not exist' },
    });
    const t0 = Date.now();
    warnIfSchemaBehind(missing, t0); // the loud line, or a count if it was said
    errors.mockClear();
    // Within the interval: counted, not logged.
    for (let i = 1; i <= 5; i++) warnIfSchemaBehind(missing, t0 + i * 1000);
    expect(errors).not.toHaveBeenCalled();
    // Past it: one short line with the count, then quiet again.
    warnIfSchemaBehind(missing, t0 + SCHEMA_REMINDER_MS + 1);
    warnIfSchemaBehind(missing, t0 + SCHEMA_REMINDER_MS + 2);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]![0])).toMatch(
      /still behind the schema: \d+ push\(es\) not sent/,
    );
    // Not a schema error: not ours to count.
    expect(warnIfSchemaBehind(new Error('relay down'), t0)).toBe(false);
  });
});
