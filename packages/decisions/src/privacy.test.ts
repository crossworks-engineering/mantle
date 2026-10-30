import { describe, expect, it } from 'vitest';
import { deciderPrivacy } from './privacy';

describe('deciderPrivacy', () => {
  it('a box with no setting stays on zdr', () => {
    expect(deciderPrivacy(undefined)).toBe('zdr');
    expect(deciderPrivacy(null)).toBe('zdr');
    expect(deciderPrivacy({})).toBe('zdr');
  });

  it('reads the old zdr flag: true is zdr, false is no_training', () => {
    expect(deciderPrivacy({ zdr: true })).toBe('zdr');
    expect(deciderPrivacy({ zdr: false })).toBe('no_training');
  });

  it('reads the new value', () => {
    expect(deciderPrivacy({ privacy: 'zdr' })).toBe('zdr');
    expect(deciderPrivacy({ privacy: 'no_training' })).toBe('no_training');
  });

  it('when the two keys disagree, the stricter wins', () => {
    expect(deciderPrivacy({ privacy: 'no_training', zdr: true })).toBe('zdr');
    expect(deciderPrivacy({ privacy: 'zdr', zdr: false })).toBe('zdr');
    expect(deciderPrivacy({ privacy: 'no_training', zdr: false })).toBe('no_training');
  });

  it('a value that is neither fails closed to zdr', () => {
    expect(deciderPrivacy({ privacy: 'none' as never })).toBe('zdr');
    expect(deciderPrivacy({ privacy: 'none' as never, zdr: false })).toBe('zdr');
    expect(deciderPrivacy({ privacy: null as never, zdr: false })).toBe('zdr');
    expect(deciderPrivacy({ zdr: 'false' as never })).toBe('zdr');
    expect(deciderPrivacy({ zdr: null as never })).toBe('zdr');
  });
});
