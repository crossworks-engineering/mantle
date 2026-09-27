import { describe, expect, it } from 'vitest';
import type { MemberCaller } from '@/lib/auth';
import { MEMBER_BYTES_PER_MIN, MEMBER_THUMBS_PER_MIN, memberBytesGate } from './member-space';

/** Audit S1: the member bytes routes are rate limited per login, with a
 *  smaller budget for thumbnails (a thumbnail may decode an image). */
describe('memberBytesGate', () => {
  const member = (loginId: string) => ({ loginId }) as unknown as MemberCaller;
  const req = (thumb: boolean) =>
    new Request(`http://x/api/member/space/1/bytes${thumb ? '?thumb=1' : ''}`);

  it('answers 429 once a login spends its thumbnail budget', () => {
    const m = member('login-thumbs');
    for (let i = 0; i < MEMBER_THUMBS_PER_MIN; i++)
      expect(memberBytesGate(req(true), m)).toBeNull();
    const res = memberBytesGate(req(true), m);
    expect(res?.status).toBe(429);
    expect(res?.headers.get('retry-after')).toBeTruthy();
    // Plain downloads have their own budget, and another login is untouched.
    expect(memberBytesGate(req(false), m)).toBeNull();
    expect(memberBytesGate(req(true), member('login-other'))).toBeNull();
  });

  it('answers 429 once a login spends its download budget', () => {
    const m = member('login-bytes');
    for (let i = 0; i < MEMBER_BYTES_PER_MIN; i++)
      expect(memberBytesGate(req(false), m)).toBeNull();
    expect(memberBytesGate(req(false), m)?.status).toBe(429);
  });
});
