import { afterEach, describe, expect, it, vi } from 'vitest';
import { sseResponse } from './sse';
import {
  MEMBER_STREAMS_PER_LOGIN,
  MEMBER_STREAM_MAX_MS,
  memberStreamLifetimeMs,
  takeMemberStream,
} from './member-streams';

/** Read what the stream has sent so far, until it ends or `ms` pass. */
async function drain(res: Response, ms: number): Promise<{ text: string; ended: boolean }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) {
      void reader.cancel();
      return { text, ended: false };
    }
    const next = await Promise.race([
      reader.read(),
      new Promise<'wait'>((r) => setTimeout(() => r('wait'), left)),
    ]);
    if (next === 'wait') {
      void reader.cancel();
      return { text, ended: false };
    }
    if (next.done) return { text, ended: true };
    text += dec.decode(next.value);
  }
}

describe('sseResponse (audit M1, S8)', () => {
  afterEach(() => vi.useRealTimers());

  it('sends events, and a failed ping check closes the stream and cleans up once', async () => {
    const off = vi.fn();
    const onClose = vi.fn();
    let checks = 0;
    const res = sseResponse(new Request('http://x/'), {
      subscribe: async (send) => {
        send({ type: 'space_item', id: 'a' });
        return off;
      },
      onPing: () => ++checks < 2,
      heartbeatMs: 20,
      onClose,
    });
    const { text, ended } = await drain(res, 1_000);
    expect(text).toContain(': connected');
    expect(text).toContain('data: {"type":"space_item","id":"a"}');
    expect(text).toContain(': ping');
    expect(ended).toBe(true);
    expect(off).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes after its maximum lifetime', async () => {
    const onClose = vi.fn();
    const res = sseResponse(new Request('http://x/'), {
      subscribe: async () => () => {},
      maxLifetimeMs: 50,
      heartbeatMs: 10_000,
      onClose,
    });
    const { ended } = await drain(res, 1_000);
    expect(ended).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('member stream limits (audit S8)', () => {
  it('caps the open streams per login and frees a slot on release', () => {
    const releases = Array.from({ length: MEMBER_STREAMS_PER_LOGIN }, () =>
      takeMemberStream('login-a'),
    );
    expect(releases.every(Boolean)).toBe(true);
    expect(takeMemberStream('login-a')).toBeNull();
    expect(takeMemberStream('login-b')).not.toBeNull();
    releases[0]!();
    releases[0]!(); // idempotent: frees one slot, not two
    const again = takeMemberStream('login-a');
    expect(again).not.toBeNull();
    expect(takeMemberStream('login-a')).toBeNull();
  });

  it('lives an hour at most, or until the session expires', () => {
    const now = 1_000_000;
    expect(memberStreamLifetimeMs(null, now)).toBe(MEMBER_STREAM_MAX_MS);
    expect(memberStreamLifetimeMs(now + 10 * 60_000, now)).toBe(10 * 60_000);
    expect(memberStreamLifetimeMs(now + 5 * MEMBER_STREAM_MAX_MS, now)).toBe(MEMBER_STREAM_MAX_MS);
  });
});
