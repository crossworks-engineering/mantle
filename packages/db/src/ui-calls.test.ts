/**
 * Why an agent UI answer that changed nothing changed nothing (uiAnswerMiss,
 * ui-calls.ts): the answer's own WHERE is the rule; this only words the miss.
 * Another login's, another turn's or another window's call is `not_found`,
 * with no detail which; an answered one `answered`; anything else (expired,
 * given up by a Stop, pending past expires_at) `expired`. No database: the
 * UPDATE itself is ui-calls.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { uiAnswerMiss } from './ui-calls';

const ROW = {
  turnId: 'turn-1',
  loginId: '22222222-2222-4222-8222-222222222222',
  windowId: 'win_abcdefgh',
  status: 'pending' as const,
};
const ASK = { turnId: ROW.turnId, loginId: ROW.loginId, windowId: ROW.windowId };

describe('uiAnswerMiss', () => {
  it('no row, another login, another turn, another window: not_found', () => {
    expect(uiAnswerMiss(null, ASK)).toBe('not_found');
    expect(uiAnswerMiss(ROW, { ...ASK, loginId: '44444444-4444-4444-8444-444444444444' })).toBe(
      'not_found',
    );
    expect(uiAnswerMiss(ROW, { ...ASK, turnId: 'turn-2' })).toBe('not_found');
    expect(uiAnswerMiss(ROW, { ...ASK, windowId: 'win_other000' })).toBe('not_found');
    // A foreign row says not_found even when it is answered or expired.
    expect(uiAnswerMiss({ ...ROW, status: 'done' }, { ...ASK, windowId: 'win_other000' })).toBe(
      'not_found',
    );
  });

  it('a second answer is answered', () => {
    expect(uiAnswerMiss({ ...ROW, status: 'done' }, ASK)).toBe('answered');
  });

  it('expired, given up, or pending past expires_at (the UPDATE missed it): expired', () => {
    expect(uiAnswerMiss({ ...ROW, status: 'expired' }, ASK)).toBe('expired');
    expect(uiAnswerMiss(ROW, ASK)).toBe('expired');
  });
});
